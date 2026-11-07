import { sha256Hex } from "./canonical.js";
import type { CorrelationEntry, CustodyRecord, CustodyStore } from "./custody.js";
import { render } from "./render.js";
import type { RelayInboundBody, RelayInboundOrdering } from "./types.js";

const HANDLE = /^[A-Za-z0-9._-]+$/;
const MAX_TEXT = 32_768;
const INBOUND_PATH = "/api/gateway/relay/inbound";

/** A human reply as the transport saw it. */
export interface HumanReply {
  text: string;
  /** Transport message id of the relay message the human quoted. */
  quotedMessageId: string;
  /** Handle of the sender, as asserted by the trusted transport. */
  senderHandle: string;
  /** Transport id of the reply itself; makes the eventId stable across retries. */
  replyMessageId?: string;
  /** Default `after-question` (the reply quotes the question). */
  ordering?: RelayInboundOrdering;
}

export type ReplyResult =
  /** The daemon took the answer (possibly as a duplicate). Correlation marked answered. */
  | { kind: "accepted"; deduplicated: boolean; deliveryId: string; correlationId: string; eventId: string; mappedOption?: number }
  /** The question is over (stale, conflicting, unknown to the daemon, or already answered). Tell the human. */
  | { kind: "closed"; reason: string; deliveryId: string; correlationId: string }
  /** Try the same reply again later (503, 5xx, network). Same eventId, safe to repeat. */
  | { kind: "retry"; status: number; reason: string; retryAfterMs?: number; eventId: string }
  /** Refused without changing custody (bad input, 400/401/403/413, sender mismatch). */
  | { kind: "rejected"; reason: string; status?: number }
  /** The quoted message is not a relay message we sent: this is not an answer. Nothing posted. */
  | { kind: "unmatched" }
  /** A digest reply that did not name one item. Nothing posted. */
  | { kind: "ambiguous"; correlationIds: string[] };

export interface InboundClientOptions {
  custody: CustodyStore;
  /** Daemon base URL, loopback `http:` only (for example `http://127.0.0.1:7433`). */
  daemonUrl: string;
  /** Bearer token for the inbound route. Held in memory only, never logged or returned. */
  inboundToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function assertLoopbackHttp(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.hash) {
    throw new Error("daemonUrl must be a plain http loopback URL without credentials or fragment");
  }
  return url;
}

/** Short readable prefix plus a hash of the FULL id, so distinct ids never collapse together. */
function eventIdFor(replyMessageId: string): string {
  const readable = replyMessageId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 40);
  return `evt-${readable}-${sha256Hex(replyMessageId).slice(0, 32)}`;
}

/** 409 codes that mean the question itself is over. Anything else (event_conflict, unknown) is only reported. */
const STALE_QUESTION_CODES = new Set([
  "reply_not_allowed_for_update",
  "unrecognized_reply_ref",
  "decision_revision_changed",
  "qitem_already_terminal",
  "qitem_not_leg1_parked",
]);

