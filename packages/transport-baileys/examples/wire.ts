// Wiring core and transport-baileys to a socket the host already owns. Fictional values only.
import http from "node:http";
import { CustodyStore, DeliveryLoop, InboundClient, createOutboundHandler } from "@openrig-whatsapp-relay/core";
import {
  authorizeSender, classifyReply, createBaileysTransport, parseOptionReply, redactText,
  type BaileysSocketLike, type MessageKeyLike,
} from "../src/index.js";

const OWNER_JID = "15550100@s.whatsapp.net"; // fictional
const OWNER_HANDLE = "acme-owner";

export function wire(sock: BaileysSocketLike, isOpen: () => boolean, tokens: { outbound: string; inbound: string }) {
  const custody = CustodyStore.open("/var/lib/acme-relay/custody.jsonl");
  const transport = createBaileysTransport({
    socket: sock,
    resolveChat: (h) => (h === OWNER_HANDLE ? OWNER_JID : null),
    isConnected: isOpen,
  });
  const loop = new DeliveryLoop({ custody, transport, onError: (e) => console.error(redactText(String(e), { max: 120 })) });
  const handler = createOutboundHandler({ custody, outboundToken: tokens.outbound, onAccepted: () => loop.wake() });
  http.createServer(handler).listen(8088, "127.0.0.1");
  loop.start();

  const inbound = new InboundClient({ custody, daemonUrl: "http://127.0.0.1:7433", inboundToken: tokens.inbound });

  /** Call from the host's `messages.upsert` handler with fields it extracted from the Baileys message. */
  return async function onMessage(m: { key: MessageKeyLike & { id: string }; text: string; quotedId?: string; isMedia?: boolean }) {
    const sender = authorizeSender(m.key, sock.user?.id, [OWNER_JID]);
    const route = classifyReply(
      { chat: m.key.remoteJid, chatAlt: m.key.remoteJidAlt, quotedId: m.quotedId, sender, senderAlt: m.key.participantAlt, isMedia: m.isMedia === true },
      { owners: [OWNER_JID] },
      (id) => custody.findByMessageId(id) !== undefined,
    );
    if (route.route !== "relay") return route; // refused or the host's own path
    const option = parseOptionReply(m.text, { locales: ["en", "pt"] });
    return inbound.reply({
      text: option === null ? m.text : String(option),
      quotedMessageId: m.quotedId!,
      senderHandle: OWNER_HANDLE,
      replyMessageId: m.key.id,
    });
  };
}
