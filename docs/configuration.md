# Configuration reference

Pass configuration explicitly. The host owns secrets loading, socket lifecycle and persistent paths.
The packages provide no CLI, service manager or secrets loader.

## OpenRig binding

OpenRig reads the three `OPENRIG_RELAY_*` keys in the [README](../README.md#configuration-reference)
from the binding's absolute `file:` reference. It does not fall back to process environment variables.
Use an owner-only file, separate directional tokens and a unique inbound token for each connector.
Point the URL at the bridge's loopback listener and exact handler path.
See the pinned [configuration contract](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md#2-secrets--environment-configuration).

## Core options

| API | Option | Default | Purpose |
|---|---|---|---|
| `createOutboundHandler` | `custody`, `outboundToken` | Required | Store and outbound authentication. |
| `createOutboundHandler` | `path` | `/outbound` | Accepted POST path. |
| `createOutboundHandler` | `maxBodyBytes` | `8388608` (8 MiB) | Body cap; excess returns `413`. |
| `createOutboundHandler` | `onAccepted` | None | Called after new durable acceptance; use to wake the loop. |
| `CustodyStore.open` | `maxPending` | `10000` | Back-pressure for pending, sending and uncertain records. |
| `CustodyStore.open` | `compactMinLines` | `1000` | Compaction threshold, also bounded by twice the live entry count. |
| `CustodyStore.open` | `retainSettledMs` | `604800000` (7 days) | Retire answered/closed records during compaction. |
| `CustodyStore.open` | `dedupWindowMs` | `2592000000` (30 days) | Dedup window measured from settlement. |
| `CustodyStore.open` | `maxTombstones` | `100000` | Maximum tombstones; oldest removed first. |
| `DeliveryLoop` | `custody`, `transport` | Required | Queue and platform adapter. |
| `DeliveryLoop` | `pollMs` | `2000` | Poll interval after `start()`; `tick()` also works without timers. |
| `DeliveryLoop` | `backoff.baseMs` | `1000` | Initial retry delay. |
| `DeliveryLoop` | `backoff.maxMs` | `60000` | Maximum retry delay. |
| `DeliveryLoop` | `backoff.factor` | `2` | Retry growth factor. |
| `DeliveryLoop` | `backoff.maxAttempts` | `8` | Total attempts, including the first. |
| `DeliveryLoop` | `onError` | None | Error callback; redact before logging. |
| `InboundClient` | `custody`, `daemonUrl`, `inboundToken` | Required | Correlation, loopback base URL and authentication. |
| `InboundClient` | `timeoutMs` | `10000` | Reply POST timeout. |
| `InboundClient` | `fetch` | Global `fetch` | Injection point used by the offline example. |

`CustodyStore.open` also accepts `io` and `now`; `DeliveryLoop` accepts `now`.
These seams support deterministic tests. Production should use the durable filesystem implementation.
`createOutboundProcessor` provides authentication, validation and custody without an HTTP listener.
Its caller must enforce a body-size limit; the HTTP handler enforces `maxBodyBytes`.

Full option types: [custody](../packages/core/src/custody.ts), [handler](../packages/core/src/handler.ts),
[delivery loop](../packages/core/src/loop.ts), [inbound client](../packages/core/src/inbound.ts).

## Baileys options

| API | Option | Default | Purpose |
|---|---|---|---|
| `createBaileysTransport` | `socket`, `resolveChat` | Required | Host socket and handle-to-chat resolver. Unknown handles fail closed. |
| `createBaileysTransport` | `isConnected` | Always connected | Host connection check; a closed connection can be retried before sending. |
| `createBaileysTransport` | `maxTextLength` | `60000` | Maximum rendered text length. |
| `parseOptionReply` | `locales` | `["en"]` | Number-word locales: `en`, `pt`, `es`. |
| `parseOptionReply` | `voice` | `false` | For transcripts, a number word must have no trailing punctuation. |

See [transport options](../packages/transport-baileys/src/transport.ts),
[reply classification](../packages/transport-baileys/src/classify.ts) and
[Baileys wiring](../packages/transport-baileys/examples/wire.ts).
`DeliveryMachine` / `runDelivery` are a separate per-message state machine with five attempts by default.
Core's loop already handles durable intent and retries; choose one owner for retries rather than nesting both.
