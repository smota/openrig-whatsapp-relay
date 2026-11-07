import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CustodyCorruptError, CustodyFullError, type CustodyRecord, type CustodyStore } from "./custody.js";
import { validateOutboundEnvelope } from "./validate.js";

export interface OutboundHandlerOptions {
  custody: CustodyStore;
  /** Bearer token the daemon sends on outbound deliveries. Held in memory only. */
  outboundToken: string;
  /** Request path. Default `/outbound`. */
  path?: string;
  /** Upper bound on the request body. The contract has no cap; this guards memory. Default 8 MiB. */
  maxBodyBytes?: number;
  /** Called after a NEW envelope is durably in custody (never for duplicates). Errors are ignored. */
  onAccepted?: (record: CustodyRecord) => void;
}

export interface OutboundResult {
  status: number;
  body: Record<string, unknown>;
}

export interface OutboundStats {
  accepted: number;
  deduplicated: number;
  conflicts: number;
  unauthorized: number;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header || !expected) return false;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match?.[1]) return false;
  const provided = Buffer.from(match[1], "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (provided.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(provided, wanted);
}

export interface OutboundProcessor {
  /** Authenticate only (401 before the body is read). */
  authenticate(authorization: string | undefined): OutboundResult | null;
  /** Authenticate, validate, dedupe, write custody durably, then answer. */
  process(input: { authorization: string | undefined; rawBody: string }): OutboundResult;
  readonly stats: OutboundStats;
}

/**
 * Transport-agnostic core of the outbound endpoint. A 2xx result is only produced after the
 * custody line has been fsync'd.
 */
export function createOutboundProcessor(opts: OutboundHandlerOptions): OutboundProcessor {
  if (!opts.outboundToken) throw new Error("outboundToken must be non-empty");
  const stats: OutboundStats = { accepted: 0, deduplicated: 0, conflicts: 0, unauthorized: 0 };
  const unauthorized = (): OutboundResult => {
    stats.unauthorized += 1;
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  };

  return {
    stats,
    authenticate(authorization) {
      return bearerMatches(authorization, opts.outboundToken) ? null : unauthorized();
    },
    process({ authorization, rawBody }) {
      if (!bearerMatches(authorization, opts.outboundToken)) return unauthorized();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return { status: 400, body: { ok: false, error: "invalid_json" } };
      }
      const validation = validateOutboundEnvelope(parsed);
      if (!validation.ok) return { status: 400, body: { ok: false, error: validation.error } };
      const envelope = validation.envelope;

      let result;
      try {
        result = opts.custody.accept(envelope, rawBody);
      } catch (err) {
        if (err instanceof CustodyFullError) return { status: 503, body: { ok: false, error: "custody_full" } };
        const corrupt = err instanceof CustodyCorruptError;
        return { status: 503, body: { ok: false, error: corrupt ? "custody_store_corrupted" : "custody_write_failed" } };
      }
      if (result.kind === "duplicate") {
        stats.deduplicated += 1;
        return { status: 200, body: { ok: true, deliveryId: envelope.deliveryId, deduplicated: true } };
      }
      if (result.kind === "conflict") {
        stats.conflicts += 1;
        return {
          status: 409,
          body: { ok: false, error: "delivery_id_payload_conflict", deliveryId: envelope.deliveryId },
        };
      }
      stats.accepted += 1;
      try {
        opts.onAccepted?.(result.record);
      } catch {
        // Waking the delivery loop must never turn a durable acceptance into an error.
      }
      return { status: 200, body: { ok: true, deliveryId: envelope.deliveryId, deduplicated: false } };
    },
  };
}

export type OutboundHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
  readonly stats: OutboundStats;
};

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf8")),
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (v: { ok: true; text: string } | { ok: false; status: number; error: string }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      total += buf.length;
      if (total > limit) {
        settle({ ok: false, status: 413, error: "payload_too_large" });
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => settle({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => settle({ ok: false, status: 400, error: "stream_error" }));
  });
}

/** Node `http` compatible request handler for `POST <path>` (default `/outbound`). */
export function createOutboundHandler(opts: OutboundHandlerOptions): OutboundHandler {
  const processor = createOutboundProcessor(opts);
  const path = opts.path ?? "/outbound";
  const limit = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const handler = (async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const urlPath = (req.url ?? "/").split("?")[0];
    if (method !== "POST" || urlPath !== path) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    const denied = processor.authenticate(authorization);
    if (denied) {
      sendJson(res, denied.status, denied.body);
      return;
    }
    const body = await readBody(req, limit);
    if (!body.ok) {
      sendJson(res, body.status, { ok: false, error: body.error });
      return;
    }
    const result = processor.process({ authorization, rawBody: body.text });
    sendJson(res, result.status, result.body);
  }) as OutboundHandler;
  Object.defineProperty(handler, "stats", { get: () => processor.stats });
  return handler;
}
