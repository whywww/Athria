//! The Claude Desktop Skill handshake report store.
//!
//! Claude Desktop installs Skills through its own settings, so Athria cannot
//! read which Skill versions Claude actually loaded. Instead the exported
//! Skill asks the host to report itself through the MCP tool
//! `report_skill_version` on first use, and Athria records what it hears here.
//!
//! The record lives next to the prepared archives under the Athria
//! configuration root because it describes this machine's Claude Desktop
//! integration, not the training data in the active profile database.

use athria_core::{Clock, SystemClock};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::export::SkillIdentity;

pub const REPORTS_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReport {
    pub version: String,
    pub hash: String,
    pub last_seen_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReports {
    pub schema_version: u32,
    #[serde(default)]
    pub reports: BTreeMap<String, SkillReport>,
}

impl Default for SkillReports {
    fn default() -> Self {
        Self {
            schema_version: REPORTS_SCHEMA_VERSION,
            reports: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ReportInput {
    pub skill: String,
    pub version: String,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkillsVerification {
    /// No exported Skill has reported itself yet.
    Unverified,
    /// Reported Skills that no longer match the bundle Athria ships.
    Outdated { stale: Vec<String> },
    /// Every Skill that reported itself matches the bundle.
    Verified { reported: usize },
}

/// A missing or unreadable record means "nothing has reported yet" rather than
/// an error: the file is written by another Athria process.
pub fn read_reports(path: &Path) -> SkillReports {
    let Ok(text) = fs::read_to_string(path) else {
        return SkillReports::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn record_report(path: &Path, input: &ReportInput) -> Result<SkillReport, String> {
    record_report_at(path, input, &SystemClock)
}

pub fn record_report_at(
    path: &Path,
    input: &ReportInput,
    clock: &dyn Clock,
) -> Result<SkillReport, String> {
    let mut reports = read_reports(path);
    let report = SkillReport {
        version: input.version.clone(),
        hash: input.hash.clone(),
        last_seen_at: clock.now_iso(),
    };
    reports.schema_version = REPORTS_SCHEMA_VERSION;
    reports
        .reports
        .insert(input.skill.clone(), report.clone());
    write_reports(path, &reports)?;
    Ok(report)
}

fn write_reports(path: &Path, reports: &SkillReports) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let temporary = path.with_file_name(format!("{file_name}.{}.tmp", std::process::id()));
    let contents =
        serde_json::to_string_pretty(reports).map_err(|error| format!("Invalid report: {error}"))?;
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not update {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        format!(
            "Could not record the Skill report in {}: {error}",
            path.display()
        )
    })
}

/// Compares what Claude reported against the bundle Athria currently ships.
///
/// Skills that never ran are not stale — Claude loads a Skill only when it is
/// relevant — so a bundle counts as verified as soon as everything that did run
/// matches.
pub fn verify_skills(expected: &[SkillIdentity], reports: &SkillReports) -> SkillsVerification {
    let mut reported = 0usize;
    let mut stale = Vec::new();
    for identity in expected {
        let Some(report) = reports.reports.get(&identity.name) else {
            continue;
        };
        reported += 1;
        if report.version != identity.version || report.hash != identity.hash {
            stale.push(identity.name.clone());
        }
    }
    if reported == 0 {
        SkillsVerification::Unverified
    } else if stale.is_empty() {
        SkillsVerification::Verified { reported }
    } else {
        SkillsVerification::Outdated { stale }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use athria_core::FixedClock;

    fn identity(name: &str, version: &str, hash: &str) -> SkillIdentity {
        SkillIdentity {
            name: name.to_string(),
            version: version.to_string(),
            hash: hash.to_string(),
        }
    }

    fn report(version: &str, hash: &str) -> SkillReport {
        SkillReport {
            version: version.to_string(),
            hash: hash.to_string(),
            last_seen_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    fn reports(entries: &[(&str, &str, &str)]) -> SkillReports {
        SkillReports {
            schema_version: REPORTS_SCHEMA_VERSION,
            reports: entries
                .iter()
                .map(|(name, version, hash)| (name.to_string(), report(version, hash)))
                .collect(),
        }
    }

    #[test]
    fn missing_records_read_as_empty() {
        let path = std::env::temp_dir().join("athria-reports-absent/skill-reports.json");
        let read = read_reports(&path);
        assert!(read.reports.is_empty());
        assert_eq!(read.schema_version, REPORTS_SCHEMA_VERSION);
    }

    #[test]
    fn corrupt_records_read_as_empty() {
        let path = std::env::temp_dir().join(format!(
            "athria-reports-corrupt-{}/skill-reports.json",
            std::process::id()
        ));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert!(read_reports(&path).reports.is_empty());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn records_merge_and_keep_the_first_seen_instants() {
        let root = std::env::temp_dir().join(format!("athria-reports-write-{}", std::process::id()));
        let path = root.join("skill-reports.json");
        let clock = FixedClock::new("2026-02-02T00:00:00.000Z");
        record_report_at(
            &path,
            &ReportInput {
                skill: "athria-coach".into(),
                version: "0.1.0".into(),
                hash: "a".into(),
            },
            &clock,
        )
        .unwrap();
        record_report_at(
            &path,
            &ReportInput {
                skill: "athria-workout".into(),
                version: "0.1.0".into(),
                hash: "b".into(),
            },
            &clock,
        )
        .unwrap();
        record_report_at(
            &path,
            &ReportInput {
                skill: "athria-workout".into(),
                version: "0.2.0".into(),
                hash: "c".into(),
            },
            &FixedClock::new("2026-03-03T00:00:00.000Z"),
        )
        .unwrap();
        let stored = read_reports(&path);
        assert_eq!(stored.reports.len(), 2);
        assert_eq!(stored.reports["athria-coach"].hash, "a");
        assert_eq!(stored.reports["athria-workout"].version, "0.2.0");
        assert_eq!(
            stored.reports["athria-workout"].last_seen_at,
            "2026-03-03T00:00:00.000Z"
        );
        assert!(!path.with_file_name("skill-reports.json.tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unverified_until_something_reports() {
        let expected = [identity("athria-coach", "0.1.0", "a")];
        assert_eq!(
            verify_skills(&expected, &SkillReports::default()),
            SkillsVerification::Unverified
        );
        assert_eq!(
            verify_skills(&expected, &reports(&[("athria-unknown", "9.9.9", "z")])),
            SkillsVerification::Unverified
        );
    }

    #[test]
    fn a_subset_of_matching_reports_is_verified() {
        let expected = [
            identity("athria-coach", "0.1.0", "a"),
            identity("athria-workout", "0.1.0", "b"),
        ];
        assert_eq!(
            verify_skills(&expected, &reports(&[("athria-coach", "0.1.0", "a")])),
            SkillsVerification::Verified { reported: 1 }
        );
    }

    #[test]
    fn a_stale_version_or_hash_needs_an_update() {
        let expected = [
            identity("athria-coach", "0.1.0", "a"),
            identity("athria-workout", "0.1.0", "b"),
        ];
        assert_eq!(
            verify_skills(
                &expected,
                &reports(&[("athria-coach", "0.1.0", "a"), ("athria-workout", "0.0.9", "b")])
            ),
            SkillsVerification::Outdated {
                stale: vec!["athria-workout".to_string()]
            }
        );
        assert_eq!(
            verify_skills(&expected, &reports(&[("athria-coach", "0.1.0", "changed")])),
            SkillsVerification::Outdated {
                stale: vec!["athria-coach".to_string()]
            }
        );
    }

    #[test]
    fn reports_for_removed_skills_are_ignored() {
        let expected = [identity("athria-coach", "0.1.0", "a")];
        assert_eq!(
            verify_skills(
                &expected,
                &reports(&[
                    ("athria-coach", "0.1.0", "a"),
                    ("athria-retired-skill", "0.0.1", "gone")
                ])
            ),
            SkillsVerification::Verified { reported: 1 }
        );
    }
}
