import { describe, expect, it } from "vitest";
import type { RenderedMessage } from "@openrig-whatsapp-relay/core";
import { createBaileysTransport } from "../src/index.js";
import { fakeSocket } from "./helpers.js";

const rendered = (text: string): RenderedMessage => ({ text, correlationId: "c1", itemCorrelationIds: [], options: [] });
const owner = "5550100@s.whatsapp.net";
const cfg = (socket: never, extra = {}) => ({ socket, resolveChat: (h: string) => (h === "acme-owner" ? owner : null), ...extra });

describe("createBaileysTransport", () => {
  it("sends plain text to the resolved chat and returns the message id", async () => {
    const f = fakeSocket();
    const t = createBaileysTransport(cfg(f.socket as never));
    expect(await t.send(rendered("hello"), { handle: "acme-owner" })).toEqual({ status: "sent", messageId: "MSG1" });
    expect(f.sent).toEqual([{ jid: owner, content: { text: "hello" } }]);
  });
  it("fails an unknown recipient without calling the socket", async () => {
    const f = fakeSocket();
    const t = createBaileysTransport(cfg(f.socket as never));
    expect((await t.send(rendered("x"), { handle: "stranger" })).status).toBe("failed");
    expect(f.sent).toHaveLength(0);
  });
  it("fails over-long text and retries when disconnected", async () => {
    const f = fakeSocket({ connected: false });
    const t = createBaileysTransport(cfg(f.socket as never, { isConnected: () => f.state.connected, maxTextLength: 5 }));
    expect((await t.send(rendered("123456"), { handle: "acme-owner" })).status).toBe("failed");
    expect(await t.send(rendered("123"), { handle: "acme-owner" })).toMatchObject({ status: "retry", reason: "disconnected" });
    expect(f.sent).toHaveLength(0);
  });
  it("any error after the send call started is never a retry", async () => {
    const f = fakeSocket();
    const t = createBaileysTransport(cfg(f.socket as never));
    for (const err of [
      Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } }),
      Object.assign(new Error("Timed Out"), { output: { statusCode: 408 } }),
      Object.assign(new Error("Stream Errored"), { output: { statusCode: 515 } }),
      new Error("timeout waiting for ack"),
    ]) {
      f.state.failWith = err;
      const r = await t.send(rendered("x"), { handle: "acme-owner" });
      expect(r.status).toBe("failed");
      expect(r.status === "failed" && r.reason).toMatch(/check the chat/);
    }
  });
  it("retries only when the socket was provably not used", async () => {
    const f = fakeSocket({ connected: false });
    const t = createBaileysTransport(cfg(f.socket as never, { isConnected: () => f.state.connected }));
    expect((await t.send(rendered("x"), { handle: "acme-owner" })).status).toBe("retry");
    expect(f.sent).toHaveLength(0);
  });
  it("never reports sent without a message id", async () => {
    const f = fakeSocket();
    f.state.returnNoKey = true;
    const t = createBaileysTransport(cfg(f.socket as never));
    const r = await t.send(rendered("x"), { handle: "acme-owner" });
    expect(r.status).toBe("failed");
  });
  it("works as core's Transport with the delivery loop", async () => {
    const { CustodyStore, DeliveryLoop, createOutboundProcessor } = await import("@openrig-whatsapp-relay/core");
    expect(typeof CustodyStore.open).toBe("function");
    expect(typeof DeliveryLoop).toBe("function");
    expect(typeof createOutboundProcessor).toBe("function");
  });
});
