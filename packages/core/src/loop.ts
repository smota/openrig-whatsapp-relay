import type { CustodyRecord, CustodyStore } from "./custody.js";
import { render } from "./render.js";
import type { Transport } from "./transport.js";

export interface BackoffOptions {
  /** First retry delay. Default 1000 ms. */
  baseMs?: number;
  /** Ceiling for any single delay. Default 60000 ms. */
  maxMs?: number;
  /** Growth factor. Default 2. */
  factor?: number;
  /** Attempts (including the first) before a record is marked failed. Default 8. */
  maxAttempts?: number;
}

export interface DeliveryLoopOptions {
  custody: CustodyStore;
  transport: Transport;
  backoff?: BackoffOptions;
  /** Timer poll interval for start(). Default 2000 ms. */
  pollMs?: number;
  now?: () => number;
  onError?: (err: unknown, deliveryId?: string) => void;
}

export interface TickReport {
  sent: string[];
  retried: string[];
  failed: string[];
}

/**
 * Moves custody records pending -> sent. At-most-once on the transport: a send attempt is
 * recorded durably before the transport is called, so a record that was possibly sent is never
 * sent again automatically (it becomes `uncertain` after a restart and waits for an operator).
 */
export class DeliveryLoop {
  private readonly nextAt = new Map<string, number>();
  /** Sent, but recording it failed. Never resent; recording is retried first on every tick. */
  private readonly unrecorded = new Map<string, string>();
  private ticking = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly factor: number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: DeliveryLoopOptions) {
    this.now = opts.now ?? Date.now;
    this.baseMs = opts.backoff?.baseMs ?? 1000;
    this.maxMs = opts.backoff?.maxMs ?? 60_000;
    this.factor = opts.backoff?.factor ?? 2;
    this.maxAttempts = opts.backoff?.maxAttempts ?? 8;
  }

  /** Delay before the next attempt after `attempts` failed attempts. Bounded by maxMs. */
  backoffDelay(attempts: number): number {
    return Math.min(this.maxMs, this.baseMs * this.factor ** Math.max(0, attempts - 1));
  }

  start(): void {
    if (this.timer) return;
    const run = (): void => {
      void this.tick().catch((err) => this.opts.onError?.(err));
    };
    this.timer = setInterval(run, this.opts.pollMs ?? 2000);
    this.timer.unref();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Nudge: process due records now (for example right after custody accepted a new one). */
  wake(): void {
    if (!this.timer) return;
    void this.tick().catch((err) => this.opts.onError?.(err));
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { sent: [], retried: [], failed: [] };
    if (this.ticking) return report;
    this.ticking = true;
    try {
      this.flushUnrecorded();
      for (const rec of this.opts.custody.pending()) {
        if (this.unrecorded.has(rec.deliveryId)) continue;
        if ((this.nextAt.get(rec.deliveryId) ?? 0) > this.now()) continue;
        await this.attempt(rec, report);
      }
    } finally {
      this.ticking = false;
    }
    return report;
  }

  private flushUnrecorded(): void {
    for (const [deliveryId, messageId] of this.unrecorded) {
      try {
        this.opts.custody.markSent(deliveryId, messageId);
        this.unrecorded.delete(deliveryId);
      } catch (err) {
        this.opts.onError?.(err, deliveryId);
      }
    }
  }

  private async attempt(rec: CustodyRecord, report: TickReport): Promise<void> {
    const { custody, transport } = this.opts;
    // Durable intent first. If this throws nothing was sent and the record stays pending.
    custody.markSending(rec.deliveryId);
    const attempt = rec.attempts;
    let outcome;
    try {
      outcome = await transport.send(render(rec), rec.envelope.recipient, { deliveryId: rec.deliveryId, attempt });
    } catch (err) {
      outcome = { status: "retry" as const, reason: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.status === "sent") {
      try {
        custody.markSent(rec.deliveryId, outcome.messageId);
      } catch (err) {
        this.unrecorded.set(rec.deliveryId, outcome.messageId);
        this.opts.onError?.(err, rec.deliveryId);
      }
      this.nextAt.delete(rec.deliveryId);
      report.sent.push(rec.deliveryId);
      return;
    }
    if (outcome.status === "failed" || attempt >= this.maxAttempts) {
      const reason = outcome.status === "failed" ? outcome.reason : `${outcome.reason} (attempts exhausted)`;
      custody.markFailed(rec.deliveryId, reason);
      this.nextAt.delete(rec.deliveryId);
      report.failed.push(rec.deliveryId);
      return;
    }
    custody.markRetry(rec.deliveryId, outcome.reason);
    const delay = Math.min(this.maxMs, Math.max(this.backoffDelay(attempt), outcome.retryAfterMs ?? 0));
    this.nextAt.set(rec.deliveryId, this.now() + delay);
    report.retried.push(rec.deliveryId);
  }
}
