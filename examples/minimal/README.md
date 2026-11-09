# Minimal offline bridge

Run one bridge end to end without WhatsApp, accounts or network services.
Allow under five minutes with Node 22 or 24, npm 10+, and dependencies available.
Installation may download dependencies; the example itself uses no network.

From a clean clone:

```sh
git clone https://github.com/smota/openrig-whatsapp-relay.git
cd openrig-whatsapp-relay
npm ci
npm run build
npm run example:minimal
npm run test:example
```

Expected example output:

```text
Outbound accepted: 200
Replay deduplicated: true
Transport messages: 1
Gateway answer: 1. Ship the demo
Custody status: answered
```

```text
stub OpenRig -- envelope --> bridge processor -- rendered text --> memory transport
stub OpenRig <-- answer ---- inbound client   <-- quoted reply --- fictional owner
```

`index.mjs` uses the real core processor, custody store, renderer, delivery loop and
inbound client. The fake transport records its messages in an array. An injected
fetch-shaped function implements the stub Gateway Relay inbound endpoint. The
loopback URL is only an identifier: no listener or socket is opened.

Custody uses a temporary file with the production fsync behavior. The file is
removed on success or failure. All handles, IDs and token values are public,
fictional fixtures. The example reads no environment variables or account data.

The example checks acceptance, replay deduplication, one transport send, option
mapping and the final `answered` state. Its Vitest test replaces global `fetch`
with a function that throws, then checks the actual answer and rendered message.
`npm test` includes this test. `run.mjs` uses the built package; the test injects
the source module so stale build output cannot hide a source regression.

For a real integration, replace the stub endpoint and fake transport using the
[implementation guide](../../docs/implementation-guide.md). Keep durable custody.
