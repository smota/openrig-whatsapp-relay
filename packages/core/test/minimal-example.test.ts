import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as core from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

it("runs the minimal bridge round trip without network access", async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network access is forbidden"); }));
  const exampleUrl = new URL("../../../examples/minimal/index.mjs", import.meta.url);
  expect(existsSync(fileURLToPath(exampleUrl)), "minimal example entry point exists").toBe(true);
  const { runExample } = await import(exampleUrl.href);
  const result = await runExample(core);

  expect(result.accepted.status).toBe(200);
  expect(result.replayed.body.deduplicated).toBe(true);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].recipient).toEqual({ handle: "example-owner" });
  expect(result.sent[0].text).toContain("1. Ship the demo");
  expect(result.sent[0].text).toContain("Ref: ");
  expect(result.reply.kind).toBe("accepted");
  expect(result.answers).toEqual([expect.objectContaining({
    sender: { handle: "example-owner" },
    replyRef: "example-question-ref",
    text: "1. Ship the demo",
    ordering: "after-question",
  })]);
  expect(result.status).toBe("answered");
  expect(fetch).not.toHaveBeenCalled();
});
