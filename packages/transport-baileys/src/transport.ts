import type { Transport } from "@openrig-whatsapp-relay/core";
import type { BaileysSocketLike } from "./socket.js";

export interface BaileysTransportOptions {
  /** A socket the host owns. This package never creates, pairs or closes it. */
  socket: BaileysSocketLike;
  /** Map an OpenRig recipient handle to a chat JID, or null to refuse the recipient. */
  resolveChat: (handle: string) => string | null | undefined;
  /** Whether the host's connection is open. Default: always. A closed connection is a retry. */
  isConnected?: () => boolean;
  /** Longest text accepted. Default 60000. */
  maxTextLength?: number;
}

/**
 * Core's `Transport` over a caller-supplied Baileys socket. `sent` is reported only when Baileys
 * returns a message id. Any error once `sendMessage` was called (connection loss, timeout, stream error) is reported
 * as `failed` with a "check the chat" reason, never `retry`; `retry` is only returned when the socket was not used (not connected). A message that may have reached
 * the phone is not typed twice.
 */
export function createBaileysTransport(opts: BaileysTransportOptions): Transport {
  const max = opts.maxTextLength ?? 60_000;
  return {
    async send(rendered, recipient) {
      const chat = opts.resolveChat(recipient.handle);
      if (!chat) return { status: "failed", reason: "recipient is not mapped to a chat" };
      if (rendered.text.length > max) return { status: "failed", reason: "rendered message exceeds the text limit" };
      if (opts.isConnected && !opts.isConnected()) return { status: "retry", reason: "disconnected" };
      try {
        const result = await opts.socket.sendMessage(chat, { text: rendered.text });
        const id = result?.key?.id;
        if (!id) return { status: "failed", reason: "the socket returned no message id; check the chat before requeueing" };
        return { status: "sent", messageId: id };
      } catch {
        return { status: "failed", reason: "send outcome unknown; check the chat before requeueing" };
      }
    },
  };
}
