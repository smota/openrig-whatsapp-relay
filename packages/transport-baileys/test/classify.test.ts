import { describe, expect, it } from "vitest";
import { authorizeSender, classifyReply, normalizeIdentity } from "../src/index.js";

const owner = "5550100@s.whatsapp.net";
const ownerLid = "9990100@lid";
const relayIds = new Set(["R1"]);
const isRelay = (id: string) => relayIds.has(id);
const sender = { authorized: true, senderId: owner };

describe("normalizeIdentity", () => {
  it("strips the device suffix and lowercases", () => {
    expect(normalizeIdentity("5550100:12@S.whatsapp.net")).toBe(owner);
    expect(normalizeIdentity("9990100:3@lid")).toBe(ownerLid);
  });
  it("rejects display names, groups and junk", () => {
    for (const v of ["Acme Owner", "123@g.us", "", undefined, 5, "a@b"]) expect(normalizeIdentity(v as never)).toBeNull();
  });
});

describe("classifyReply", () => {
  const owners = [owner];
  it("is default when the relay is off, nothing is quoted, or the quote is not a relay message", () => {
    expect(classifyReply({ chat: owner, quotedId: "R1", sender }, null, isRelay)).toEqual({ route: "default" });
    expect(classifyReply({ chat: owner, quotedId: null, sender }, { owners }, isRelay)).toEqual({ route: "default" });
    expect(classifyReply({ chat: owner, quotedId: "X", sender }, { owners }, isRelay)).toEqual({ route: "default" });
  });
  it("routes an owner reply to a relay message", () => {
    expect(classifyReply({ chat: owner, quotedId: "R1", sender }, { owners }, isRelay)).toEqual({ route: "relay" });
  });
  it("accepts the LID form of the same person through the alt fields", () => {
    const cfg = { owners: [owner] };
    expect(classifyReply({ chat: ownerLid, chatAlt: owner, quotedId: "R1", sender: { authorized: true, senderId: ownerLid }, senderAlt: owner }, cfg, isRelay)).toEqual({ route: "relay" });
    expect(classifyReply({ chat: ownerLid, quotedId: "R1", sender: { authorized: true, senderId: ownerLid } }, { owners: [ownerLid] }, isRelay)).toEqual({ route: "relay" });
  });
  it("refuses the wrong chat", () => {
    expect(classifyReply({ chat: "5550999@s.whatsapp.net", quotedId: "R1", sender }, { owners }, isRelay)).toEqual({ route: "refused", reason: "relay_wrong_chat" });
    expect(classifyReply({ chat: "120363@g.us", quotedId: "R1", sender }, { owners }, isRelay)).toEqual({ route: "refused", reason: "relay_wrong_chat" });
  });
  it("refuses an unauthorized or different sender in the right chat", () => {
    expect(classifyReply({ chat: owner, quotedId: "R1", sender: { authorized: false, senderId: null } }, { owners }, isRelay)).toEqual({ route: "refused", reason: "relay_unauthorized" });
    expect(classifyReply({ chat: owner, quotedId: "R1", sender: { authorized: true, senderId: "5550999@s.whatsapp.net" } }, { owners }, isRelay)).toEqual({ route: "refused", reason: "relay_unauthorized" });
  });
  it("refuses media", () => {
    expect(classifyReply({ chat: owner, quotedId: "R1", sender, isMedia: true }, { owners }, isRelay)).toEqual({ route: "refused", reason: "relay_unsupported_media" });
  });
  it("fails closed on an empty or malformed owner list", () => {
    expect(classifyReply({ chat: owner, quotedId: "R1", sender }, { owners: [] }, isRelay)).toEqual({ route: "refused", reason: "relay_wrong_chat" });
    expect(classifyReply({ chat: owner, quotedId: "R1", sender }, { owners: ["nonsense"] }, isRelay)).toEqual({ route: "refused", reason: "relay_wrong_chat" });
  });
});

describe("authorizeSender", () => {
  const paired = "100:7@s.whatsapp.net";
  it("defaults to the paired account only", () => {
    expect(authorizeSender({ fromMe: true }, paired)).toEqual({ authorized: true, senderId: "100@s.whatsapp.net" });
    expect(authorizeSender({ participant: owner }, paired)).toEqual({ authorized: false, senderId: null });
  });
  it("accepts a configured owner by participant or participantAlt, never a display name", () => {
    expect(authorizeSender({ participant: ownerLid, participantAlt: owner }, paired, [owner])).toEqual({ authorized: true, senderId: owner });
    expect(authorizeSender({ participant: "Acme Owner" }, paired, [owner]).authorized).toBe(false);
  });
  it("uses the chat identity in a direct chat", () => {
    expect(authorizeSender({ remoteJid: owner }, paired, [owner])).toEqual({ authorized: true, senderId: owner });
    expect(authorizeSender({ remoteJid: "120363@g.us" }, paired, [owner]).authorized).toBe(false);
  });
  it("a configured but malformed list fails closed instead of widening", () => {
    expect(authorizeSender({ fromMe: true }, paired, ["junk"]).authorized).toBe(false);
  });
});
