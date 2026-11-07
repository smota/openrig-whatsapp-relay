/**
 * A fake OpenRig daemon, written from docs/reference/gateway-relay.md (contract v1) and the
 * semantics of the upstream recording-relay fixture. It has two halves:
 * - a dispatch buffer that freezes envelopes, POSTs them to a bridge and drains on 2xx only;
 * - the loopback inbound route with its documented status codes.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import type { RelayOutboundEnvelope } from "../../src/index.js";

export type QuestionState = "open" | "answered" | "cancelled" | "informational";

export interface AcceptedAnswer {
  eventId: string;
  replyRef: string;
  text: string;
  handle: string;
  ordering: string;
}

export interface FakeDaemon {
  readonly baseUrl: string;
  readonly answers: AcceptedAnswer[];
  /** Number of inbound requests that reached the route (any status). */
  inboundRequests: number;
  /** When set, the inbound route answers 503 with this error code. */
  unavailable: string | null;
  /** When set, the inbound route answers 409 with this error code. */
  forceConflict: string | null;
  registerQuestion(replyRef: string, state?: QuestionState): void;
  setQuestionState(replyRef: string, state: QuestionState): void;
  stop(): Promise<void>;
  /** Dispatch buffer: freeze the exact bytes, POST, drain on 2xx. Returns the HTTP status or 0. */
  dispatch(bridgeUrl: string, bearer: string, envelope: RelayOutboundEnvelope): Promise<number>;
  /** Replay everything still buffered (what the daemon does on its own or the bridge's restart). */
  replayPending(bridgeUrl: string, bearer: string): Promise<number[]>;
  pendingCount(): number;
}

const HANDLE = /^[A-Za-z0-9._-]+$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function readRaw(req: IncomingMessage, limit: number): Promise<{ text: string } | { tooLarge: true }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? { tooLarge: true } : { text: Buffer.concat(chunks).toString("utf8") }));
  });
}

export async function startFakeDaemon(opts: { inboundToken: string; handles: string[] }): Promise<FakeDaemon> {
  const questions = new Map<string, QuestionState>();
  const seen = new Map<string, string>();
  const answers: AcceptedAnswer[] = [];
  const buffer = new Map<string, string>();
  const self: FakeDaemon = {
    baseUrl: "",
    answers,
    inboundRequests: 0,
    unavailable: null,
    forceConflict: null,
    registerQuestion(ref, state = "open") {
      questions.set(ref, state);
    },
    setQuestionState(ref, state) {
      questions.set(ref, state);
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async dispatch(bridgeUrl, bearer, envelope) {
      const raw = JSON.stringify(envelope);
      if (!buffer.has(envelope.deliveryId)) buffer.set(envelope.deliveryId, raw);
      return post(bridgeUrl, bearer, envelope.deliveryId);
    },
    async replayPending(bridgeUrl, bearer) {
      const out: number[] = [];
      for (const id of [...buffer.keys()]) out.push(await post(bridgeUrl, bearer, id));
      return out;
    },
    pendingCount: () => buffer.size,
  };

  async function post(bridgeUrl: string, bearer: string, deliveryId: string): Promise<number> {
    try {
      const res = await fetch(bridgeUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: buffer.get(deliveryId) as string,
        redirect: "error",
      });
      await res.text();
      if (res.status >= 200 && res.status < 300) buffer.delete(deliveryId);
      return res.status;
    } catch {
      return 0;
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/api/gateway/relay/inbound") return send(404, { ok: false });
      self.inboundRequests += 1;
      const peer = req.socket.remoteAddress ?? "";
      if (!(peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127."))) {
        return send(403, { ok: false, error: "non_loopback_peer" });
      }
      const auth = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
      if (!auth || auth[1] !== opts.inboundToken) return send(401, { ok: false, error: "unauthorized" });
      const raw = await readRaw(req, 65_536);
      if ("tooLarge" in raw) return send(413, { ok: false, error: "payload_too_large" });
      if (self.forceConflict) return send(409, { ok: false, error: self.forceConflict });
      if (self.unavailable) return send(503, { ok: false, error: self.unavailable });
      let json: unknown;
      try {
        json = JSON.parse(raw.text);
      } catch {
        return send(400, { ok: false, error: "invalid_json" });
      }
      const b = json as Record<string, unknown>;
      const sender = b?.sender as Record<string, unknown> | undefined;
      if (
        typeof json !== "object" || json === null || Array.isArray(json) ||
        typeof b.eventId !== "string" || !EVENT_ID.test(b.eventId) ||
        typeof sender?.handle !== "string" || !HANDLE.test(sender.handle) ||
        typeof b.replyRef !== "string" || b.replyRef.length === 0 || b.replyRef.length > 4096 ||
        typeof b.text !== "string" || b.text.trim() === "" || b.text.length > 32_768 || b.text.includes("\0") ||
        (b.ordering !== undefined && b.ordering !== "after-question" && b.ordering !== "uncertain")
      ) {
        return send(400, { ok: false, error: "invalid_field" });
      }
      if (!opts.handles.includes(sender.handle)) return send(403, { ok: false, error: "unregistered_handle" });
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([b.replyRef, b.text, sender.handle, b.ordering ?? "uncertain"]))
        .digest("hex");
      const prior = seen.get(b.eventId);
      if (prior !== undefined) {
        return prior === fingerprint
          ? send(200, { ok: true, deduplicated: true })
          : send(409, { ok: false, error: "event_conflict" });
      }
      const state = questions.get(b.replyRef);
      if (state !== "open") return send(409, { ok: false, error: state ? (state === "informational" ? "reply_not_allowed_for_update" : "decision_revision_changed") : "unrecognized_reply_ref" });
      seen.set(b.eventId, fingerprint);
      questions.set(b.replyRef, "answered");
      answers.push({
        eventId: b.eventId,
        replyRef: b.replyRef,
        text: b.text,
        handle: sender.handle,
        ordering: String(b.ordering ?? "uncertain"),
      });
      send(200, { ok: true, deduplicated: false, reconciled: false });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  Object.defineProperty(self, "baseUrl", { value: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  return self;
}
