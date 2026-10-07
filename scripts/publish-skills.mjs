// Invoked only by the release workflow. Never prints key material.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot, signIndex, verifyIndex, mergeRelease, updateCompatibility } from "./skill-release.mjs";

const repo = "whywww/Athria";
const pinned = readFileSync(join(projectRoot, "packages/skills/update-public-key.txt"), "utf8");
const privateKey = process.env.SKILLS_SIGNING_PRIVATE_KEY;
if (!privateKey) throw new Error("Missing SKILLS_SIGNING_PRIVATE_KEY secret.");
// Check trust configuration before any GitHub write.
signIndex({ schemaVersion: 1, packages: [] }, privateKey, pinned);
const temp = mkdtempSync(join(tmpdir(), "athria-skills-release-"));
function gh(args, allowMissing = false) {
  const result = spawnSync("gh", [...args, "--repo", repo], { encoding: "utf8" });
  if (result.status !== 0) {
    if (allowMissing && /release not found|Not Found|HTTP 404/i.test(result.stderr)) return null;
    throw new Error(`GitHub operation failed: ${result.stderr}`);
  }
  return result.stdout;
}
function release(tag) { const json = gh(["release", "view", tag, "--json", "assets"], true); return json === null ? null : JSON.parse(json); }
function download(tag, name, destination) { gh(["release", "download", tag, "--pattern", name, "--dir", destination]); return readFileSync(join(destination, name)); }
function immutableUpload(tag, name, bytes) {
  const existing = release(tag).assets.some((a) => a.name === name);
  if (existing) {
    const dir = mkdtempSync(join(temp, "asset-"));
    if (!download(tag, name, dir).equals(bytes)) throw new Error(`Refusing to overwrite ${tag}/${name} with different content.`);
  } else {
    const path = join(temp, name); writeFileSync(path, bytes); gh(["release", "upload", tag, path]);
  }
}
const indexRelease = release("skills-index");
let index = { schemaVersion: 1, packages: [] };
if (indexRelease?.assets.some((a) => a.name === "index.json")) index = verifyIndex(download("skills-index", "index.json", temp), pinned);
else if (indexRelease) throw new Error("Existing skills-index release is missing its signed index; refusing to discard history.");

const revocations = (process.env.SKILLS_REVOKE_VERSIONS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const operation = process.env.SKILLS_OPERATION ?? (revocations.length ? "revoke" : "publish");
if (operation === "compatibility") {
  if (!indexRelease) throw new Error("No signed Skill catalog exists to update.");
  index = updateCompatibility(index, process.env.SKILLS_TARGET_VERSION, {
    minAppVersion: process.env.SKILLS_MIN_APP_VERSION,
    maxAppVersion: process.env.SKILLS_MAX_APP_VERSION,
    supportedContracts: (process.env.SKILLS_SUPPORTED_CONTRACTS ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  });
} else if (operation === "revoke") {
  if (!revocations.length) throw new Error("Provide at least one Skill version to revoke.");
  for (const version of revocations) {
    const entry = index.packages.find((p) => p.version === version);
    if (!entry) throw new Error(`Cannot revoke unknown Skill version ${version}.`);
    entry.revoked = true;
  }
} else if (operation === "publish") {
  const manifestPath = join(projectRoot, "dist/skills/manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Package Skills before publishing.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")), tag = `skills-v${manifest.version}`;
  if (process.env.GITHUB_REF_NAME !== tag) throw new Error("Release metadata version does not match the pushed tag.");
  index = mergeRelease(index, manifest);
  // Ensure the final signed index can be produced before uploading any assets.
  signIndex(index, privateKey, pinned);
  if (!release(tag)) gh(["release", "create", tag, "--title", `Athria Skills ${manifest.version}`, "--notes", "Independent Athria Skill package. Install compatible updates through Athria.", "--latest=false"]);
  immutableUpload(tag, "skills.zip", readFileSync(join(projectRoot, "dist/skills/skills.zip")));
  immutableUpload(tag, "manifest.json", readFileSync(manifestPath));
} else throw new Error("Unknown Skill publication operation.");
const bytes = signIndex(index, privateKey, pinned);
if (!indexRelease) gh(["release", "create", "skills-index", "--target", process.env.GITHUB_SHA, "--title", "Athria Skill update index", "--notes", "Signed catalog for compatible Skill updates.", "--latest=false"]);
const indexPath = join(temp, "index.json"); writeFileSync(indexPath, bytes);
gh(["release", "upload", "skills-index", indexPath, "--clobber"]);
