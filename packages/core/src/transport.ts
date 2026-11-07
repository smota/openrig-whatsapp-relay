/** What the renderer produces and a transport sends. */
export interface RenderedMessage {
  /** Plain text, ends with the `Ref` footer. */
  text: string;
  /** Delivery-level correlation id (the one in the `Ref` footer). */
  correlationId: string;
  /** Per-item correlation ids of a digest, in item order (only items that can be answered). */
  itemCorrelationIds: string[];
  /** Numbered options detected in a decision body, in display order (option 1 first). */
  options: string[];
}

export interface Recipient {
  handle: string;
}

export interface SendContext {
  deliveryId: string;
  /** 1-based attempt number. */
  attempt: number;
}

/**
 * Outcome of one send attempt.
 * - `sent`: the platform accepted the message; `messageId` is what a quoted reply will cite.
 * - `retry`: definitely not sent, try again later (optionally not before `retryAfterMs`).
 * - `failed`: definitely not sent and never will be (bad recipient, blocked, ...).
 * A thrown error is treated as `retry`, so a transport must throw only when nothing was sent.
 */
export type SendOutcome =
  | { status: "sent"; messageId: string }
  | { status: "retry"; reason: string; retryAfterMs?: number }
  | { status: "failed"; reason: string };

/** The one thing a messaging platform has to implement. */
export interface Transport {
  send(rendered: RenderedMessage, recipient: Recipient, ctx?: SendContext): Promise<SendOutcome>;
}
