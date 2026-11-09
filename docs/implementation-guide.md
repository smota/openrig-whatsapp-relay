# Implementation guide

Embed the existing core APIs in a bridge process you own. Keep OpenRig and the bridge on loopback.
Use the [minimal example](../examples/minimal/README.md) before connecting a real platform.

## Choose the transport

| Need | Start here |
|---|---|
| Offline reference | [Minimal example](../examples/minimal/README.md) |
| Custom platform | Core's [`Transport`](../packages/core/src/transport.ts) interface |
| Existing Baileys socket | [`examples/wire.ts`](../packages/transport-baileys/examples/wire.ts) |

Implement `send(rendered, recipient, ctx)`. Map `recipient.handle` to an authorized chat.
Send `rendered.text`; return `{ status: "sent", messageId }` only after the platform supplies an ID.
Return `retry` for a known pre-send failure, or `failed` for a permanent or uncertain outcome.
Core treats a thrown transport error as not sent and retries it; catch ambiguous send errors in the adapter.

## Wire the bridge

The existing [Baileys example](../packages/transport-baileys/examples/wire.ts) shows the API wiring.
For another platform, replace the transport and platform message parsing:

1. Load the binding's outbound and inbound tokens in the host process.
2. Open a persistent `CustodyStore` with a path owned by this bridge.
3. Create `DeliveryLoop({ custody, transport })`.
4. Create `createOutboundHandler({ custody, outboundToken, onAccepted: () => loop.wake() })`.
5. Mount the handler on a Node HTTP server bound to `127.0.0.1`; call `loop.start()`.
6. Create `InboundClient({ custody, daemonUrl, inboundToken })` for the OpenRig loopback URL.
7. On a verified quoted platform reply, call `inbound.reply({ text, quotedMessageId, senderHandle, replyMessageId })`.
8. On shutdown, stop the loop and close the host's HTTP server and socket.

Match the handler path to `OPENRIG_RELAY_URL`. The default path is `/outbound`.
The example listener port is `8088`, not a core default.
Core constructs `/api/gateway/relay/inbound` from `daemonUrl`.

Authenticate platform identity before mapping it to `senderHandle`. Never accept a handle asserted in message text.
For Baileys, reuse `authorizeSender` and `classifyReply` as shown in the wiring example.
Wrong senders, wrong chats, malformed owner lists and media replies must fail closed.

## Bind a recipient in your own OpenRig setup

Use a dedicated test setup for initial integration. The offline example does not run these commands.
Provision an owner-only secrets file outside the repository through your secrets workflow.
Populate the three keys in the [configuration reference](configuration.md#openrig-binding).
Use separate tokens; keep real tokens and platform identities out of source, fixtures and logs.

The pinned binding syntax is:

```text
relay:<connectorRef>:file:<absolute-env-file>:<role>[:handle=<alias>]
```

Example registration, using a fictional entity and handle:

```bash
rig gateway human add demo-owner --display-name "Demo Owner" --delivery-class B \
  --binding "relay:demo-bridge:file:$HOME/.config/openrig-relay/demo.env:primary:handle=demo-owner"
rig gateway human show demo-owner
```

Use the same `demo-owner` alias in your host's handle-to-chat mapping.
Readiness checks bindings and secrets; it does not prove the bridge is reachable.
For applying configuration changes and testing delivery, follow the pinned upstream
[Gateway Relay lifecycle](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md#5-operational-lifecycle)
in your dedicated setup.

## Host responsibilities

| Package provides | Host supplies |
|---|---|
| Durable acceptance, deduplication, correlation and retries | Persistent storage, process lifecycle and monitoring |
| Rendering and quoted-reply routing | Platform parsing and authenticated identity mapping |
| Transport over `BaileysSocketLike` | Socket creation, pairing, auth storage and reconnects |
| Redaction helpers | Safe logging and secrets handling |

Group discovery, media, voice, audio, work routing and state mirroring belong to the host.
This repository does not add another approval engine or outbox.

## Delivery and recovery

Core's custody store is append-only JSONL. It loops short writes and fsyncs files and directories
after creation or rename. Compaction uses a temporary file, fsync and rename; storage failures fail closed.
A `2xx` acknowledges bridge custody, not platform delivery or human receipt.

| Boundary | Guarantee or recovery action |
|---|---|
| OpenRig to bridge | Authenticate, validate and fsync custody before `2xx`. Same delivery ID and canonical payload returns `200`; changed payload returns `409`. |
| Bridge to platform | Record intent before sending. After a crash, unresolved sends become `uncertain` and are never resent automatically. |
| Reply to OpenRig | Keep `replyRef` opaque. Retry transient errors with the same platform reply ID for a stable `eventId`. |
| Stale question | Inbound `404` or known stale-question `409` closes correlation. Other conflicts are reported without closing it. |
| Damaged custody | A torn final line is discarded on open. Other damage fails closed. Preserve evidence before repair. |

For `uncertain`, check the actual platform first. Call `resolveUncertainAsSent(deliveryId, messageId)`
when evidence confirms delivery, or `requeue(deliveryId)` only after an operator decides to resend.
Use `custody.stats()` and `custody.list()` for monitoring. Preserve acknowledged history and dedup state.

Free text is recorded context, never an inferred approval. Core maps a bare option number to its rendered label.
Contract v1 options live in `body`: the renderer numbers the first list of two or more `-`, `*`, `1.` or `1)` lines.
Digest replies name an item by its `[code]`; multiple answerable items without a code return `ambiguous` and post nothing.

OpenRig replays outbound dispatches after daemon or bridge restart, not through a periodic timeout timer.
See the pinned [custody contract](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md#1-system-topology--custody-boundaries).

## Upstream references

- [OpenRig](https://github.com/mvschwarz/openrig): runtime and Gateway owner.
- [Pinned Gateway Relay contract](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md): wire format, bindings, custody and recovery.
- [Rig specification](https://github.com/mvschwarz/openrig/blob/main/docs/reference/rig-spec.md): adapting integration to your own team.
- [Harness runner contract](https://github.com/mvschwarz/openrig/blob/main/docs/reference/harness-runner-contract.md): harness boundaries; this bridge uses Gateway Relay instead.
- [Contributing upstream](https://github.com/mvschwarz/openrig/blob/main/CONTRIBUTING.md): scope discussion, checks and review.
