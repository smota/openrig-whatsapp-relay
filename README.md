# openrig-whatsapp-relay

The bridge side of OpenRig's Gateway Relay, built to run a WhatsApp (or any other) messaging
platform behind it. This repository starts with `@openrig-whatsapp-relay/core`: a
transport-agnostic implementation of the relay contract with zero runtime dependencies.

Contract pinned: **Gateway Relay contract v1**, OpenRig upstream commit `f5b62726f`
(`docs/reference/gateway-relay.md`, behaviour of `recording-relay.ts`). The constants are
exported as `CONTRACT_VERSION` and `CONTRACT_PIN`.

## What core does

| Piece | Module | Contract behaviour |
|---|---|---|
| Outbound HTTP handler | `createOutboundHandler` | Node `http` compatible. Checks the outbound bearer (401, before reading the body), validates the envelope (400), deduplicates by `deliveryId` (200 `deduplicated: true`), answers 409 when the same `deliveryId` arrives with a different payload, 413 over the body limit, 503 when custody cannot be written. A 2xx is produced only after the custody line is fsync'd. |
| Custody and correlation store | `CustodyStore` | Append-only, fsync'd JSONL. fsync on open, short writes looped, directory fsync after create and rename (failure fails closed). Torn final line dropped on open, damage elsewhere fails closed, compaction by temp file, fsync, rename. Correlation ids live in the same file. |
| Renderer | `render` | Plain text: summary, body, numbered options for decisions, digests as lists, and a short `Ref: <id>` footer. |
| Delivery loop | `DeliveryLoop` | `pending` -> `sent` (with the transport message id) -> `answered` / `closed`. Bounded exponential backoff, `failed` after `maxAttempts`. At-most-once toward the transport. |
| Inbound client | `InboundClient` | Resolves a quoted reply to its custody record and POSTs `/api/gateway/relay/inbound` with the inbound bearer. 200 marks answered, 409/404 mark closed, 503/5xx/network are "retry later" with a stable `eventId`. |

The daemon replays only on its own or the bridge's restart, so the bridge never relies on
retries to be correct: custody before ACK, dedup on replay.

## Delivery semantics worth knowing

- A send attempt is written to custody before the transport is called. A record that was
  possibly sent but whose outcome was not recorded becomes `uncertain` after a restart and is
  never resent automatically; an operator calls `requeue` or `resolveUncertainAsSent`.
- A transport that throws is treated as "not sent". Return `retry` or `failed` explicitly when
  you can.
- Free text is never an approval. A reply is posted verbatim as recorded context, a message that
  does not quote a relay message is never posted, and only the delivery's recipient handle can
  answer it. A bare option number is mapped to the option label shown to the human.
- Contract v1 carries question options only inside `body`. The renderer numbers the first list
  of two or more `-`, `*`, `1.` or `1)` lines as options; anything else is left as text.
- A digest reply names an item by its `[code]`; without a code a digest with several answerable
  items returns `ambiguous` and nothing is posted.

## Plugging in a transport

Implement one method:

```ts
import { CustodyStore, DeliveryLoop, InboundClient, createOutboundHandler, type Transport } from "@openrig-whatsapp-relay/core";

const transport: Transport = {
  async send(rendered, recipient, ctx) {
    // rendered.text is final plain text. recipient.handle is the OpenRig alias; map it to a chat.
    const messageId = await myPlatform.sendText(chatFor(recipient.handle), rendered.text);
    return { status: "sent", messageId }; // or { status: "retry", reason } / { status: "failed", reason }
  },
};

const custody = CustodyStore.open("/var/lib/relay/custody.jsonl");
const loop = new DeliveryLoop({ custody, transport });
const handler = createOutboundHandler({ custody, outboundToken, onAccepted: () => loop.wake() });
http.createServer(handler).listen(8088, "127.0.0.1");
loop.start();

// When the human replies by quoting a relay message:
const inbound = new InboundClient({ custody, daemonUrl: "http://127.0.0.1:7433", inboundToken });
const result = await inbound.reply({
  text, quotedMessageId, senderHandle, replyMessageId, // ids from your platform
});
// result.kind: accepted | closed | retry | rejected | unmatched | ambiguous
```

Tokens and URLs come from the binding's secrets file (`OPENRIG_RELAY_URL`,
`OPENRIG_RELAY_OUTBOUND_TOKEN`, `OPENRIG_RELAY_INBOUND_TOKEN`); reading that file is the
embedding process's job. Use separate outbound and inbound tokens, bind the listener to loopback
only, and never log either token.

## `@openrig-whatsapp-relay/transport-baileys`

Runs the relay over a Baileys session **you own**. Baileys is a peer dependency (tested with
`@whiskeysockets/baileys` 6.7.24, range `>=6.7.16 <6.8.0`, optional because the package only uses a
structural `BaileysSocketLike`); core is a peer too.

In scope:

- `createBaileysTransport({ socket, resolveChat, isConnected })`: core's `Transport` over your socket. `sent` only with a returned message id; an error that is not clearly a pre-send connection failure is `failed` ("check the chat"), never retried.
- `DeliveryMachine` / `runDelivery`: one message's state machine (`pending`, `sending`, `retry_wait`, `sent`, `failed`, `unknown`) with bounded backoff, intent recorded before each attempt, outcome recorded after.
- `classifyReply`, `authorizeSender`, `normalizeIdentity`: quoted-reply routing for relay messages. Owner phone-JID and LID forms, wrong chat or sender refused, media refused, fail closed on a malformed owner list.
- `parseOptionReply`: digits, or number words (en, pt, es, opt-in per locale) only as the whole reply.
- `redactText`, `installLibsignalLogRedaction`: log hygiene for JIDs, phones, bearer tokens and Signal key dumps.
- `examples/wire.ts`: core plus this package on a socket.

Left to the host application: creating, pairing (QR), persisting and reconnecting the socket and its auth directory; group discovery; message parsing from `messages.upsert`; media, voice and audio; any outbox, approval or work-routing logic; mirroring state to your own systems; secrets handling; which chats and people exist.

## Development

```
npm install
npm test         # vitest
npm run check    # tsc --noEmit for sources and tests
npm run build
```

The tests run against a fake daemon (`packages/core/test/helpers/fake-daemon.ts`) written from the
contract document, plus crash simulations of custody (between write and fsync, torn writes,
compaction cut before and after the rename, between send and record). An optional parity test
runs the same request matrix against the upstream `recording-relay.ts`:

```
RELAY_FIXTURE_PATH=<openrig checkout>/packages/daemon/test/fixtures/recording-relay.ts npm test
```

Requires Node ^22 or ^24. Licensed under Apache-2.0.