export class InboundClient {
  private readonly url: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: InboundClientOptions) {
    if (!opts.inboundToken) throw new Error("inboundToken must be non-empty");
    this.url = new URL(INBOUND_PATH, assertLoopbackHttp(opts.daemonUrl)).toString();
    this.doFetch = opts.fetch ?? fetch;
  }

  /**
   * Resolve the reply to a custody record and post it to the daemon. Free text is only ever
   * posted verbatim as recorded context: the client never interprets "yes" or "ok" as approval,
   * and a message that does not quote a relay message is never posted at all.
   */
  async reply(input: HumanReply): Promise<ReplyResult> {
    const { custody } = this.opts;
    if (!HANDLE.test(input.senderHandle)) return { kind: "rejected", reason: "invalid_sender_handle" };
    if (input.text.trim() === "" || input.text.includes("\0") || input.text.length > MAX_TEXT) {
      return { kind: "rejected", reason: "invalid_text" };
    }
    const record = custody.findByMessageId(input.quotedMessageId);
    if (!record) return { kind: "unmatched" };
    // Fail closed: only the person the delivery was addressed to can answer it.
    if (record.envelope.recipient.handle !== input.senderHandle) {
      return { kind: "rejected", reason: "sender_mismatch" };
    }

    const picked = this.pick(record, input.text);
    if ("ambiguous" in picked) return { kind: "ambiguous", correlationIds: picked.ambiguous };
    if ("reject" in picked) return { kind: "rejected", reason: picked.reject };
    const { correlation, text } = picked;
    const base = { deliveryId: record.deliveryId, correlationId: correlation.id };

    if (correlation.status !== "open" || correlation.replyRef === null) {
      return {
        kind: "closed",
        ...base,
        reason: correlation.replyRef === null ? "informational" : (correlation.reason ?? `already_${correlation.status}`),
      };
    }

    let postedText = text;
    let mappedOption: number | undefined;
    if (correlation.itemIndex === null) {
      const options = render(record).options;
      const n = /^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : 0;
      if (n >= 1 && n <= options.length) {
        postedText = `${n}. ${options[n - 1]}`;
        mappedOption = n;
      }
    }

    const eventId = input.replyMessageId
      ? eventIdFor(input.replyMessageId)
      : `evt-${sha256Hex(`${record.deliveryId}\n${correlation.id}\n${input.senderHandle}\n${postedText}`).slice(0, 40)}`;
    const body: RelayInboundBody = {
      eventId,
      sender: { handle: input.senderHandle },
      replyRef: correlation.replyRef,
      text: postedText,
      ordering: input.ordering ?? "after-question",
    };

    let response: Response;
    try {
      response = await this.doFetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.inboundToken}` },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch {
      return { kind: "retry", status: 0, reason: "network_error", eventId };
    }
    const status = response.status;
    let payload: Record<string, unknown> = {};
    try {
      const json = (await response.json()) as unknown;
      if (typeof json === "object" && json !== null && !Array.isArray(json)) payload = json as Record<string, unknown>;
    } catch {
      // Non-JSON body: only the status matters.
    }
    const errorCode = typeof payload.error === "string" ? payload.error.slice(0, 80) : undefined;

    if (status === 200) {
      custody.resolveCorrelation(record.deliveryId, correlation.id, "answered", { eventId });
      return { kind: "accepted", ...base, eventId, deduplicated: payload.deduplicated === true, ...(mappedOption ? { mappedOption } : {}) };
    }
    if (status === 404 || (status === 409 && errorCode !== undefined && STALE_QUESTION_CODES.has(errorCode))) {
      const reason = status === 404 ? "not_found" : (errorCode as string);
      custody.resolveCorrelation(record.deliveryId, correlation.id, "closed", { eventId, reason });
      return { kind: "closed", ...base, reason };
    }
    if (status === 503 || status >= 500 || status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        kind: "retry",
        status,
        reason: errorCode ?? "unavailable",
        eventId,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    }
    return { kind: "rejected", status, reason: errorCode ?? `http_${status}` };
  }

  private pick(
    record: CustodyRecord,
    text: string,
  ): { correlation: CorrelationEntry; text: string } | { ambiguous: string[] } | { reject: string } {
    const itemEntries = record.correlations.filter((c) => c.itemIndex !== null);
    const delivery = record.correlations.find((c) => c.itemIndex === null) as CorrelationEntry;
    if (delivery.replyRef !== null) return { correlation: delivery, text };

    // Digest: the reply names an item by its [code], or there is exactly one answerable item.
    const answerable = itemEntries.filter((c) => c.replyRef !== null);
    const first = /^\s*\[?([0-9a-z]{6,24})\]?[:,.-]?(?:\s+|$)/i.exec(text);
    const named = first ? answerable.find((c) => c.id === (first[1] as string).toLowerCase()) : undefined;
    if (named && first) {
      const rest = text.slice(first[0].length);
      return rest.trim() === "" ? { reject: "empty_after_code" } : { correlation: named, text: rest };
    }
    const open = answerable.filter((c) => c.status === "open");
    if (answerable.length === 1) return { correlation: answerable[0] as CorrelationEntry, text };
    if (answerable.length === 0) return { correlation: delivery, text };
    return { ambiguous: open.map((c) => c.id) };
  }
}

export function createInboundClient(opts: InboundClientOptions): InboundClient {
  return new InboundClient(opts);
}
