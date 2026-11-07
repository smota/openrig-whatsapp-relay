import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { RelayOutboundEnvelope, SendOutcome, Transport, RenderedMessage, Recipient } from "../../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tmpCustodyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-core-"));
  dirs.push(dir);
  return join(dir, "state", "custody.jsonl");
}

export const OUT = "out-token-test";
export const IN = "in-token-test";

export function decision(id: string, extra: Partial<RelayOutboundEnvelope> = {}): RelayOutboundEnvelope {
  return {
    v: 1,
    deliveryId: id,
    recipient: { handle: "acme-owner" },
    intent: "decision",
    outcome: "interrupt",
    summary: "Approve the acme rollout",
    body: "The rollout is ready.\n- Ship now\n- Wait one day\n- Cancel",
    replyRef: `ref-${id}`,
    ...extra,
  };
}

export function update(id: string): RelayOutboundEnvelope {
  return { ...decision(id), intent: "update", outcome: "notify", body: "FYI: the job finished.", replyRef: null };
}

export function digest(id: string): RelayOutboundEnvelope {
  return {
    ...decision(id),
    outcome: "digest",
    summary: "Two items",
    body: "",
    replyRef: null,
    items: [
      { qitemId: "q1", notificationKey: "k1", summary: "Pick a color", body: "red or blue", replyRef: `ref-${id}-1` },
      { qitemId: "q2", notificationKey: "k2", summary: "FYI only", replyRef: null },
      { qitemId: "q3", notificationKey: "k3", summary: "Pick a size", replyRef: `ref-${id}-3` },
    ],
  };
}

export async function postJson(url: string, token: string | null, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A transport that records what it was asked to send and answers from a script. */
export class ScriptedTransport implements Transport {
  sends: Array<{ rendered: RenderedMessage; recipient: Recipient; attempt: number }> = [];
  script: SendOutcome[] = [];
  private n = 0;
  async send(rendered: RenderedMessage, recipient: Recipient, ctx?: { attempt: number }): Promise<SendOutcome> {
    this.sends.push({ rendered, recipient, attempt: ctx?.attempt ?? 0 });
    return this.script.shift() ?? { status: "sent", messageId: `m-${++this.n}` };
  }
}
