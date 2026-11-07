/**
 * The slice of a Baileys socket this package uses. A real `makeWASocket(...)` result satisfies it
 * structurally, so this package never imports Baileys at runtime. The host creates, pairs,
 * persists and reconnects the socket.
 */
export interface BaileysSocketLike {
  /** The paired account (`sock.user`), when known. */
  user?: { id?: string } | undefined;
  sendMessage(
    jid: string,
    content: { text: string },
    options?: Record<string, unknown>,
  ): Promise<{ key?: { id?: string | null } | null } | undefined | void>;
}
