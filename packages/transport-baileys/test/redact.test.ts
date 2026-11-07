import { describe, expect, it } from "vitest";
import { carriesKeyMaterial, installLibsignalLogRedaction, redactConsoleArgs, redactText } from "../src/index.js";

describe("redactText", () => {
  it("masks JIDs, phone numbers and bearer tokens", () => {
    const out = redactText("to 5550100123@s.whatsapp.net or +1 555 010 0123, Bearer abc.DEF-123_x, lid 9990100:3@lid");
    expect(out).not.toMatch(/5550100123|555 010 0123|abc\.DEF|9990100/);
    expect(out).toContain("[jid]");
    expect(out).toContain("[phone]");
    expect(out).toContain("Bearer [redacted]");
  });
  it("masks phone numbers with any common separator", () => {
    for (const p of ["+1.555.010.0000", "(555) 010-0000", "+1 555 010 0000", "555/010/0000", "+1-555-010-0000", "+1 (555) 010.0000"]) {
      const out = redactText(`call ${p} now`);
      expect(out, p).toBe("call [phone] now");
    }
  });
  it("leaves ordinary text and short numbers alone", () => {
    expect(redactText("attempt 3 of 8 for delivery d-1")).toBe("attempt 3 of 8 for delivery d-1");
  });
  it("truncates when asked", () => {
    expect(redactText("x".repeat(50), { max: 10 })).toBe("xxxxxxxxxx...");
  });
});

describe("libsignal console redaction", () => {
  it("replaces session dumps and key material", () => {
    expect(redactConsoleArgs(["Closing session:", { rootKey: Buffer.from("k") }])).toEqual(["[relay] libsignal: closing session (redacted)"]);
    expect(redactConsoleArgs(["x", { a: { chainKey: 1 } }])).toEqual(["x", "[redacted key material]"]);
    const plain = ["hello", { a: 1 }];
    expect(redactConsoleArgs(plain)).toBe(plain);
    expect(carriesKeyMaterial(new Error("e"))).toBe(false);
  });
  it("installs once and restores", () => {
    const calls: unknown[][] = [];
    const target = { info: (...a: unknown[]) => void calls.push(a) } as unknown as Console;
    const restore = installLibsignalLogRedaction(target);
    expect(installLibsignalLogRedaction(target)).toBe(restore);
    target.info("Opening session:", { rootKey: 1 });
    restore();
    target.info("Opening session:", { rootKey: 1 });
    expect(calls[0]).toEqual(["[relay] libsignal: opening session (redacted)"]);
    expect(calls[1]).toEqual(["Opening session:", { rootKey: 1 }]);
  });
});
