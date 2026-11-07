/**
 * Optional parity check against the real upstream fixture. Point RELAY_FIXTURE_PATH at
 * `packages/daemon/test/fixtures/recording-relay.ts` in an OpenRig checkout pinned at the
 * commit named in CONTRACT_PIN; the same request matrix must get the same status codes from the
 * fixture and from this package's handler. Skipped when the variable is not set.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CustodyStore, createOutboundHandler } from "../src/index.js";
import { decision, postJson, tmpCustodyPath } from "./helpers/util.js";

const fixturePath = process.env.RELAY_FIXTURE_PATH;

describe.skipIf(!fixturePath)("parity with recording-relay", () => {
  it("answers the same status codes for the same requests", async () => {
    const mod = (await import(pathToFileURL(fixturePath as string).href)) as {
      startRecordingRelay: (o: { outboundToken: string; inboundToken: string; custodyFilePath: string }) => Promise<{ outboundUrl: string; stop(): Promise<void> }>;
    };
    const token = "parity-out";
    const fixture = await mod.startRecordingRelay({ outboundToken: token, inboundToken: "x", custodyFilePath: tmpCustodyPath() });
    const handler = createOutboundHandler({ custody: CustodyStore.open(tmpCustodyPath()), outboundToken: token });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const ours = `http://127.0.0.1:${(server.address() as AddressInfo).port}/outbound`;

    const matrix: Array<[string | null, unknown]> = [
      [null, decision("p1")],
      ["wrong", decision("p1")],
      [token, "{bad"],
      [token, { ...decision("p2"), extra: 1 }],
      [token, { ...decision("p2"), v: 2 }],
      [token, decision("p1")],
      [token, decision("p1")],
      [token, { ...decision("p1"), body: "changed" }],
      [token, { ...decision("p3"), replyRef: null, intent: "update", outcome: "notify" }],
      [token, { ...decision("p4"), outcome: "digest", replyRef: null, items: [{ qitemId: "q", notificationKey: "k", summary: "s", replyRef: null }] }],
    ];
    for (const [tok, body] of matrix) {
      const [a, b] = [await postJson(fixture.outboundUrl, tok, body), await postJson(ours, tok, body)];
      expect({ status: b.status, json: b.json }).toEqual({ status: a.status, json: a.json });
    }
    await fixture.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
