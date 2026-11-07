import { describe, expect, it } from "vitest";
import { DeliveryMachine, runDelivery, type DeliverySnapshot } from "../src/index.js";

const outcome = (o: unknown) => async () => o as never;

describe("DeliveryMachine", () => {
  it("records sending before the attempt and sent after", async () => {
    const log: DeliverySnapshot[] = [];
    const m = new DeliveryMachine("d1", { record: (s) => void log.push({ ...s }) });
    const r = await m.attempt(outcome({ status: "sent", messageId: "M1" }));
    expect(r.state).toBe("sent");
    expect(log.map((s) => s.state)).toEqual(["sending", "sent"]);
    expect(m.snapshot).toMatchObject({ state: "sent", attempts: 1, messageId: "M1" });
  });
  it("does not call the sender when the pre-send record fails", async () => {
    let called = false;
    const m = new DeliveryMachine("d1", { record: () => { throw new Error("disk"); } });
    await expect(m.attempt(async () => { called = true; return { status: "sent", messageId: "x" }; })).rejects.toThrow("disk");
    expect(called).toBe(false);
  });
  it("retry goes back to retry_wait with a reason and delay", async () => {
    const m = new DeliveryMachine("d1");
    const r = await m.attempt(outcome({ status: "retry", reason: "offline", retryAfterMs: 500 }));
    expect(r).toMatchObject({ state: "retry_wait", lastError: "offline", retryAfterMs: 500 });
  });
  it("failed is terminal; a thrown sender is unknown, never retried", async () => {
    const m = new DeliveryMachine("d1");
    expect((await m.attempt(outcome({ status: "failed", reason: "blocked" }))).state).toBe("failed");
    await expect(m.attempt(outcome({ status: "sent", messageId: "x" }))).rejects.toThrow(/terminal/);
    const u = new DeliveryMachine("d2");
    expect((await u.attempt(async () => { throw new Error("socket reset"); })).state).toBe("unknown");
    await expect(u.attempt(outcome({ status: "sent", messageId: "x" }))).rejects.toThrow(/unknown/);
  });
  it("gives up after maxAttempts", async () => {
    const m = new DeliveryMachine("d1", { maxAttempts: 2 });
    await m.attempt(outcome({ status: "retry", reason: "a" }));
    const r = await m.attempt(outcome({ status: "retry", reason: "b" }));
    expect(r).toMatchObject({ state: "failed", attempts: 2, lastError: "b" });
  });
  it("resolveUnknown lets an operator settle an unknown delivery", async () => {
    const m = new DeliveryMachine("d1");
    await m.attempt(async () => { throw new Error("x"); });
    expect((await m.resolveUnknown({ sent: true, messageId: "M9" })).state).toBe("sent");
  });
});

describe("DeliveryMachine concurrency", () => {
  it("two concurrent attempts send once", async () => {
    let sends = 0;
    const m = new DeliveryMachine("d1", { record: async () => { await new Promise((r) => setTimeout(r, 5)); } });
    const sender = async () => { sends += 1; return { status: "sent", messageId: "M" } as const; };
    const results = await Promise.allSettled([m.attempt(sender), m.attempt(sender)]);
    expect(sends).toBe(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("a failed pre-send record releases the reservation", async () => {
    let fail = true;
    const m = new DeliveryMachine("d1", { record: () => { if (fail) throw new Error("disk"); } });
    await expect(m.attempt(outcome({ status: "sent", messageId: "x" }))).rejects.toThrow("disk");
    expect(m.snapshot).toMatchObject({ state: "pending", attempts: 0 });
    fail = false;
    expect((await m.attempt(outcome({ status: "sent", messageId: "x" }))).state).toBe("sent");
  });
});

describe("runDelivery", () => {
  it("retries with bounded exponential backoff until sent", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const m = new DeliveryMachine("d1", { backoff: { baseMs: 100, maxMs: 250, factor: 2 }, maxAttempts: 6 });
    const r = await runDelivery(m, async () => (++n < 4 ? { status: "retry", reason: "r" } : { status: "sent", messageId: "ok" }), { sleep: async (ms) => void sleeps.push(ms) });
    expect(r.state).toBe("sent");
    expect(sleeps).toEqual([100, 200, 250]);
  });
  it("honours retryAfterMs and stops on failed", async () => {
    const sleeps: number[] = [];
    const m = new DeliveryMachine("d1");
    let n = 0;
    const r = await runDelivery(m, async () => (++n === 1 ? { status: "retry", reason: "r", retryAfterMs: 7 } : { status: "failed", reason: "no" }), { sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([7]);
    expect(r.state).toBe("failed");
  });
});
