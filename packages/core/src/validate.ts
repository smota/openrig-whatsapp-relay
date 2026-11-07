import type { RelayDigestItem, RelayOutboundEnvelope } from "./types.js";

const MAX_REPLY_REF = 4096;

const ENVELOPE_KEYS = new Set([
  "v",
  "deliveryId",
  "recipient",
  "intent",
  "outcome",
  "summary",
  "body",
  "replyRef",
  "items",
]);
const ITEM_KEYS = new Set(["qitemId", "notificationKey", "summary", "body", "replyRef"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type EnvelopeValidation =
  | { ok: true; envelope: RelayOutboundEnvelope }
  | { ok: false; error: string };

/** Strict validation of the outbound envelope (contract v1); unknown fields are rejected. */
export function validateOutboundEnvelope(parsed: unknown): EnvelopeValidation {
  if (!isPlainObject(parsed)) return { ok: false, error: "Envelope must be a JSON object" };
  for (const k of Object.keys(parsed)) {
    if (!ENVELOPE_KEYS.has(k)) return { ok: false, error: `Unknown envelope field: ${k}` };
  }
  if (parsed.v !== 1) return { ok: false, error: "Expected protocol version v: 1" };
  if (typeof parsed.deliveryId !== "string" || !parsed.deliveryId.trim()) {
    return { ok: false, error: "Missing or empty deliveryId" };
  }
  if (
    !isPlainObject(parsed.recipient) ||
    typeof parsed.recipient.handle !== "string" ||
    !parsed.recipient.handle.trim() ||
    Object.keys(parsed.recipient).some((k) => k !== "handle")
  ) {
    return { ok: false, error: "Invalid recipient.handle" };
  }
  if (parsed.intent !== "decision" && parsed.intent !== "update") {
    return { ok: false, error: "Invalid intent (expected decision | update)" };
  }
  if (parsed.outcome !== "interrupt" && parsed.outcome !== "notify" && parsed.outcome !== "digest") {
    return { ok: false, error: "Invalid outcome (expected interrupt | notify | digest)" };
  }
  if (typeof parsed.summary !== "string" || typeof parsed.body !== "string") {
    return { ok: false, error: "Missing summary or body string" };
  }
  if (parsed.replyRef !== null && (typeof parsed.replyRef !== "string" || !parsed.replyRef.trim())) {
    return { ok: false, error: "Invalid replyRef (expected string | null)" };
  }
  if (typeof parsed.replyRef === "string" && parsed.replyRef.length > MAX_REPLY_REF) {
    return { ok: false, error: "replyRef exceeds 4096 characters" };
  }

  let items: RelayDigestItem[] | undefined;
  if (parsed.items !== undefined) {
    if (!Array.isArray(parsed.items)) return { ok: false, error: "Invalid items array" };
    items = [];
    for (const item of parsed.items) {
      if (!isPlainObject(item)) return { ok: false, error: "Digest item must be an object" };
      for (const k of Object.keys(item)) {
        if (!ITEM_KEYS.has(k)) return { ok: false, error: `Unknown digest item field: ${k}` };
      }
      if (
        typeof item.qitemId !== "string" ||
        typeof item.notificationKey !== "string" ||
        typeof item.summary !== "string" ||
        (item.body !== undefined && typeof item.body !== "string") ||
        (item.replyRef !== null && typeof item.replyRef !== "string") ||
        (typeof item.replyRef === "string" && (!item.replyRef.trim() || item.replyRef.length > MAX_REPLY_REF))
      ) {
        return { ok: false, error: "Malformed digest item fields" };
      }
      items.push({
        qitemId: item.qitemId,
        notificationKey: item.notificationKey,
        summary: item.summary,
        ...(item.body !== undefined ? { body: item.body } : {}),
        replyRef: item.replyRef,
      });
    }
  }

  return {
    ok: true,
    envelope: {
      v: 1,
      deliveryId: parsed.deliveryId,
      recipient: { handle: parsed.recipient.handle },
      intent: parsed.intent,
      outcome: parsed.outcome,
      summary: parsed.summary,
      body: parsed.body,
      replyRef: parsed.replyRef,
      ...(items !== undefined ? { items } : {}),
    },
  };
}
