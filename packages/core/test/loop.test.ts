import { describe, expect, it } from "vitest";
import { CustodyStore, DeliveryLoop } from "../src/index.js";
import { ScriptedTransport, decision, digest, tmpCustodyPath, update } from "./helpers/util.js";

function setup(opts: { backoff?: ConstructorParameters<typeof DeliveryLoop>[0]["backoff"] } = {}) {
  const path = tmpCustodyPath();
  const custody = CustodyStore.open(path);
  const transport = new ScriptedTransport();
  let now = 1_000_000;
  const loop = new DeliveryLoop({ custody, transport, now: () => now, backoff: opts.backoff });
  return { path, custody, transport, loop, advance: (ms: number) => (now += ms) };
}

describe("delivery loop", () => {
  it("moves pending to sent with the transport message id, in custody order", async () => {
    const { custody, transport, loop } = setup();
    custody.accept(decision("d1"), "{}");
    custody.accept(decision("d2"), "{}");
    const report = await loop.tick();
    expect(report.sent).toEqual(["d1", "d2"]);
    expect(custody.get("d1")).toMatchObject({ status: "sent", messageId: "m-1", attempts: 1 });
    expect(custody.get("d2")).toMatchObject({ status: "sent", messageId: "m-2" });
    expect(transport.sends[0]?.recipient).toEqual({ handle: "acme-owner" });
    expect(transport.sends[0]?.rendered.text).toContain("Ref: ");
  });

  it("never resends a sent record, even across many ticks and a restart", async () => {
    const { path, custody, transport, loop } = setup();
    custody.accept(decision("d1"), "{}");
    await loop.tick();
    await loop.tick();
    const reopened = CustodyStore.open(path);
    await new DeliveryLoop({ custody: reopened, transport }).tick();
    expect(transport.sends).toHaveLength(1);
  });

  it("closes an update once it is sent (nothing to answer)", async () => {
    const { custody, loop } = setup();
    custody.accept(update("u1"), "{}");
    await loop.tick();
    expect(custody.get("u1")?.status).toBe("closed");
    custody.accept(digest("g1"), "{}");
    await loop.tick();
    expect(custody.get("g1")?.status).toBe("sent");
  });

  it("retries with bounded exponential backoff and then succeeds", async () => {
    const { custody, transport, loop, advance } = setup({ backoff: { baseMs: 100, maxMs: 350, factor: 2, maxAttempts: 10 } });
    custody.accept(decision("d1"), "{}");
    transport.script = [
      { status: "retry", reason: "offline" },
      { status: "retry", reason: "offline" },
      { status: "retry", reason: "offline" },
      { status: "retry", reason: "offline" },
    ];
    expect((await loop.tick()).retried).toEqual(["d1"]); // attempt 1, wait 100
    advance(99);
    expect((await loop.tick()).retried).toEqual([]);
    advance(1);
    expect((await loop.tick()).retried).toEqual(["d1"]); // attempt 2, wait 200
    advance(199);
    await loop.tick();
    expect(transport.sends).toHaveLength(2);
    advance(1);
    await loop.tick(); // attempt 3, wait min(400, 350) = 350
    advance(349);
    await loop.tick();
    expect(transport.sends).toHaveLength(3);
    advance(1);
    await loop.tick(); // attempt 4, wait 350 (capped)
    expect(loop.backoffDelay(20)).toBe(350);
    advance(350);
    expect((await loop.tick()).sent).toEqual(["d1"]);
    expect(custody.get("d1")).toMatchObject({ status: "sent", attempts: 5 });
    expect(transport.sends.map((s) => s.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it("honours retryAfterMs but never beyond the ceiling", async () => {
    const { custody, transport, loop, advance } = setup({ backoff: { baseMs: 10, maxMs: 1000 } });
    custody.accept(decision("d1"), "{}");
    transport.script = [{ status: "retry", reason: "rate", retryAfterMs: 5_000_000 }];
    await loop.tick();
    advance(999);
    await loop.tick();
    expect(transport.sends).toHaveLength(1);
    advance(1);
    await loop.tick();
    expect(transport.sends).toHaveLength(2);
  });

  it("marks a record failed after maxAttempts and on a permanent failure", async () => {
    const { custody, transport, loop, advance } = setup({ backoff: { baseMs: 1, maxMs: 1, maxAttempts: 2 } });
    custody.accept(decision("d1"), "{}");
    custody.accept(decision("d2"), "{}");
    transport.script = [
      { status: "retry", reason: "x" },
      { status: "failed", reason: "recipient blocked" },
      { status: "retry", reason: "y" },
    ];
    await loop.tick();
    advance(5);
    const report = await loop.tick();
    expect(report.failed).toEqual(["d1"]);
    expect(custody.get("d1")).toMatchObject({ status: "failed", lastError: "y (attempts exhausted)" });
    expect(custody.get("d2")).toMatchObject({ status: "failed", lastError: "recipient blocked" });
    advance(1000);
    await loop.tick();
    expect(transport.sends).toHaveLength(3);
    custody.requeue("d2");
    await loop.tick();
    expect(custody.get("d2")?.status).toBe("sent");
  });

  it("treats a throwing transport as not sent and retries", async () => {
    const { custody, transport, loop, advance } = setup({ backoff: { baseMs: 1 } });
    custody.accept(decision("d1"), "{}");
    let first = true;
    const real = transport.send.bind(transport);
    transport.send = async (...a) => {
      if (first) {
        first = false;
        throw new Error("socket closed");
      }
      return real(...a);
    };
    await loop.tick();
    expect(custody.get("d1")).toMatchObject({ status: "pending", lastError: "socket closed" });
    advance(10);
    await loop.tick();
    expect(custody.get("d1")?.status).toBe("sent");
  });

  it("is restart-safe: a new loop on the same file sends only what is still pending", async () => {
    const { path, custody, transport, loop } = setup();
    custody.accept(decision("d1"), "{}");
    await loop.tick();
    custody.accept(decision("d2"), "{}");
    const reopened = CustodyStore.open(path);
    const t2 = new ScriptedTransport();
    expect((await new DeliveryLoop({ custody: reopened, transport: t2 }).tick()).sent).toEqual(["d2"]);
    expect(transport.sends).toHaveLength(1);
  });

  it("does not run overlapping ticks", async () => {
    const { custody, loop, transport } = setup();
    custody.accept(decision("d1"), "{}");
    await Promise.all([loop.tick(), loop.tick(), loop.tick()]);
    expect(transport.sends).toHaveLength(1);
  });
});
