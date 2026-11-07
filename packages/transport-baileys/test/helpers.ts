import type { BaileysSocketLike } from "../src/index.js";

export interface SentCall {
  jid: string;
  content: { text: string };
}

/** A fake socket: records sends, can be told to fail, never touches a network. */
export function fakeSocket(opts: { connected?: boolean } = {}) {
  const sent: SentCall[] = [];
  const state = {
    connected: opts.connected ?? true,
    failWith: undefined as unknown,
    returnNoKey: false,
    seq: 0,
  };
  const socket: BaileysSocketLike = {
    user: { id: "100:7@s.whatsapp.net" },
    async sendMessage(jid, content) {
      if (state.failWith !== undefined) throw state.failWith;
      sent.push({ jid, content });
      if (state.returnNoKey) return undefined;
      state.seq += 1;
      return { key: { id: `MSG${state.seq}`, remoteJid: jid, fromMe: true } };
    },
  };
  return { socket, sent, state };
}
