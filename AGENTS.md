# Repository guide

Build the bridge side of OpenRig's Gateway Relay contract v1. Preserve working behavior while making it easy to adopt.
Core is transport independent; Baileys adapts a socket owned by the host application.

## Layout

| Path | Purpose |
|---|---|
| `packages/core/src/` | Protocol types, outbound handler, custody, rendering, delivery loop and inbound client. |
| `packages/core/test/` | Contract, crash, recovery and end-to-end tests; fake daemon and transport helpers. |
| `packages/transport-baileys/src/` | Socket adapter, reply classification, sender checks, option parsing and redaction. |
| `packages/transport-baileys/test/` | Adapter and identity tests. |
| `packages/transport-baileys/examples/wire.ts` | Host-owned socket integration. |
| `examples/minimal/` | Offline bridge round trip and its test. |
| `docs/` | Integration and configuration detail. |
| `openrig-compat.json` | Declared package and upstream contract compatibility. |

## Change rules

- Continuity over creation: read the README, relevant source and tests first. Reuse existing functions, tests and patterns before adding mechanisms.
- Fail closed: preserve authentication, sender checks, custody-before-ACK, deduplication and uncertain-send handling. Never infer approval from free text.
- Tests first: pin a behavioral change with a failing test, then make the smallest change that passes. Use Vitest and existing dependency injection seams.
- Verify honestly: run checks and report actual command output, failures and skipped tests. Distinguish simulation from live OpenRig or WhatsApp testing.
- Keep one concern per change. Preserve unrelated changes and use project dependencies. Do not touch a running OpenRig daemon or service during repository checks.
- Use fictional fixtures. Never put credentials, real phone numbers, JIDs or personal data in source, tests, logs or tracked files.
- Keep commits and PRs factual. No AI attribution lines, AI co-author trailers or session links. Commit, push and publish only when requested.

## Build and verify

Requires Node `^22 || ^24` and npm 10 or newer.

```bash
npm ci
npm run build
npm run check
npm test
npm run example:minimal
npm run test:example
```

`npm test` includes the offline example and compatibility guard. The optional parity test
needs `RELAY_FIXTURE_PATH` pointing at OpenRig's `packages/daemon/test/fixtures/recording-relay.ts`.
Report its skip when absent. See [minimal example commands](examples/minimal/README.md).

## Upstream boundaries

Before changing protocol, custody or bindings, read the pinned
[Gateway Relay contract](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md)
and compare core's `CONTRACT_VERSION` / `CONTRACT_PIN` with `openrig-compat.json`.
Declare only compatibility backed by evidence; do not widen the OpenRig range from a stub test.

For rig integration, consult OpenRig's [rig specification](https://github.com/mvschwarz/openrig/blob/main/docs/reference/rig-spec.md).
For harness integration, consult its [harness runner contract](https://github.com/mvschwarz/openrig/blob/main/docs/reference/harness-runner-contract.md).
The upstream project is [mvschwarz/openrig](https://github.com/mvschwarz/openrig).

For upstream issues and PRs, follow [OpenRig's CONTRIBUTING.md](https://github.com/mvschwarz/openrig/blob/main/CONTRIBUTING.md):
discuss features first, obtain scope agreement for integrations, keep one concern, and include exact verification and limits.
Apply that repository's own release rules when contributing there.
