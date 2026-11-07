import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustodyStore, InboundClient, type ReplyResult } from "../src/index.js";
import { startFakeDaemon, type FakeDaemon } from "./helpers/fake-daemon.js";
import { IN, decision, digest, tmpCustodyPath, update } from "./helpers/util.js";

let daemon: FakeDaemon;
beforeEach(async () => {
  daemon = await startFakeDaemon({ inboundToken: IN, handles: ["acme-owner"] });
});
afterEach(async () => daemon.stop());

function setup() {
  const path = tmpCustodyPath();
  const custody = CustodyStore.open(path);
  const client = new InboundClient({ custody, daemonUrl: daemon.baseUrl, inboundToken: IN });
  const give = (env: ReturnType<typeof decision>, messageId: string) => {
    custody.accept(env, "{}");
    custody.markSending(env.deliveryId);
    custody.markSent(env.deliveryId, messageId);
    for (const c of custody.get(env.deliveryId)!.correlations) if (c.replyRef) daemon.registerQuestion(c.replyRef);
  };
  return { path, custody, client, give };
}
const reply = (over: Partial<Parameters<InboundClient["reply"]>[0]> = {}) => ({
  text: "Go ahead, ship it.",
  quotedMessageId: "wa-1",
  senderHandle: "acme-owner",
  replyMessageId: "wa-r1",
  ...over,
});

