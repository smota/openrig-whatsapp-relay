import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CustodyStore, DeliveryLoop, createOutboundProcessor, nodeFileIo, type FileIo } from "../src/index.js";
import { FaultyIo, SimulatedCrash } from "./helpers/faulty-io.js";
import { OUT, ScriptedTransport, decision, digest, tmpCustodyPath, update } from "./helpers/util.js";

const post = (store: CustodyStore, env: ReturnType<typeof decision>) =>
  createOutboundProcessor({ custody: store, outboundToken: OUT }).process({
    authorization: `Bearer ${OUT}`,
    rawBody: JSON.stringify(env),
  });

describe("custody crash safety", () => {
  it("kill between write and fsync with power loss: never acknowledged, daemon replay is accepted fresh", () => {
    const path = tmpCustodyPath();
    const io = new FaultyIo();
    const store = CustodyStore.open(path, { io });
    post(store, decision("d0")); // one fully durable record first
    io.inject("append-after-write-before-fsync");
    expect(post(store, decision("d1")).status).toBe(503); // the caller never saw a 2xx
    io.powerLoss(path);
    io.restart();

    const reopened = CustodyStore.open(path, { io });
    expect(reopened.get("d0")).toBeDefined();
    expect(reopened.get("d1")).toBeUndefined();
    expect(post(reopened, decision("d1")).body.deduplicated).toBe(false);
  });

  it("kill between write and fsync without power loss: record survived, replay is a duplicate", () => {
    const path = tmpCustodyPath();
    const io = new FaultyIo();
    const store = CustodyStore.open(path, { io });
    io.inject("append-after-write-before-fsync");
    expect(post(store, decision("d1")).status).toBe(503);
    io.restart();
    const reopened = CustodyStore.open(path, { io });
    expect(reopened.get("d1")?.status).toBe("pending");
    expect(post(reopened, decision("d1")).body.deduplicated).toBe(true);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("kill after fsync before the response: durable, replay deduplicates", () => {
    const path = tmpCustodyPath();
    const io = new FaultyIo();
    const store = CustodyStore.open(path, { io });
    io.inject("append-after-fsync");
    expect(post(store, decision("d1")).status).toBe(503);
    io.restart();
    expect(post(CustodyStore.open(path, { io }), decision("d1")).body.deduplicated).toBe(true);
  });

  it("drops a torn final line on open and keeps appending cleanly", () => {
    const path = tmpCustodyPath();
    const io = new FaultyIo();
    const store = CustodyStore.open(path, { io });
    post(store, decision("d0"));
    io.inject("append-torn");
    post(store, decision("d1"));
    io.restart();
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(false);

    const reopened = CustodyStore.open(path, { io });
    expect(reopened.list().map((r) => r.deliveryId)).toEqual(["d0"]);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    post(reopened, decision("d2"));
    expect(CustodyStore.open(path).list().map((r) => r.deliveryId)).toEqual(["d0", "d2"]);
  });

  it("recovers from a partial line left on disk, then a torn append", () => {
    const path = tmpCustodyPath();
    const store = CustodyStore.open(path);
    store.accept(decision("d0"), "{}");
    appendFileSync(path, '{"t":"acc'); // a partial line left behind by a failed write
    // simulate the store's own bookkeeping: it truncates to its known size after a failed append
    const io = new FaultyIo();
    const s2 = CustodyStore.open(path, { io }); // open drops the tail
    expect(s2.list()).toHaveLength(1);
    io.inject("append-torn");
    expect(post(s2, decision("d1")).status).toBe(503);
    // process still alive in this scenario? it is dead (torn crash) so nothing more was written
    io.restart();
    expect(CustodyStore.open(path, { io }).list()).toHaveLength(1);
  });

  it("poisons itself when the cleanup after a failed append also fails", () => {
    const path = tmpCustodyPath();
    const io = new FaultyIo();
    const store = CustodyStore.open(path, { io });
    io.failTruncate = true;
    io.inject("append-torn");
    expect(post(store, decision("d1")).status).toBe(503);
    io.restart();
    expect(post(store, decision("d2")).status).toBe(503); // poisoned: refuses instead of corrupting
  });

  it("fails closed on damage in the middle of the file", () => {
    const path = tmpCustodyPath();
    const store = CustodyStore.open(path);
    store.accept(decision("d1"), "{}");
    store.accept(decision("d2"), "{}");
    const [a, b] = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${a}\n{"broken\n${b}\n`);
    expect(() => CustodyStore.open(path)).toThrow(/custody line 2/);
    writeFileSync(path, `${a}\n{"t":"sent","at":"x","deliveryId":"ghost","messageId":"m"}\n`);
    expect(() => CustodyStore.open(path)).toThrow(/unknown deliveryId/);
  });

  describe("compaction", () => {
    function seeded(io: FaultyIo, path: string): CustodyStore {
      const s = CustodyStore.open(path, { io });
      s.accept(decision("d1"), "{}");
      s.accept(digest("d2"), "{}");
      s.accept(update("d3"), "{}");
      s.markSending("d1");
      s.markSent("d1", "wa-1");
      s.markSending("d3");
      s.markSent("d3", "wa-3");
      const c = s.findCorrelation(s.get("d1")!.correlations[0]!.id)!;
      s.resolveCorrelation("d1", c.correlation.id, "answered", { eventId: "evt-1" });
      return s;
    }

    it("keeps every record and its state, and dedup still works", () => {
      const path = tmpCustodyPath();
      const io = new FaultyIo();
      const s = seeded(io, path);
      const before = JSON.stringify(s.list());
      s.compact();
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
      const reopened = CustodyStore.open(path, { io });
      expect(JSON.stringify(reopened.list())).toBe(before);
      expect(reopened.findByMessageId("wa-1")?.status).toBe("answered");
      expect(reopened.accept(decision("d1"), "{}").kind).toBe("duplicate");
      expect(reopened.findCorrelation(s.get("d2")!.correlations[0]!.id)).toBeDefined();
    });

    it("crash before the rename leaves the old file intact and removes the temp file", () => {
      const path = tmpCustodyPath();
      const io = new FaultyIo();
      const s = seeded(io, path);
      const before = readFileSync(path, "utf8");
      io.inject("atomic-before-rename");
      expect(() => s.compact()).toThrow(SimulatedCrash);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(existsSync(`${path}.tmp`)).toBe(true);
      io.restart();
      const reopened = CustodyStore.open(path, { io });
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(reopened.list()).toHaveLength(3);
    });

    it("crash after the rename leaves the compacted file, fully valid", () => {
      const path = tmpCustodyPath();
      const io = new FaultyIo();
      const s = seeded(io, path);
      const before = JSON.stringify(s.list());
      io.inject("atomic-after-rename");
      expect(() => s.compact()).toThrow(SimulatedCrash);
      io.restart();
      expect(JSON.stringify(CustodyStore.open(path, { io }).list())).toBe(before);
    });

    it("compacts by itself past the threshold without losing state", () => {
      const path = tmpCustodyPath();
      const s = CustodyStore.open(path, { compactMinLines: 10 });
      for (let i = 0; i < 5; i++) {
        s.accept(decision(`d${i}`), "{}");
        s.markSending(`d${i}`);
        s.markRetry(`d${i}`);
        s.markSending(`d${i}`);
        s.markSent(`d${i}`, `m${i}`);
      }
      expect(readFileSync(path, "utf8").trim().split("\n").length).toBeLessThan(25);
      const reopened = CustodyStore.open(path);
      expect(reopened.list().map((r) => [r.deliveryId, r.status, r.attempts])).toEqual(
        [0, 1, 2, 3, 4].map((i) => [`d${i}`, "sent", 2]),
      );
    });
  });

  describe("between send and record", () => {
    it("a failure recording 'sent' does not cause a resend while the process lives", async () => {
      const path = tmpCustodyPath();
      let failRecord = false;
      const io: FileIo = {
        ...nodeFileIo,
        appendDurable(p, d) {
          if (failRecord && d.includes('"t":"sent"')) throw new Error("disk hiccup");
          nodeFileIo.appendDurable(p, d);
        },
      };
      const store = CustodyStore.open(path, { io });
      store.accept(decision("d1"), "{}");
      const transport = new ScriptedTransport();
      const loop = new DeliveryLoop({ custody: store, transport, onError: () => {} });
      failRecord = true;
      await loop.tick();
      await loop.tick();
      expect(transport.sends).toHaveLength(1);
      failRecord = false;
      await loop.tick();
      expect(transport.sends).toHaveLength(1);
      expect(store.get("d1")).toMatchObject({ status: "sent", messageId: "m-1" });
    });

    it("a crash after the transport sent but before 'sent' was durable is never resent after restart", async () => {
      const path = tmpCustodyPath();
      const io = new FaultyIo();
      const store = CustodyStore.open(path, { io });
      store.accept(decision("d1"), "{}");
      const transport = new ScriptedTransport();
      const realSend = transport.send.bind(transport);
      transport.send = async (...args) => {
        const out = await realSend(...args);
        io.inject("append-before-write"); // the next write, 'sent', dies
        return out;
      };
      const loop = new DeliveryLoop({ custody: store, transport, onError: () => {} });
      await loop.tick();
      expect(transport.sends).toHaveLength(1);
      io.restart();

      const reopened = CustodyStore.open(path, { io });
      expect(reopened.get("d1")?.status).toBe("uncertain");
      const again = new ScriptedTransport();
      await new DeliveryLoop({ custody: reopened, transport: again }).tick();
      expect(again.sends).toHaveLength(0);
    });

    it("after a real restart the record is uncertain and is not resent until an operator decides", async () => {
      const path = tmpCustodyPath();
      const io = new FaultyIo();
      const store = CustodyStore.open(path, { io });
      store.accept(decision("d1"), "{}");
      store.markSending("d1");
      // process dies here: transport may or may not have sent

      const reopened = CustodyStore.open(path, { io });
      expect(reopened.get("d1")?.status).toBe("uncertain");
      expect(reopened.uncertain()).toHaveLength(1);
      const transport = new ScriptedTransport();
      const loop = new DeliveryLoop({ custody: reopened, transport });
      await loop.tick();
      expect(transport.sends).toHaveLength(0);

      reopened.requeue("d1");
      await loop.tick();
      expect(transport.sends).toHaveLength(1);
      expect(reopened.get("d1")?.status).toBe("sent");
    });

    it("an operator can resolve an uncertain record as sent", () => {
      const path = tmpCustodyPath();
      const store = CustodyStore.open(path);
      store.accept(decision("d1"), "{}");
      store.markSending("d1");
      const reopened = CustodyStore.open(path);
      reopened.resolveUncertainAsSent("d1", "wa-9");
      expect(CustodyStore.open(path).findByMessageId("wa-9")?.status).toBe("sent");
    });
  });

  it("derives short, unique, stable correlation ids that survive restart", () => {
    const path = tmpCustodyPath();
    const store = CustodyStore.open(path);
    for (let i = 0; i < 200; i++) store.accept(digest(`d${i}`), "{}");
    const ids = store.list().flatMap((r) => r.correlations.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-hjkmnp-tv-z]{6,24}$/.test(id))).toBe(true);
    const again = CustodyStore.open(path);
    expect(again.list().flatMap((r) => r.correlations.map((c) => c.id))).toEqual(ids);
  });
});
