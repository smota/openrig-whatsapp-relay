import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CustodyFullError, CustodyStore, createOutboundProcessor } from "../src/index.js";
import { OUT, decision, tmpCustodyPath, update } from "./helpers/util.js";

const DAY = 86_400_000;

function clocked(path: string, opts: Partial<Parameters<typeof CustodyStore.open>[1]> = {}) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  const store = CustodyStore.open(path, { now: () => new Date(t), ...opts });
  return { store, advance: (ms: number) => (t += ms) };
}
const settle = (s: CustodyStore, id: string, msg: string) => {
  s.accept(update(id), "{}");
  s.markSending(id);
  s.markSent(id, msg); // updates close on sent
};

describe("retention", () => {
  it("retires settled deliveries past the window at compaction, keeping a dedup tombstone", () => {
    const path = tmpCustodyPath();
    const { store, advance } = clocked(path, { retainSettledMs: 7 * DAY });
    settle(store, "u1", "m1");
    store.accept(decision("d2"), "{}"); // still pending: never retired
    advance(8 * DAY);
    store.compact();
    expect(store.get("u1")).toBeUndefined();
    expect(store.findByMessageId("m1")).toBeUndefined();
    expect(store.get("d2")?.status).toBe("pending");
    expect(store.accept(update("u1"), "{}").kind).toBe("duplicate"); // replay inside the dedup window
    expect(store.accept({ ...update("u1"), body: "changed" }, "{}").kind).toBe("conflict");
    expect(readFileSync(path, "utf8")).not.toContain("FYI: the job finished.");
    const reopened = CustodyStore.open(path);
    expect(reopened.accept(update("u1"), "{}").kind).toBe("duplicate");
    expect(reopened.stats().total).toBe(1);
  });

  it("keeps settled deliveries inside the retention window", () => {
    const { store, advance } = clocked(tmpCustodyPath(), { retainSettledMs: 7 * DAY });
    settle(store, "u1", "m1");
    advance(6 * DAY);
    store.compact();
    expect(store.get("u1")).toBeDefined();
  });

  it("drops tombstones past the dedup window and beyond the cap, oldest first", () => {
    const { store, advance } = clocked(tmpCustodyPath(), { retainSettledMs: DAY, dedupWindowMs: 10 * DAY, maxTombstones: 2 });
    for (const id of ["a", "b", "c"]) {
      settle(store, id, `m-${id}`);
      advance(1000);
    }
    advance(2 * DAY);
    store.compact();
    expect(store.accept(update("a"), "{}").kind).toBe("accepted"); // beyond the cap of 2
    expect(store.accept(update("c"), "{}").kind).toBe("duplicate");
    advance(11 * DAY);
    store.compact();
    expect(store.accept(update("c"), "{}").kind).toBe("accepted"); // beyond the window
  });

  it("never retires failed or unanswered deliveries", () => {
    const { store, advance } = clocked(tmpCustodyPath(), { retainSettledMs: DAY });
    store.accept(decision("d1"), "{}");
    store.markSending("d1");
    store.markSent("d1", "m1");
    store.accept(decision("d2"), "{}");
    store.markSending("d2");
    store.markFailed("d2", "blocked");
    advance(100 * DAY);
    store.compact();
    expect(store.get("d1")?.status).toBe("sent");
    expect(store.get("d2")?.status).toBe("failed");
  });

  it("auto-compaction bounds the ledger under churn", () => {
    const path = tmpCustodyPath();
    const { store, advance } = clocked(path, { compactMinLines: 20, retainSettledMs: 1000, dedupWindowMs: 5000, maxTombstones: 10 });
    for (let i = 0; i < 200; i++) {
      settle(store, `u${i}`, `m${i}`);
      advance(2000);
    }
    expect(readFileSync(path, "utf8").trim().split("\n").length).toBeLessThan(60);
    expect(store.list().length).toBeLessThan(40);
  });
});

describe("back-pressure", () => {
  it("answers 503 custody_full above the pending cap, while duplicates still get 200", () => {
    const store = CustodyStore.open(tmpCustodyPath(), { maxPending: 2 });
    const proc = createOutboundProcessor({ custody: store, outboundToken: OUT });
    const post = (id: string) => proc.process({ authorization: `Bearer ${OUT}`, rawBody: JSON.stringify(decision(id)) });
    expect(post("d1").status).toBe(200);
    expect(post("d2").status).toBe(200);
    const full = post("d3");
    expect(full).toMatchObject({ status: 503, body: { ok: false, error: "custody_full" } });
    expect(store.get("d3")).toBeUndefined();
    expect(post("d1").body.deduplicated).toBe(true);
    store.markSending("d1");
    store.markSent("d1", "m1"); // frees a slot
    expect(post("d3").status).toBe(200);
    expect(() => store.accept(decision("d4"), "{}")).toThrow(CustodyFullError);
  });
});
