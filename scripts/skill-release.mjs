import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const skillNames = ["athria-athlete-profile", "athria-coach", "athria-training-planner", "athria-workout", "athria-xunji-records"];
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const contractFingerprint = (text) => digest(Buffer.from(text.replaceAll("\r\n", "\n")));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function assertVersion(version) {
  if (typeof version !== "string" || !versionPattern.test(version) || version.match(versionPattern)[4]?.split(".").some((v) => /^\d+$/.test(v) && v.length > 1 && v.startsWith("0"))) throw new Error("Invalid release version.");
}
export function compareVersions(a, b) {
  assertVersion(a); assertVersion(b);
  const left = a.match(versionPattern), right = b.match(versionPattern);
  for (let i = 1; i <= 3; i++) { const x = BigInt(left[i]), y = BigInt(right[i]); if (x !== y) return x < y ? -1 : 1; }
  if (!left[4] || !right[4]) return left[4] === right[4] ? 0 : left[4] ? -1 : 1;
  const x = left[4].split("."), y = right[4].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn) return BigInt(x[i]) < BigInt(y[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
function files(root, dir = root, result = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Skill release files must not be symlinks.");
    if (stat.isDirectory()) files(root, path, result);
    else if (stat.isFile()) {
      if (name === ".athria-managed.json") throw new Error("Managed Agent copies cannot be released.");
      result.push({ name: path.slice(root.length + 1).replaceAll("\\", "/"), data: readFileSync(path) });
    } else throw new Error("Unsupported Skill release file.");
  }
  return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export function treeHash(entries) {
  const hash = createHash("sha256");
  for (const { name, data } of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) { hash.update(name); hash.update(data); }
  return hash.digest("hex");
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
// Deterministic stored ZIP: sorted files, fixed timestamps, no platform attributes.
export function zip(entries) {
  const local = [], central = []; let offset = 0;
  if (!entries.length || entries.length > 65535) throw new Error("Invalid ZIP entry count.");
  for (const { name, data } of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const filename = Buffer.from(name), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(20513, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(20513, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function buildPackage(root = projectRoot) {
  const release = JSON.parse(readFileSync(join(root, "packages/skills/release.json"), "utf8"));
  for (const v of [release.version, release.minAppVersion, release.maxAppVersion]) assertVersion(v);
  if (compareVersions(release.minAppVersion, release.maxAppVersion) >= 0) throw new Error("Empty application compatibility range.");
  const app = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  if (compareVersions(app.version, release.minAppVersion) < 0 || compareVersions(app.version, release.maxAppVersion) >= 0) throw new Error("Release must support the current application.");
  const current = contractFingerprint(readFileSync(join(root, "crates/athria-mcp/contract.json"), "utf8"));
  const supportedContracts = [...new Set(release.supportedContracts.map((v) => v === "current" ? current : v))];
  if (!supportedContracts.includes(current) || supportedContracts.some((v) => !/^[a-f0-9]{64}$/.test(v))) throw new Error("Invalid supported MCP contracts.");
  const archiveEntries = [], skills = [];
  for (const name of skillNames) {
    const path = join(root, "packages/skills", name), entries = files(path);
    if (!entries.some((e) => e.name === "SKILL.md")) throw new Error(`Missing Skill ${name}.`);
    const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")); assertVersion(manifest.version);
    skills.push({ name, version: manifest.version, hash: treeHash(entries) });
    archiveEntries.push(...entries.map((e) => ({ ...e, name: `${name}/${e.name}` })));
  }
  const archive = zip(archiveEntries);
  if (archive.length > 10 * 1024 * 1024 || archiveEntries.reduce((n, e) => n + e.data.length, 0) > 20 * 1024 * 1024) throw new Error("Skill release exceeds client size limits.");
  const manifest = { version: release.version, minAppVersion: release.minAppVersion, maxAppVersion: release.maxAppVersion, supportedContracts, skills,
    url: `https://github.com/whywww/Athria/releases/download/skills-v${release.version}/skills.zip`, sha256: digest(archive), revoked: false };
  return { archive, manifest };
}
export function publicKey(raw) {
  const bytes = Buffer.from(raw.trim(), "base64");
  if (bytes.length !== 32) throw new Error("Configure the pinned Skill public key before publishing.");
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]), format: "der", type: "spki" });
}
export function verifyIndex(bytes, pinned) {
  if (bytes.length > 1024 * 1024) throw new Error("Skill index exceeds client size limit.");
  const envelope = JSON.parse(bytes.toString("utf8")), payload = Buffer.from(envelope.payload, "base64");
  if (!verify(null, payload, publicKey(pinned), Buffer.from(envelope.signature, "base64"))) throw new Error("Invalid Skill index signature.");
  const index = JSON.parse(payload.toString("utf8"));
  if (index.schemaVersion !== 1 || !Array.isArray(index.packages)) throw new Error("Unsupported index schema.");
  return index;
}
export function signIndex(index, pem, pinned) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519" || !createPublicKey(key).export({ format: "der", type: "spki" }).equals(publicKey(pinned).export({ format: "der", type: "spki" }))) throw new Error("Signing key does not match the application's pinned public key.");
  const payload = Buffer.from(JSON.stringify(index));
  const bytes = Buffer.from(JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, key).toString("base64") }));
  verifyIndex(bytes, pinned); return bytes;
}
export function mergeRelease(index, manifest) {
  const existing = index.packages.find((p) => p.version === manifest.version);
  if (existing && !isDeepStrictEqual(packageContent(existing), packageContent(manifest))) throw new Error("Cannot replace an existing Skill release with different content.");
  return { schemaVersion: 1, packages: existing ? index.packages : [...index.packages, manifest] };
}

function packageContent(entry) {
  return { version: entry.version, url: entry.url, sha256: entry.sha256,
    skills: [...entry.skills].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(({ name, version, hash }) => ({ name, version, hash })) };
}

export function updateCompatibility(index, version, compatibility) {
  assertVersion(version);
  const allowed = ["minAppVersion", "maxAppVersion", "supportedContracts"];
  if (!compatibility || Object.keys(compatibility).length !== allowed.length || Object.keys(compatibility).some((key) => !allowed.includes(key))) throw new Error("Only compatibility fields may be updated.");
  const { minAppVersion, maxAppVersion, supportedContracts } = compatibility;
  assertVersion(minAppVersion); assertVersion(maxAppVersion);
  if (compareVersions(minAppVersion, maxAppVersion) >= 0) throw new Error("Empty application compatibility range.");
  if (!Array.isArray(supportedContracts) || !supportedContracts.length || supportedContracts.some((v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))) throw new Error("Provide explicit tested MCP fingerprints; 'current' is not allowed.");
  if (!index.packages.some((p) => p.version === version)) throw new Error(`Cannot change compatibility for unknown Skill version ${version}.`);
  const replacement = { minAppVersion, maxAppVersion, supportedContracts: [...new Set(supportedContracts)] };
  return { ...index, packages: index.packages.map((entry) => entry.version === version ? { ...entry, ...replacement } : entry) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, [join(projectRoot, "scripts/validate-skills.mjs")], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Skill validation failed.");
  const { archive, manifest } = buildPackage();
  const out = resolve(process.argv[2] ?? join(projectRoot, "dist/skills")); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "skills.zip"), archive); writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Skill package ${manifest.version} prepared.\n`);
}