describe("inbound client", () => {
  it("posts a quoted reply with the inbound bearer and marks the delivery answered", async () => {
    const { custody, client, give } = setup();
    give(decision("d1"), "wa-1");
    const res = await client.reply(reply());
    expect(res).toMatchObject({ kind: "accepted", deduplicated: false, eventId: expect.stringMatching(/^evt-wa-r1-[0-9a-f]{32}$/) });
    expect(daemon.answers).toEqual([
      { eventId: expect.stringMatching(/^evt-wa-r1-/), replyRef: "ref-d1", text: "Go ahead, ship it.", handle: "acme-owner", ordering: "after-question" },
    ]);
    expect(custody.get("d1")?.status).toBe("answered");
  });

  it("uses the inbound token, not the outbound one", async () => {
    const { custody, give } = setup();
    give(decision("d1"), "wa-1");
    const bad = new InboundClient({ custody, daemonUrl: daemon.baseUrl, inboundToken: "wrong" });
    expect(await bad.reply(reply())).toEqual({ kind: "rejected", status: 401, reason: "unauthorized" });
    expect(custody.get("d1")?.status).toBe("sent"); // nothing changed
  });

  it("never treats free text as an approval: 'yes' is posted verbatim, unquoted text is not posted", async () => {
    const { client, give } = setup();
    give(decision("d1"), "wa-1");
    expect(await client.reply(reply({ text: "yes", quotedMessageId: "not-a-relay-message" }))).toEqual({ kind: "unmatched" });
    expect(daemon.inboundRequests).toBe(0);
    await client.reply(reply({ text: "yes" }));
    expect(daemon.answers[0]?.text).toBe("yes");
    expect(Object.keys(daemon.answers[0]!).sort()).toEqual(["eventId", "handle", "ordering", "replyRef", "text"]);
  });

  it("maps an option number to its label and leaves other numbers as text", async () => {
    const { client, give } = setup();
    give(decision("d1"), "wa-1");
    const res = (await client.reply(reply({ text: " 2 " }))) as Extract<ReplyResult, { kind: "accepted" }>;
    expect(res.mappedOption).toBe(2);
    expect(daemon.answers[0]?.text).toBe("2. Wait one day");

    give(decision("d2", { replyRef: "ref-d2" }), "wa-2");
    await client.reply(reply({ text: "9", quotedMessageId: "wa-2", replyMessageId: "wa-r2" }));
    expect(daemon.answers[1]?.text).toBe("9");
  });

  it("handles 409 by marking closed and telling the caller; later replies are not posted", async () => {
    const { custody, client, give } = setup();
    give(decision("d1"), "wa-1");
    daemon.setQuestionState("ref-d1", "cancelled");
    expect(await client.reply(reply())).toMatchObject({ kind: "closed", reason: "decision_revision_changed", deliveryId: "d1" });
    expect(custody.get("d1")?.status).toBe("closed");
    expect(custody.get("d1")?.correlations[0]).toMatchObject({ status: "closed", reason: "decision_revision_changed" });
    const before = daemon.inboundRequests;
    expect(await client.reply(reply({ replyMessageId: "wa-r2" }))).toMatchObject({ kind: "closed", reason: "decision_revision_changed" });
    expect(daemon.inboundRequests).toBe(before);
  });

  it("reports event_conflict (409) without closing the question", async () => {
    const { custody, client, give } = setup();
    give(decision("d1"), "wa-1");
    give(decision("d2", { replyRef: "ref-d2" }), "wa-2");
    await client.reply(reply());
    // the same transport reply id reused on another delivery: the daemon calls it a conflict
    const res = await client.reply(reply({ quotedMessageId: "wa-2", text: "different" }));
    expect(res).toEqual({ kind: "rejected", status: 409, reason: "event_conflict" });
    expect(custody.get("d2")?.status).toBe("sent");
  });

  it.each(["reply_not_allowed_for_update", "unrecognized_reply_ref", "decision_revision_changed", "qitem_already_terminal", "qitem_not_leg1_parked"])(
    "closes the question for the stale-question 409 %s",
    async (code) => {
      const { custody, client, give } = setup();
      give(decision("d1"), "wa-1");
      daemon.forceConflict = code;
      expect(await client.reply(reply())).toMatchObject({ kind: "closed", reason: code });
      expect(custody.get("d1")?.status).toBe("closed");
    },
  );

  it("does not close the question for an unknown 409 code", async () => {
    const { custody, client, give } = setup();
    give(decision("d1"), "wa-1");
    daemon.forceConflict = "something_new";
    expect(await client.reply(reply())).toEqual({ kind: "rejected", status: 409, reason: "something_new" });
    expect(custody.get("d1")?.status).toBe("sent");
  });

  it("gives distinct transport reply ids distinct eventIds even when sanitizing would collide", async () => {
    const { client, give } = setup();
    give(decision("d1"), "wa-1");
    give(decision("d2", { replyRef: "ref-d2" }), "wa-2");
    const a = (await client.reply(reply({ replyMessageId: "ab/cd", text: "one" }))) as { eventId: string };
    const b = (await client.reply(reply({ quotedMessageId: "wa-2", replyMessageId: "ab*cd", text: "one" }))) as { eventId: string };
    expect(a.eventId).not.toBe(b.eventId);
    expect(b).toMatchObject({ kind: "accepted" });
    const long = "x".repeat(300);
    const l1 = await client.reply(reply({ replyMessageId: `${long}1` }));
    expect(l1).toMatchObject({ kind: "closed" }); // d1 already answered
    expect(a.eventId).toMatch(/^evt-[A-Za-z0-9._:-]{1,252}$/);
  });

  it("handles 503 as retry later with the same eventId, then succeeds", async () => {
    const { custody, client, give } = setup();
    give(decision("d1"), "wa-1");
    daemon.unavailable = "seen_store_unavailable";
    const first = await client.reply(reply({ replyMessageId: undefined }));
    expect(first).toMatchObject({ kind: "retry", status: 503, reason: "seen_store_unavailable" });
    expect(custody.get("d1")?.status).toBe("sent"); // still open
    daemon.unavailable = null;
    const second = await client.reply(reply({ replyMessageId: undefined }));
    expect(second).toMatchObject({ kind: "accepted" });
    expect((first as { eventId: string }).eventId).toBe((second as { eventId: string }).eventId);
    expect(daemon.answers).toHaveLength(1);
  });

  it("treats a connection failure as retry", async () => {
    const { custody, give } = setup();
    give(decision("d1"), "wa-1");
    const dead = new InboundClient({ custody, daemonUrl: "http://127.0.0.1:9", inboundToken: IN, timeoutMs: 500 });
    expect(await dead.reply(reply())).toMatchObject({ kind: "retry", status: 0, reason: "network_error" });
  });

  it("rejects without posting: sender mismatch, bad handle, empty or NUL text", async () => {
    const { client, give } = setup();
    give(decision("d1"), "wa-1");
    expect(await client.reply(reply({ senderHandle: "someone-else" }))).toEqual({ kind: "rejected", reason: "sender_mismatch" });
    expect(await client.reply(reply({ senderHandle: "bad handle" }))).toEqual({ kind: "rejected", reason: "invalid_sender_handle" });
    expect(await client.reply(reply({ text: "  " }))).toEqual({ kind: "rejected", reason: "invalid_text" });
    expect(await client.reply(reply({ text: "a\0b" }))).toEqual({ kind: "rejected", reason: "invalid_text" });
    expect(await client.reply(reply({ text: "x".repeat(32_769) }))).toEqual({ kind: "rejected", reason: "invalid_text" });
    expect(daemon.inboundRequests).toBe(0);
  });

  it("surfaces 403 from the daemon as rejected without changing custody", async () => {
    const path = tmpCustodyPath();
    const custody = CustodyStore.open(path);
    const strict = await startFakeDaemon({ inboundToken: IN, handles: ["someone-registered"] });
    custody.accept(decision("d1"), "{}");
    custody.markSending("d1");
    custody.markSent("d1", "wa-1");
    strict.registerQuestion("ref-d1");
    const client = new InboundClient({ custody, daemonUrl: strict.baseUrl, inboundToken: IN });
    expect(await client.reply(reply())).toMatchObject({ kind: "rejected", status: 403, reason: "unregistered_handle" });
    expect(custody.get("d1")?.status).toBe("sent");
    await strict.stop();
  });

  it("does not answer an informational update", async () => {
    const { client, give } = setup();
    give(update("u1"), "wa-1");
    expect(await client.reply(reply())).toMatchObject({ kind: "closed", reason: "informational" });
    expect(daemon.inboundRequests).toBe(0);
  });

  it("answers a digest item named by its code, and asks which item when it is not named", async () => {
    const { custody, client, give } = setup();
    give(digest("g1"), "wa-1");
    const [c1, c3] = [1, 3].map((n) => custody.get("g1")!.correlations.find((c) => c.itemIndex === n - 1)!.id);
    const amb = await client.reply(reply({ text: "blue" }));
    expect(amb).toEqual({ kind: "ambiguous", correlationIds: [c1, c3] });
    expect(daemon.inboundRequests).toBe(0);

    const res = await client.reply(reply({ text: `[${c3}] large please` }));
    expect(res).toMatchObject({ kind: "accepted", correlationId: c3 });
    expect(daemon.answers[0]).toMatchObject({ replyRef: "ref-g1-3", text: "large please" });
    expect(custody.get("g1")?.status).toBe("sent"); // item 1 still open
    await client.reply(reply({ text: `${c1}: red`, replyMessageId: "wa-r2" }));
    expect(custody.get("g1")?.status).toBe("answered");
  });

  it("keeps working after a restart: correlations and message ids come from custody", async () => {
    const { path, client, give } = setup();
    give(decision("d1"), "wa-1");
    void client;
    const reopened = CustodyStore.open(path);
    const c2 = new InboundClient({ custody: reopened, daemonUrl: daemon.baseUrl, inboundToken: IN });
    expect(await c2.reply(reply())).toMatchObject({ kind: "accepted" });
    expect(CustodyStore.open(path).get("d1")?.status).toBe("answered");
  });

  it("refuses non-loopback or credentialed daemon URLs", () => {
    const custody = CustodyStore.open(tmpCustodyPath());
    for (const url of ["http://example.com", "https://127.0.0.1", "http://u:p@127.0.0.1:1", "http://10.0.0.5"]) {
      expect(() => new InboundClient({ custody, daemonUrl: url, inboundToken: IN })).toThrow(/loopback/);
    }
    expect(() => new InboundClient({ custody, daemonUrl: "http://[::1]:7433", inboundToken: IN })).not.toThrow();
  });
});
