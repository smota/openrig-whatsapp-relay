import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CustodyStore, createOutboundHandler, type FileIo, nodeFileIo } from "../src/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { OUT, decision, postJson, tmpCustodyPath } from "./helpers/util.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function serve(custody: CustodyStore, extra: Parameters<typeof createOutboundHandler>[0] extends infer O ? Partial<O> : never = {}) {
  const handler = createOutboundHandler({ custody, outboundToken: OUT, ...extra });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${base}/outbound`, base, handler };
}

describe("outbound handler", () => {
  it("answers 401 for a missing or wrong bearer without touching custody", async () => {
    const path = tmpCustodyPath();
    const { url, handler } = await serve(CustodyStore.open(path));
    expect((await postJson(url, null, decision("d1"))).status).toBe(401);
    expect((await postJson(url, "nope", decision("d1"))).status).toBe(401);
    expect(handler.stats.unauthorized).toBe(2);
    expect(nodeFileIo.readText(path)).toBeNull();
  });

  it("answers 404 for other paths and methods", async () => {
    const { base } = await serve(CustodyStore.open(tmpCustodyPath()));
    expect((await fetch(`${base}/other`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/outbound`, { method: "GET" })).status).toBe(404);
  });

  it.each([
    ["invalid json", "{nope"],
    ["not an object", "[]"],
    ["unknown field", { ...decision("d"), extra: 1 }],
    ["wrong version", { ...decision("d"), v: 2 }],
    ["empty deliveryId", { ...decision("d"), deliveryId: " " }],
    ["bad intent", { ...decision("d"), intent: "chat" }],
    ["bad outcome", { ...decision("d"), outcome: "shout" }],
    ["missing body", { ...decision("d"), body: undefined }],
    ["extra recipient field", { ...decision("d"), recipient: { handle: "a", name: "x" } }],
    ["malformed digest item", { ...decision("d"), items: [{ qitemId: "q" }] }],
    ["replyRef too long", { ...decision("d"), replyRef: "x".repeat(4097) }],
  ])("answers 400 for %s", async (_name, body) => {
    const path = tmpCustodyPath();
    const { url } = await serve(CustodyStore.open(path));
    expect((await postJson(url, OUT, body)).status).toBe(400);
    expect(nodeFileIo.readText(path)).toBeNull();
  });

  it("answers 413 above the body limit", async () => {
    const { url } = await serve(CustodyStore.open(tmpCustodyPath()), { maxBodyBytes: 200 });
    expect((await postJson(url, OUT, decision("big", { body: "x".repeat(500) }))).status).toBe(413);
  });

  it("has fsync'd custody on disk before the 2xx is produced", async () => {
    const path = tmpCustodyPath();
    const order: string[] = [];
    const io: FileIo = {
      ...nodeFileIo,
      appendDurable(p, data) {
        nodeFileIo.appendDurable(p, data);
        order.push("durable");
      },
    };
    const custody = CustodyStore.open(path, { io });
    const { url } = await serve(custody, { onAccepted: () => order.push("accepted-callback") });
    const res = await postJson(url, OUT, decision("d1"));
    order.push("response");
    expect(res).toEqual({ status: 200, json: { ok: true, deliveryId: "d1", deduplicated: false } });
    expect(order).toEqual(["durable", "accepted-callback", "response"]);
    expect(readFileSync(path, "utf8")).toContain('"deliveryId":"d1"');
  });

  it("deduplicates by deliveryId and answers 409 for a different payload", async () => {
    const path = tmpCustodyPath();
    const { url, handler } = await serve(CustodyStore.open(path));
    await postJson(url, OUT, decision("d1"));
    const again = await postJson(url, OUT, decision("d1"));
    expect(again).toEqual({ status: 200, json: { ok: true, deliveryId: "d1", deduplicated: true } });
    const conflict = await postJson(url, OUT, decision("d1", { body: "changed" }));
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toBe("delivery_id_payload_conflict");
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    expect(handler.stats).toMatchObject({ accepted: 1, deduplicated: 1, conflicts: 1 });
  });

  it("treats key order differences as the same payload", async () => {
    const { url } = await serve(CustodyStore.open(tmpCustodyPath()));
    const e = decision("d1");
    await postJson(url, OUT, e);
    const reordered = JSON.stringify({ replyRef: e.replyRef, body: e.body, summary: e.summary, outcome: e.outcome, intent: e.intent, recipient: e.recipient, deliveryId: e.deliveryId, v: 1 });
    expect((await postJson(url, OUT, reordered)).json.deduplicated).toBe(true);
  });

  it("takes custody once for concurrent identical deliveries", async () => {
    const path = tmpCustodyPath();
    const { url } = await serve(CustodyStore.open(path));
    const results = await Promise.all(Array.from({ length: 8 }, () => postJson(url, OUT, decision("d1"))));
    expect(results.filter((r) => r.json.deduplicated === false)).toHaveLength(1);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("answers 503 custody_write_failed and takes no custody when the disk write fails", async () => {
    const path = tmpCustodyPath();
    let fail = true;
    const io: FileIo = {
      ...nodeFileIo,
      appendDurable(p, d) {
        if (fail) throw new Error("disk full");
        nodeFileIo.appendDurable(p, d);
      },
    };
    const { url } = await serve(CustodyStore.open(path, { io }));
    const first = await postJson(url, OUT, decision("d1"));
    expect(first).toEqual({ status: 503, json: { ok: false, error: "custody_write_failed" } });
    fail = false;
    expect((await postJson(url, OUT, decision("d1"))).json.deduplicated).toBe(false);
  });

  it("refuses to open a damaged custody file (the process would answer 503)", () => {
    const path = tmpCustodyPath();
    const store = CustodyStore.open(path);
    store.accept(decision("d1"), "{}");
    store.accept(decision("d2"), "{}");
    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, `${lines[0]}\nnot json\n${lines[1]}\n`);
    expect(() => CustodyStore.open(path)).toThrow(/unparseable custody line 2/);
  });

  it("is a plain function over request/response without any framework", async () => {
    const { handler } = await serve(CustodyStore.open(tmpCustodyPath()));
    expect(typeof handler).toBe("function");
  });
});
