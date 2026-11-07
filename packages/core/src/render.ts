import type { CustodyRecord } from "./custody.js";
import type { RenderedMessage } from "./transport.js";

const OPTION_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(\S.*)$/;

/**
 * Number the first run of two or more list-like lines (`- x`, `* x`, `1. x`, `1) x`) as options.
 * Contract v1 carries rendered question options only inside `body`, so this is a text heuristic;
 * anything it does not recognise is left untouched.
 */
export function extractOptions(body: string): { text: string; options: string[] } {
  const lines = body.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length && end < 0; i++) {
    if (OPTION_LINE.test(lines[i] as string)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 2) end = i;
      else start = -1;
    }
  }
  if (start >= 0 && end < 0 && lines.length - start >= 2) end = lines.length;
  if (start < 0 || end < 0) return { text: body, options: [] };
  const options = lines.slice(start, end).map((l) => (OPTION_LINE.exec(l) as RegExpExecArray)[1] as string);
  const numbered = options.map((o, i) => `${i + 1}. ${o}`);
  return { text: [...lines.slice(0, start), ...numbered, ...lines.slice(end)].join("\n"), options };
}

/** Turn a custody record into plain text with a short `Ref` footer. */
export function render(record: Pick<CustodyRecord, "envelope" | "correlations">): RenderedMessage {
  const { envelope, correlations } = record;
  const deliveryCorr = correlations.find((c) => c.itemIndex === null);
  if (!deliveryCorr) throw new Error("record has no delivery-level correlation");
  const parts: string[] = [];
  let options: string[] = [];
  const itemCorrelationIds: string[] = [];

  const summary = envelope.summary.trim();
  const body = envelope.body;
  // Summary overflow beyond 1,000 characters already sits at the start of `body`.
  if (summary && !body.startsWith(envelope.summary)) parts.push(summary);

  if (envelope.outcome === "digest" && envelope.items) {
    if (body.trim()) parts.push(body.trim());
    const list = envelope.items.map((item, i) => {
      const corr = correlations.find((c) => c.itemIndex === i);
      const tag = corr && item.replyRef !== null ? ` [${corr.id}]` : "";
      if (corr && item.replyRef !== null) itemCorrelationIds.push(corr.id);
      const detail = item.body?.trim() ? `\n   ${item.body.trim().split("\n").join("\n   ")}` : "";
      return `${i + 1}.${tag} ${item.summary.trim()}${detail}`;
    });
    parts.push(list.join("\n"));
    if (itemCorrelationIds.length > 0) {
      parts.push("To answer one item, quote this message and start your reply with its [code].");
    }
  } else {
    if (envelope.intent === "decision") {
      const extracted = extractOptions(body);
      options = extracted.options;
      if (extracted.text.trim()) parts.push(extracted.text.trim());
      parts.push(
        options.length > 0
          ? "Quote this message and reply with an option number or your own text."
          : "Quote this message to reply.",
      );
    } else if (body.trim()) {
      parts.push(body.trim());
    }
  }

  parts.push(`Ref: ${deliveryCorr.id}`);
  return { text: parts.join("\n\n"), correlationId: deliveryCorr.id, itemCorrelationIds, options };
}
