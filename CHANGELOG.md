# Changelog

Newest changes first. Historical entries were reconstructed from the three initial commits.
There are no release tags in the existing history; `0.1.0` is the declared package version.

## Unreleased

- Add an offline reference example and end-to-end test.
- Reorganize adoption, integration and configuration documentation.
- Add agent guidance and a machine-readable compatibility declaration with drift checks.

## 0.1.0 — 2026-11-07 (initial untagged history)

- Add transport-independent Gateway Relay contract v1 core: durable custody, deduplication,
  rendering, delivery and quoted replies. Pin upstream contract commit `f5b62726f`.
  Commit [`9608724`](https://github.com/smota/openrig-whatsapp-relay/commit/9608724).
- Add the Baileys transport, delivery state machine, sender checks, option parsing and redaction.
  Commit [`9327e14`](https://github.com/smota/openrig-whatsapp-relay/commit/9327e14).
- Replace the redaction test's number with a fictional fixture.
  Commit [`945f3ac`](https://github.com/smota/openrig-whatsapp-relay/commit/945f3ac).
