//! Athria Skill identity, archive export, and the Claude Desktop handshake
//! report store.
//!
//! Agents that read Skills from disk receive an unmodified copy of
//! `packages/skills`. Claude Desktop is different: the user uploads a Skill
//! archive through Claude's own settings, so Athria exports a ZIP per Skill
//! with a handshake instruction injected into the exported `SKILL.md` only.
//! Source Skills are never modified by an export.
//!
//! Skill identity is the Skill's `manifest.json` version plus a SHA-256 of its
//! source tree — the same value the filesystem agents record in
//! `.athria-managed.json` — so a version reported by a running Skill can be
//! compared against the bundle that Athria currently ships.

pub mod archive;
pub mod export;
pub mod reports;

pub use export::{
    ArchiveSet, BUNDLED_SKILLS, EXPORT_MANIFEST, ExportedSkill, MANAGED_MARKER, SkillArchive,
    SkillIdentity, export_archives, export_skill, expected_skills, hash_tree, skill_version,
};
pub use reports::{
    REPORTS_SCHEMA_VERSION, ReportInput, SkillReport, SkillReports, SkillsVerification,
    read_reports, record_report, verify_skills,
};
