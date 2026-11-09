# openrig-whatsapp-relay

Connect OpenRig's Gateway Relay to WhatsApp or another messaging platform.
Core keeps durable custody, sends through your transport and routes quoted replies back to OpenRig.
The Baileys package uses a WhatsApp socket your application owns. Start with the offline example below.

## Quick start

Requires Node `^22 || ^24` and npm 10 or newer. From a clean clone:

```bash
git clone https://github.com/smota/openrig-whatsapp-relay.git
cd openrig-whatsapp-relay
npm ci
npm run build
npm run example:minimal
npm run test:example
```

The [minimal example](examples/minimal/README.md) runs one bridge, a stub Gateway Relay endpoint
and an in-memory transport. It needs no account, socket listener or network service.
Installation downloads locked development dependencies; the example itself runs offline.

## Implementation guide

Use core for a custom transport. Use `transport-baileys` for a Baileys socket you already own.
Both packages are private workspaces in this repository; build from source.

```text
OpenRig -> outbound handler -> durable custody -> delivery loop -> transport
OpenRig <- inbound client  <- quoted reply + verified sender  <- transport
```

Follow the [implementation guide](docs/implementation-guide.md) for bindings, bridge wiring,
sender checks and host responsibilities. The existing
[Baileys wiring example](packages/transport-baileys/examples/wire.ts) shows both packages together.
Read the [delivery and recovery rules](docs/implementation-guide.md#delivery-and-recovery) before connecting a real transport.

## Configuration reference

Core takes explicit constructor options. It does not load secrets files or environment variables.
Your host loads the binding's file and passes the values to core.

| Setting | Used by | Meaning |
|---|---|---|
| `OPENRIG_RELAY_URL` | OpenRig binding | Bridge loopback HTTP URL, including the handler path. Default path: `/outbound`. |
| `OPENRIG_RELAY_OUTBOUND_TOKEN` | OpenRig and outbound handler | Bearer for OpenRig-to-bridge deliveries. |
| `OPENRIG_RELAY_INBOUND_TOKEN` | OpenRig and inbound client | Separate bearer for bridge-to-OpenRig replies. Unique per relay profile. |
| `daemonUrl` | `InboundClient` | OpenRig loopback HTTP base URL. Replies use `/api/gateway/relay/inbound`. |
| custody path | `CustodyStore.open` | Persistent JSONL file owned by the bridge. |

See [configuration defaults and API options](docs/configuration.md). Keep tokens out of logs and tracked files.

## Compatibility

| This repo version | OpenRig release or commit range | Protocol/schema version |
|---|---|---|
| `0.1.0` | Exact commit [`f5b62726ff759a857eeb76e2cbd654493fedba2f`](https://github.com/mvschwarz/openrig/commit/f5b62726ff759a857eeb76e2cbd654493fedba2f) | Gateway Relay contract `1` (`v: 1`) |

This is the contract pin, not a claim of live integration testing against every OpenRig release.
No broader release range is declared. [openrig-compat.json](openrig-compat.json) is the machine-readable declaration;
`npm test` checks it against core's `CONTRACT_VERSION` and `CONTRACT_PIN`.
See the [changelog](CHANGELOG.md) for package history.

Baileys is an optional peer dependency: tested with `@whiskeysockets/baileys` `6.7.24`,
declared range `>=6.7.16 <6.8.0`. Core has zero runtime dependencies.

## Troubleshooting

| Symptom | Check or action |
|---|---|
| Outbound `401` | Pass the binding's outbound bearer to the handler. |
| Outbound `404` | Match the relay URL to the handler path, default `/outbound`. |
| Outbound `409` | A delivery ID was reused with a different payload. Preserve the original payload. |
| Outbound `503` | Inspect custody permissions, capacity and storage errors. Preserve the custody file. |
| Reply is `unmatched` or `rejected` | Check quoted message ID and verified sender-to-handle mapping. |
| Reply is `closed` | The question is informational, stale or already answered. |
| Delivery is `uncertain` | Check platform evidence before calling `requeue` or `resolveUncertainAsSent`. |
| Parity test is skipped | Set `RELAY_FIXTURE_PATH` to an upstream fixture for the optional comparison. |

See [delivery and recovery](docs/implementation-guide.md#delivery-and-recovery) and the pinned upstream
[Gateway Relay troubleshooting guide](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md#6-troubleshooting-common-conditions).

## Contributing

Read [AGENTS.md](AGENTS.md) for the layout and change rules. Reuse existing functions and tests.
Keep each change focused and use fictional fixtures.

```bash
npm ci
npm run build
npm run check
npm test
npm run test:example
```

Tests cover fake-daemon round trips, custody crash boundaries, delivery recovery and Baileys adapters.
They do not prove a live WhatsApp session or installed OpenRig daemon works.
Optional comparison with the upstream recording relay:

```bash
RELAY_FIXTURE_PATH=/path/to/openrig/packages/daemon/test/fixtures/recording-relay.ts npm test
```

For upstream work, follow [OpenRig's CONTRIBUTING.md](https://github.com/mvschwarz/openrig/blob/main/CONTRIBUTING.md).
Licensed under [Apache-2.0](LICENSE).
