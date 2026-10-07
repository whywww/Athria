# Independent Skill releases

Athria and its MCP continue to ship together. Five Skills ship as one independently
versioned package; each Skill also keeps its existing manifest version. The
installer includes a working baseline, and network errors never block startup.

## One-time signing setup

Online updates intentionally remain disabled until a production Ed25519 public
key is committed to `packages/skills/update-public-key.txt`. It must contain the
Base64 encoding of the **32 raw public-key bytes**, not a PEM or SPKI document.
Configure GitHub Secret `SKILLS_SIGNING_PRIVATE_KEY` with the corresponding
Ed25519 PKCS#8 PEM private key. Do not commit that private key or print it in CI.

Generate the pair locally using Node's `generateKeyPairSync("ed25519")`. Export
the private key with `{ type: "pkcs8", format: "pem" }` to a secure, ignored PEM
file. Export the public key with `{ type: "spki", format: "der" }`, take the last
32 bytes, Base64-encode them and put that text in the public-key file. The
release script verifies that both keys match before making any GitHub writes.
Build and distribute an Athria version containing that public key before
publishing the first online Skill package. Key rotation requires an application
update; replacing the key file alone does not update installed applications.

## Publish a package

1. Update the changed Skills and their manifest versions. Edit
   `packages/skills/release.json`: bump the package version and declare the
   inclusive minimum and exclusive maximum supported application versions.
2. `supportedContracts: ["current"]` resolves to the SHA-256 of the exact MCP
   contract, with CRLF converted to LF. Additional fingerprints must identify
   older application/MCP versions you have actually tested. Tool compatibility
   alone does not guarantee matching business behavior: use the application
   version bounds to exclude untested behavior.
3. Run `pnpm validate:skill`, `pnpm test`, `pnpm typecheck` and `cargo test`.
   `pnpm package:skills` validates and produces deterministic `skills.zip` and
   `manifest.json` under the ignored `dist/skills` directory; it does not build
   the desktop app or publish anything.
4. Commit, tag `skills-v<package version>`, and push that tag. The Skill release
   workflow uploads immutable assets to that release, then updates the signed
   `index.json` asset on the `skills-index` release. Both releases use
   `latest=false`, leaving the desktop application's latest release unchanged.

The signed index retains historical packages so an older app can select its
newest compatible release. Re-running a completed publication accepts identical
assets but rejects different content under the same version. If initial index
release creation is interrupted before uploading its asset, inspect the release
and restore its signed index before rerunning; an existing index release without
its catalog is rejected to avoid discarding history. Catalog upload can briefly
be unavailable during replacement; clients retain their last verified copy and
retry at the next check. Workflow concurrency serializes all index updates.

## Revoke a release

Run the **Skill release** workflow manually from the protected default branch
with comma-separated versions in `revoke_versions`. It verifies the old signed
index, marks those versions revoked and signs a new index. It does not rebuild
or overwrite package assets. On the next successful check, clients fall back to
an installed, compatible, non-revoked package or to the bundled baseline. If a
new compatible package is available, automatic updates download it. Agent
copies follow the same existing local-edit protections, including during
rollback. A revoked version cannot be republished to clear its revoked status;
publish a new package version instead.

## Client behavior

- Startup first synchronizes the existing local Skills, then checks online at
  most once every 24 hours. The automatic-update switch is on by default and is
  stored outside the training database. Turning it off disables automatic
  checks/downloads; manual checks and installations remain available.
- Manual checks bypass the interval. Checking and installing share one lock;
  overlapping checks share the completed result. HTTPS requests have a 30-second
  timeout and bounded response sizes. Updates verify an Ed25519 signature, the
  package SHA-256, the application range, and the compiled MCP contract fingerprint.
- Packages live in the platform Athria configuration directory under
  `skill-updates/versions`. Staging extraction is validated before directory
  publication and atomic activation. Interrupted downloads leave the active
  package untouched. A corrupt active record is recoverable from verified
  installed versions. A newer bundled baseline supersedes older downloads.
- ZIPs are restricted to the five known Skills. Traversal, absolute paths,
  Windows device paths, links and duplicate paths are rejected. Limits are
  1 MiB for the index, 10 MiB for the archive, 20 MiB extracted and 4096 entries.
- Only managed, unmodified Agent copies are synchronized automatically. Local
  edits keep the existing backup-and-replace flow; unmanaged copies are not
  taken over. Package success and Agent synchronization failures appear
  separately in Settings. Updated Claude Desktop ZIPs still require installation
  in Claude's own Skills settings; the handshake verifies the loaded copies.
- Existing conversations may retain previously loaded instructions. Reconnect
  or restart the Agent when the new version has not appeared. This feature does
  not install application or MCP updates.
