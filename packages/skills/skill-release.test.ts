import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error Release tooling is intentionally plain Node.js.
import { buildPackage, contractFingerprint, digest, mergeRelease, updateCompatibility, signIndex, verifyIndex, compareVersions, zip } from "../../scripts/skill-release.mjs";

describe("signed Skill release tooling", () => {
  it("packages all five Skills deterministically with matching manifest hashes", () => {
    const a = buildPackage(), b = buildPackage();
    expect(a.archive.equals(b.archive)).toBe(true); expect(a.manifest).toEqual(b.manifest);
    expect(a.manifest.skills).toHaveLength(5); expect(a.manifest.sha256).toBe(digest(a.archive));
    expect(contractFingerprint("a\r\nb")).toBe(contractFingerprint("a\nb"));
    expect(a.archive.readUInt32LE(0)).toBe(0x04034b50);
  });
  it("sorts ZIP entries independently of caller order", () => {
    const a = { name: "a", data: Buffer.from("a") }, b = { name: "b", data: Buffer.from("b") };
    expect(zip([a, b]).equals(zip([b, a]))).toBe(true);
  });
  it("signs and verifies only the pinned key and rejects tampering", () => {
    const pair = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
    const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    const pinned = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    const index = { schemaVersion: 1, packages: [buildPackage().manifest] };
    const bytes = signIndex(index, pem, pinned); expect(verifyIndex(bytes, pinned)).toEqual(index);
    const envelope = JSON.parse(bytes.toString()); envelope.payload = Buffer.from("{}").toString("base64");
    expect(() => verifyIndex(Buffer.from(JSON.stringify(envelope)), pinned)).toThrow();
    expect(() => signIndex(index, other.privateKey.export({ type: "pkcs8", format: "pem" }), pinned)).toThrow();
    expect(() => signIndex(index, pem, "")).toThrow();
  });
  it("preserves historical and revoked packages and rejects changed same-version assets", () => {
    const p = buildPackage().manifest, index = { schemaVersion: 1, packages: [{ ...p, revoked: true }] };
    expect(mergeRelease(index, p).packages[0].revoked).toBe(true);
    expect(() => mergeRelease(index, { ...p, sha256: "different" })).toThrow();
    expect(mergeRelease(index, { ...p, version: "0.1.2" }).packages).toHaveLength(2);
  });
  it("changes only compatibility and preserves history, revocation and immutable content", () => {
    const p = buildPackage().manifest;
    const index = { schemaVersion: 1, packages: [{ ...p, revoked: true }, { ...p, version: "0.1.0" }] };
    const compatibility = { minAppVersion: "0.2.1-beta.2", maxAppVersion: "0.2.1-beta.4", supportedContracts: [digest(Buffer.from("verified older MCP")), ...p.supportedContracts] };
    const updated = updateCompatibility(index, p.version, compatibility);
    expect(updated.packages[0]).toEqual({ ...index.packages[0], ...compatibility });
    expect(updated.packages[1]).toEqual(index.packages[1]);
    expect(index.packages[0].maxAppVersion).not.toBe(compatibility.maxAppVersion);
    expect(mergeRelease(updated, p)).toEqual(updated);
    for (const patch of [{ url: "https://example.com/other.zip" }, { sha256: digest(Buffer.from("other ZIP")) }, { skills: p.skills.map((s: { hash: string }) => ({ ...s, hash: digest(Buffer.from("other Skill")) })) }]) {
      expect(() => mergeRelease(updated, { ...p, ...patch })).toThrow("different content");
    }
  });
  it("rejects unknown versions, invalid ranges, implicit fingerprints and content edits", () => {
    const p = buildPackage().manifest, index = { schemaVersion: 1, packages: [p] };
    const compatibility = { minAppVersion: p.minAppVersion, maxAppVersion: p.maxAppVersion, supportedContracts: p.supportedContracts };
    expect(() => updateCompatibility(index, "9.9.9", compatibility)).toThrow("unknown");
    expect(() => updateCompatibility(index, p.version, { ...compatibility, maxAppVersion: compatibility.minAppVersion })).toThrow("range");
    expect(() => updateCompatibility(index, p.version, { ...compatibility, supportedContracts: ["current"] })).toThrow("explicit");
    expect(() => updateCompatibility(index, p.version, { ...compatibility, supportedContracts: [] })).toThrow();
    expect(() => updateCompatibility(index, p.version, { ...compatibility, sha256: "changed" })).toThrow("Only compatibility");
  });
  it("orders prereleases exactly like SemVer compatibility bounds", () => {
    expect(compareVersions("0.2.1-beta.1", "0.2.1")).toBeLessThan(0);
    expect(compareVersions("0.2.1-beta.10", "0.2.1-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("0.2.1+build", "0.2.1")).toBe(0);
    expect(() => compareVersions("0.2.1-beta.01", "0.2.1")).toThrow();
  });
});
