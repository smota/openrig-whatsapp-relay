import { describe, expect, it } from "vitest";
import { parseOptionReply } from "../src/index.js";

describe("parseOptionReply", () => {
  it("reads digits with trailing punctuation", () => {
    for (const t of ["2", "2.", " 2) ", "2!", "12"]) expect(parseOptionReply(t)).toBe(Number(t.replace(/\D/g, "")));
  });
  it("rejects anything that is not the whole reply", () => {
    for (const t of ["2 please", "option 2", "1 or 2", "", "   ", "123", "0x2", "two things"]) expect(parseOptionReply(t)).toBeNull();
  });
  it("reads number words only for the requested locales and only as the whole reply", () => {
    expect(parseOptionReply("Two.")).toBe(2);
    expect(parseOptionReply("dois")).toBeNull();
    expect(parseOptionReply("Dois.", { locales: ["pt"] })).toBe(2);
    expect(parseOptionReply("três", { locales: ["pt"] })).toBe(3);
    expect(parseOptionReply("tres", { locales: ["pt", "en"] })).toBe(3);
    expect(parseOptionReply("dos", { locales: ["es"] })).toBe(2);
    expect(parseOptionReply("dois e meio", { locales: ["pt"] })).toBeNull();
  });
  it("treats a spoken word with sentence punctuation as a word only when not voice", () => {
    expect(parseOptionReply("Um. Vamos ver", { locales: ["pt"], voice: true })).toBeNull();
    expect(parseOptionReply("Um", { locales: ["pt"], voice: true })).toBe(1);
    expect(parseOptionReply("Um.", { locales: ["pt"], voice: true })).toBeNull();
  });
  it("ignores inherited properties", () => {
    for (const t of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(parseOptionReply(t, { locales: ["en", "pt", "es"] })).toBeNull();
    }
    expect(parseOptionReply("one", { locales: ["constructor", "__proto__"] })).toBeNull();
  });
  it("does not throw on non-strings", () => {
    expect(parseOptionReply(undefined as unknown as string)).toBeNull();
  });
});
