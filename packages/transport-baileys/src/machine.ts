import type { SendOutcome } from "@openrig-whatsapp-relay/core";

/**
 * pending -> sending -> sent | failed | unknown | retry_wait (-> sending ...).
 * `unknown` means the attempt threw: the message may be on the phone, so it is never resent
 * automatically. `failed` and `sent` are terminal.
 */
export type DeliveryState = "pending" | "sending" | "retry_wait" | "sent" | "failed" | "unknown";

export interface DeliverySnapshot {
  deliveryId: string;
  state: DeliveryState;
  attempts: number;
  messageId?: string;
  lastError?: string;
  retryAfterMs?: number;
}

export interface BackoffConfig {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
}

export interface DeliveryMachineOptions {
  /** Outcome recording. Called before each attempt (state `sending`) and after each outcome. A throw before an attempt aborts it. */
  record?: (snapshot: DeliverySnapshot) => void | Promise<void>;
  /** Attempts, including the first, before `failed`. Default 5. */
  maxAttempts?: number;
  backoff?: BackoffConfig;
}

export type Sender = () => Promise<SendOutcome>;

/** One message's delivery: attempts, retries and recorded outcomes. Holds no I/O of its own. */
export class DeliveryMachine {
  private snap: DeliverySnapshot;
  private readonly maxAttempts: number;
  private readonly record: (s: DeliverySnapshot) => void | Promise<void>;
  readonly backoff: Required<BackoffConfig>;

  constructor(deliveryId: string, opts: DeliveryMachineOptions = {}) {
    this.snap = { deliveryId, state: "pending", attempts: 0 };
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.record = opts.record ?? (() => undefined);
    this.backoff = { baseMs: opts.backoff?.baseMs ?? 1000, maxMs: opts.backoff?.maxMs ?? 60_000, factor: opts.backoff?.factor ?? 2 };
  }

  get snapshot(): DeliverySnapshot {
    return { ...this.snap };
  }

  get settled(): boolean {
    return this.snap.state === "sent" || this.snap.state === "failed" || this.snap.state === "unknown";
  }

  /** Delay before the next attempt after `attempts` attempts. Bounded by maxMs. */
  delayFor(attempts: number): number {
    return Math.min(this.backoff.maxMs, this.backoff.baseMs * this.backoff.factor ** Math.max(0, attempts - 1));
  }

  async attempt(sender: Sender): Promise<DeliverySnapshot> {
    if (this.snap.state === "unknown") throw new Error(`delivery ${this.snap.deliveryId} is unknown: resolve it before another attempt`);
    if (this.snap.state === "sent" || this.snap.state === "failed") throw new Error(`delivery ${this.snap.deliveryId} is terminal (${this.snap.state})`);
    if (this.snap.state === "sending") throw new Error(`delivery ${this.snap.deliveryId} already has an attempt in flight`);
    const previous = this.snap;
    const next: DeliverySnapshot = { deliveryId: previous.deliveryId, state: "sending", attempts: previous.attempts + 1 };
    if (previous.lastError !== undefined) next.lastError = previous.lastError;
    // Reserve synchronously (before any await) so a concurrent attempt is refused.
    this.snap = next;
    // Write intent before sending; if that fails nothing was sent, so release the reservation.
    try {
      await this.record({ ...next });
    } catch (error) {
      this.snap = previous;
      throw error;
    }
    let outcome: SendOutcome;
    try {
      outcome = await sender();
    } catch (error) {
      return this.settle({ state: "unknown", lastError: `send threw: ${String((error as Error)?.message ?? error).slice(0, 200)}` });
    }
    switch (outcome.status) {
      case "sent":
        return this.settle({ state: "sent", messageId: outcome.messageId });
      case "failed":
        return this.settle({ state: "failed", lastError: outcome.reason });
      default:
        if (this.snap.attempts >= this.maxAttempts) return this.settle({ state: "failed", lastError: outcome.reason });
        return this.settle({ state: "retry_wait", lastError: outcome.reason, ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}) });
    }
  }

  /** An operator's decision about an `unknown` delivery. */
  async resolveUnknown(decision: { sent: true; messageId: string } | { sent: false }): Promise<DeliverySnapshot> {
    if (this.snap.state !== "unknown") throw new Error("only an unknown delivery can be resolved");
    return decision.sent ? this.settle({ state: "sent", messageId: decision.messageId }) : this.settle({ state: "retry_wait" });
  }

  private async settle(patch: Partial<DeliverySnapshot> & { state: DeliveryState }): Promise<DeliverySnapshot> {
    const { retryAfterMs: _drop, ...rest } = this.snap;
    this.snap = { ...rest, ...patch };
    await this.record({ ...this.snap });
    return { ...this.snap };
  }
}

export interface RunDeliveryOptions {
  sleep?: (ms: number) => Promise<void>;
}

/** Drive a machine until it settles, sleeping the backoff (or `retryAfterMs`) between attempts. */
export async function runDelivery(machine: DeliveryMachine, sender: Sender, opts: RunDeliveryOptions = {}): Promise<DeliverySnapshot> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const s = await machine.attempt(sender);
    if (s.state !== "retry_wait") return s;
    await sleep(s.retryAfterMs ?? machine.delayFor(s.attempts));
  }
}
