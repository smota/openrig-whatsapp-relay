/** Contract version this package implements. */
export const CONTRACT_VERSION = 1;
/** OpenRig upstream commit whose gateway-relay contract and fixture this package is pinned to. */
export const CONTRACT_PIN = "f5b62726f";

export type RelayIntent = "decision" | "update";
export type RelayOutcome = "interrupt" | "notify" | "digest";
export type RelayInboundOrdering = "after-question" | "uncertain";

export interface RelayDigestItem {
  qitemId: string;
  notificationKey: string;
  summary: string;
  body?: string;
  replyRef: string | null;
}

export interface RelayOutboundEnvelope {
  v: 1;
  deliveryId: string;
  recipient: { handle: string };
  intent: RelayIntent;
  outcome: RelayOutcome;
  summary: string;
  body: string;
  replyRef: string | null;
  items?: RelayDigestItem[];
}

export interface RelayInboundBody {
  eventId: string;
  sender: { handle: string };
  replyRef: string;
  text: string;
  ordering: RelayInboundOrdering;
}
