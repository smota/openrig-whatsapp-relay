import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CONTRACT_PIN, CONTRACT_VERSION } from "../src/index.js";

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

it("keeps declared Gateway Relay compatibility aligned with the implementation", () => {
  const compat = readJson("../../../openrig-compat.json");
  expect(compat.gatewayRelayContractVersion).toBe(CONTRACT_VERSION);
  expect(compat.tested).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "pinned", commit: expect.stringMatching(/^[a-f0-9]{40}$/) }),
  ]));
  const pinned = compat.tested.find((entry: { role: string }) => entry.role === "pinned");
  expect(pinned.commit.startsWith(CONTRACT_PIN)).toBe(true);
  expect(compat.openrigCommitRange).toEqual({ from: pinned.commit, to: pinned.commit, inclusive: true });
  for (const manifest of ["../../../package.json", "../package.json", "../../transport-baileys/package.json"]) {
    expect(compat.repoVersion, manifest).toBe(readJson(manifest).version);
  }
});
