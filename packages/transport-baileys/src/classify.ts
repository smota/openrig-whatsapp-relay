/** A Baileys-authenticated identity (`<digits>@s.whatsapp.net` or `<id>@lid`) without device suffix, or null. */
export function normalizeIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().toLowerCase().match(/^([a-z0-9]+)(?::\d+)?@(s\.whatsapp\.net|lid)$/);
  return m ? `${m[1]}@${m[2]}` : null;
}

export interface SenderAuthorization {
  authorized: boolean;
  senderId: string | null;
}

export interface MessageKeyLike {
  fromMe?: boolean | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
}

/**
 * Who sent a message, by authenticated identity only (never a display name or group membership).
 * No `owners` means only the paired account itself. A supplied but malformed list fails closed.
 * In a direct chat the sender is the chat identity; in a group it is the participant.
 */
export function authorizeSender(key: MessageKeyLike, pairedUser: string | undefined, owners?: string[]): SenderAuthorization {
  const paired = normalizeIdentity(pairedUser);
  const list = owners ? owners.map(normalizeIdentity).filter((x): x is string => Boolean(x)) : null;
  const allowed = new Set(list ?? (paired ? [paired] : []));
  const direct = !key.remoteJid?.endsWith("@g.us");
  const candidates = key.fromMe === true
    ? [paired]
    : [key.participant, key.participantAlt, ...(direct ? [key.remoteJid, key.remoteJidAlt] : [])].map(normalizeIdentity);
  const senderId = candidates.find((id): id is string => Boolean(id) && allowed.has(id as string)) ?? null;
  return { authorized: senderId !== null, senderId };
}

export interface ReplyMessage {
  /** Chat JID, and the other form (phone or LID) of it when the message carries one. */
  chat?: string | null;
  chatAlt?: string | null;
  /** Transport id of the quoted message, if any. */
  quotedId?: string | null;
  sender: SenderAuthorization;
  /** The other form of the sender's identity. */
  senderAlt?: string | null;
  isMedia?: boolean;
}

export type ReplyRoute =
  | { route: "default" }
  | { route: "relay" }
  | { route: "refused"; reason: "relay_wrong_chat" | "relay_unauthorized" | "relay_unsupported_media" };

/**
 * Decide where an inbound message goes. A message that quotes a relay message never reaches the
 * host's default path: it is a relay reply from an owner in the owner's chat, or it is refused.
 * Everything else is `default`. `config` is null when the relay is off.
 */
export function classifyReply(
  msg: ReplyMessage,
  config: { owners: string[] } | null | undefined,
  isRelayMessage: (id: string) => boolean,
): ReplyRoute {
  if (!config || !msg.quotedId || !isRelayMessage(msg.quotedId)) return { route: "default" };
  const owners = new Set(config.owners.map(normalizeIdentity).filter((x): x is string => Boolean(x)));
  const isOwner = (...ids: Array<string | null | undefined>) => ids.some((id) => {
    const n = normalizeIdentity(id);
    return n !== null && owners.has(n);
  });
  if (owners.size === 0 || !isOwner(msg.chat, msg.chatAlt)) return { route: "refused", reason: "relay_wrong_chat" };
  if (!msg.sender.authorized || !isOwner(msg.sender.senderId, msg.senderAlt)) return { route: "refused", reason: "relay_unauthorized" };
  if (msg.isMedia) return { route: "refused", reason: "relay_unsupported_media" };
  return { route: "relay" };
}
