import { describe, expect, it } from "vitest";
import { CustodyStore, extractOptions, render } from "../src/index.js";
import { decision, digest, tmpCustodyPath, update } from "./helpers/util.js";

const rec = (env: Parameters<CustodyStore["accept"]>[0]) => {
  const s = CustodyStore.open(tmpCustodyPath());
  s.accept(env, "{}");
  return s.get(env.deliveryId)!;
};

describe("render", () => {
  it("renders a decision with summary, body, numbered options and a Ref footer", () => {
    const r = rec(decision("d1"));
    const out = render(r);
    expect(out.options).toEqual(["Ship now", "Wait one day", "Cancel"]);
    expect(out.text).toBe(
      [
        "Approve the acme rollout",
        "The rollout is ready.\n1. Ship now\n2. Wait one day\n3. Cancel",
        "Quote this message and reply with an option number or your own text.",
        `Ref: ${out.correlationId}`,
      ].join("\n\n"),
    );
    expect(out.text.split("\n").at(-1)).toMatch(/^Ref: [0-9a-z]{6}$/);
  });

  it("keeps a decision without a list as plain text", () => {
    const out = render(rec(decision("d1", { body: "Should we proceed?" })));
    expect(out.options).toEqual([]);
    expect(out.text).toContain("Should we proceed?\n\nQuote this message to reply.");
  });

  it("does not repeat a summary whose overflow already starts the body", () => {
    const summary = "S".repeat(50);
    const out = render(rec(decision("d1", { summary, body: `${summary} and the rest` })));
    expect(out.text.startsWith(`${summary} and the rest`)).toBe(true);
    expect(out.text.match(/S{50}/g)).toHaveLength(1);
  });

  it("renders an update without reply instructions", () => {
    const out = render(rec(update("u1")));
    expect(out.text).toBe(`Approve the acme rollout\n\nFYI: the job finished.\n\nRef: ${out.correlationId}`);
  });

  it("renders a digest as a list with item codes only where an answer is possible", () => {
    const r = rec(digest("g1"));
    const out = render(r);
    const [c1, , c3] = [0, 1, 2].map((i) => r.correlations.find((c) => c.itemIndex === i)?.id);
    expect(out.itemCorrelationIds).toEqual([c1, c3]);
    expect(out.text).toContain(`1. [${c1}] Pick a color\n   red or blue`);
    expect(out.text).toContain("2. FYI only");
    expect(out.text).not.toContain("2. [");
    expect(out.text).toContain(`3. [${c3}] Pick a size`);
    expect(out.text.endsWith(`Ref: ${out.correlationId}`)).toBe(true);
  });

  it("extractOptions handles dash, star, number and paren markers and ignores single bullets", () => {
    expect(extractOptions("a\n* x\n* y").options).toEqual(["x", "y"]);
    expect(extractOptions("1) one\n2) two\nend").text).toBe("1. one\n2. two\nend");
    expect(extractOptions("only\n- one\nmore").options).toEqual([]);
  });

  it("is deterministic", () => {
    const r = rec(decision("d1"));
    expect(render(r)).toEqual(render(r));
  });
});
