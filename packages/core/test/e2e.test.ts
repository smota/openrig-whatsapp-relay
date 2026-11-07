import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CustodyStore, DeliveryLoop, InboundClient, createOutboundHandler } from "../src/index.js";
import { startFakeDaemon, type FakeDaemon } from "./helpers/fake-daemon.js";
import { IN, OUT, ScriptedTransport, decision, tmpCustodyPath, update } from "./helpers/util.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** A bridge: real HTTP server around the real handler, rebuilt from the custody file on restart. */
class Bridge {
  server!: Server;
  custody!: CustodyStore;
  port = 0;
  /** Simulate a lost ACK: the work is done (custody durable) but the daemon sees a 502. */
  loseNextAck = false;
  constructor(private readonly path: string) {}

  async start(): Promise<void> {
    this.custody = CustodyStore.open(this.path);
    const handler = createOutboundHandler({ custody: this.custody, outboundToken: OUT });
    this.server = createServer((req, res) => {
      if (!this.loseNextAck) return void handler(req, res);
      this.loseNextAck = false;
      const fake = {
        writeHead: () => fake,
        end: () => {
          res.writeHead(502);
          res.end("{}");
        },
      };
      void handler(req, fake as never);
    });
    await new Promise<void>((r) => this.server.listen(this.port, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}/outbound`;
  }
}

async function world() {
  const daemon: FakeDaemon = await startFakeDaemon({ inboundToken: IN, handles: ["acme-owner"] });
  const bridge = new Bridge(tmpCustodyPath());
  await bridge.start();
  closers.push(() => daemon.stop(), () => bridge.stop().catch(() => {}));
  return { daemon, bridge };
}

describe("daemon <-> bridge round trip", () => {
  it("delivers, renders, sends, takes the human's quoted reply and closes the question", async () => {
    const { daemon, bridge } = await world();
    const env = decision("dec-1");
    daemon.registerQuestion(env.replyRef!);
    expect(await daemon.dispatch(bridge.url, OUT, env)).toBe(200);
    expect(daemon.pendingCount()).toBe(0);

    const transport = new ScriptedTransport();
    await new DeliveryLoop({ custody: bridge.custody, transport }).tick();
    expect(transport.sends[0]?.rendered.text).toContain("Ref: ");

    const client = new InboundClient({ custody: bridge.custody, daemonUrl: daemon.baseUrl, inboundToken: IN });
    const res = await client.reply({ text: "1", quotedMessageId: "m-1", senderHandle: "acme-owner", replyMessageId: "r-1" });
    expect(res.kind).toBe("accepted");
    expect(daemon.answers[0]?.text).toBe("1. Ship now");
    expect(bridge.custody.get("dec-1")?.status).toBe("answered");
  });

  it("lost ACK: the daemon replays the frozen bytes and gets a deduplicated 200, no second custody or send", async () => {
    const { daemon, bridge } = await world();
    bridge.loseNextAck = true;
    const env = decision("dec-1");
    expect(await daemon.dispatch(bridge.url, OUT, env)).toBe(502);
    expect(daemon.pendingCount()).toBe(1); // not drained on a non-2xx
    expect(bridge.custody.list()).toHaveLength(1); // but custody is already durable

    expect(await daemon.replayPending(bridge.url, OUT)).toEqual([200]);
    expect(daemon.pendingCount()).toBe(0);
    expect(bridge.custody.list()).toHaveLength(1);
    const transport = new ScriptedTransport();
    await new DeliveryLoop({ custody: bridge.custody, transport }).tick();
    expect(transport.sends).toHaveLength(1);
  });

  it("bridge restart: replay after restart deduplicates against the custody file and never resends", async () => {
    const { daemon, bridge } = await world();
    const env = decision("dec-1");
    expect(await daemon.dispatch(bridge.url, OUT, env)).toBe(200);
    const transport = new ScriptedTransport();
    await new DeliveryLoop({ custody: bridge.custody, transport }).tick();

    await bridge.stop();
    await bridge.start(); // same port, new process state loaded from disk
    // the daemon, not knowing, replays the same bytes
    await daemon.dispatch(bridge.url, OUT, env);
    const again = await daemon.dispatch(bridge.url, OUT, env);
    expect(again).toBe(200);
    expect(bridge.custody.list()).toHaveLength(1);
    await new DeliveryLoop({ custody: bridge.custody, transport }).tick();
    expect(transport.sends).toHaveLength(1);
    expect(bridge.custody.get("dec-1")?.status).toBe("sent");
  });

  it("bridge down: the daemon keeps the envelope buffered and delivers on replay", async () => {
    const { daemon, bridge } = await world();
    await bridge.stop();
    expect(await daemon.dispatch(bridge.url, OUT, decision("dec-1"))).toBe(0);
    expect(daemon.pendingCount()).toBe(1);
    await bridge.start();
    expect(await daemon.replayPending(bridge.url, OUT)).toEqual([200]);
    expect(bridge.custody.get("dec-1")?.status).toBe("pending");
  });

  it("a different payload under a used deliveryId gets 409 and the daemon keeps it buffered", async () => {
    const { daemon, bridge } = await world();
    await daemon.dispatch(bridge.url, OUT, decision("dec-1"));
    expect(await daemon.dispatch(bridge.url, OUT, { ...decision("dec-1"), body: "changed" })).toBe(409);
    expect(daemon.pendingCount()).toBe(1);
    expect(bridge.custody.get("dec-1")?.envelope.body).not.toBe("changed");
  });

  it("an update flows through and closes without any inbound traffic", async () => {
    const { daemon, bridge } = await world();
    expect(await daemon.dispatch(bridge.url, OUT, update("u-1"))).toBe(200);
    await new DeliveryLoop({ custody: bridge.custody, transport: new ScriptedTransport() }).tick();
    expect(bridge.custody.get("u-1")?.status).toBe("closed");
    expect(daemon.inboundRequests).toBe(0);
  });
});
