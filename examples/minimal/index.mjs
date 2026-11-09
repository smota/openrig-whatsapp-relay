import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Inject core so the test exercises source while the CLI uses the built package.
export async function runExample({ CustodyStore, createOutboundProcessor, DeliveryLoop, InboundClient }) {
  const directory = mkdtempSync(join(tmpdir(), "relay-example-"));
  try {
    const custody = CustodyStore.open(join(directory, "custody.jsonl"));
    // Public fictional fixture values. Never use these for a real binding.
    const outboundToken = "example-only-outbound";
    const inboundToken = "example-only-inbound";
    const envelope = {
      v: 1,
      deliveryId: "example-delivery",
      recipient: { handle: "example-owner" },
      intent: "decision",
      outcome: "interrupt",
      summary: "Choose the demo outcome",
      body: "The fictional demo is ready.\n- Ship the demo\n- Wait",
      replyRef: "example-question-ref",
    };

    // Stub OpenRig dispatches to the real bridge processor without an HTTP listener.
    const outbound = createOutboundProcessor({ custody, outboundToken });
    const request = { authorization: `Bearer ${outboundToken}`, rawBody: JSON.stringify(envelope) };
    const accepted = outbound.process(request);
    const replayed = outbound.process(request);
    assert.equal(accepted.status, 200);
    assert.equal(replayed.body.deduplicated, true);

    const sent = [];
    const transport = {
      async send(rendered, recipient) {
        sent.push({ text: rendered.text, recipient });
        return { status: "sent", messageId: "example-message" };
      },
    };
    const loop = new DeliveryLoop({ custody, transport });
    await loop.tick();
    await loop.tick();
    assert.equal(sent.length, 1);

    // This fetch-shaped endpoint stays in memory. It never opens a socket.
    const answers = [];
    const gatewayEndpoint = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, "http://127.0.0.1:7433/api/gateway/relay/inbound");
      assert.equal(request.method, "POST");
      if (request.headers.get("authorization") !== `Bearer ${inboundToken}`) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const body = await request.json();
      assert.equal(body.replyRef, envelope.replyRef);
      assert.deepEqual(body.sender, envelope.recipient);
      answers.push(body);
      return Response.json({ ok: true, deduplicated: false });
    };
    const inbound = new InboundClient({
      custody,
      daemonUrl: "http://127.0.0.1:7433",
      inboundToken,
      fetch: gatewayEndpoint,
    });
    const reply = await inbound.reply({
      text: "1",
      quotedMessageId: "example-message",
      senderHandle: "example-owner",
      replyMessageId: "example-reply",
    });
    const status = custody.get(envelope.deliveryId)?.status;
    assert.equal(reply.kind, "accepted");
    assert.equal(answers[0]?.text, "1. Ship the demo");
    assert.equal(status, "answered");
    return { accepted, replayed, sent, reply, answers, status };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
