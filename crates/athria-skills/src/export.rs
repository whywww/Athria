//! Skill identity and archive export.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::archive::{ArchiveEntry, write_archive};

pub const BUNDLED_SKILLS: [&str; 5] = [
    "athria-athlete-profile",
    "athria-coach",
    "athria-training-planner",
    "athria-workout",
    "athria-xunji-records",
];

/// Written by Athria into the Skill folders it manages for filesystem agents.
/// Excluded from every content hash so a managed folder hashes like its source.
pub const MANAGED_MARKER: &str = ".athria-managed.json";

/// Identity record Athria ships inside each exported Skill archive.
pub const EXPORT_MANIFEST: &str = "athria-export.json";

/// Marks the injected handshake block, so exports are recognisable and tests
/// can assert the block was added exactly once.
pub const HANDSHAKE_MARKER: &str = "Athria connection check";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIdentity {
    pub name: String,
    pub version: String,
    pub hash: String,
}

#[derive(Clone, Debug)]
pub struct ExportedSkill {
    pub identity: SkillIdentity,
    /// Forward-slash relative path to file bytes, ready to be archived.
    pub files: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct SkillArchive {
    pub identity: SkillIdentity,
    pub path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ArchiveSet {
    pub dir: PathBuf,
    pub archives: Vec<SkillArchive>,
}

pub fn hash_tree(root: &Path) -> Result<String, String> {
    fn collect(root: &Path, path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let child = entry.path();
            if child.is_dir() {
                collect(root, &child, files)?;
            } else if child.file_name().and_then(|v| v.to_str()) != Some(MANAGED_MARKER) {
                files.push(child.strip_prefix(root).unwrap_or(&child).to_path_buf());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    collect(root, root, &mut files)?;
    files.sort();
    let mut hash = Sha256::new();
    for relative in files {
        hash.update(relative.to_string_lossy().as_bytes());
        hash.update(fs::read(root.join(&relative)).map_err(|error| {
            format!("Could not read {}: {error}", root.join(relative).display())
        })?);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn skill_version(path: &Path) -> String {
    fs::read_to_string(path.join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}

fn missing_skill(name: &str) -> String {
    format!("Athria's bundled Skill {name} is missing. Reinstall Athria and try again.")
}

/// Every file of a Skill, relative path to bytes, excluding Athria's own marker.
fn collect_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    fn walk(root: &Path, path: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
        for entry in fs::read_dir(path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let child = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if child.is_dir() {
                walk(root, &child, files)?;
            } else if name != MANAGED_MARKER {
                let relative = child
                    .strip_prefix(root)
                    .unwrap_or(&child)
                    .to_string_lossy()
                    .replace('\\', "/");
                let data = fs::read(&child)
                    .map_err(|error| format!("Could not read {}: {error}", child.display()))?;
                files.insert(relative, data);
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files)?;
    Ok(files)
}

/// Byte offset just past the closing delimiter of a leading YAML frontmatter
/// block, or `None` when the document has none.
fn frontmatter_end(markdown: &str) -> Option<usize> {
    let mut offset = 0usize;
    let mut lines = markdown.split_inclusive('\n');
    let opening = lines.next()?;
    if opening.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    offset += opening.len();
    for line in lines {
        offset += line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some(offset);
        }
    }
    None
}

fn handshake_block(identity: &SkillIdentity, newline: &str) -> String {
    let payload = serde_json::to_string(&json!({
        "skill": identity.name,
        "version": identity.version,
        "hash": identity.hash,
    }))
    .expect("handshake payload");
    format!(
        "> **{HANDSHAKE_MARKER} — do this once per conversation, before you use any other Athria tool.**{newline}\
         > Call the Athria MCP tool `report_skill_version` with{newline}\
         > `{payload}`.{newline}\
         > If Athria's tools are not available, continue without it.{newline}"
    )
}

/// Adds the handshake block to a copy of `SKILL.md`, right after its
/// frontmatter. The source Skill on disk is never modified.
pub fn with_handshake(markdown: &str, identity: &SkillIdentity) -> String {
    let newline = if markdown.contains("\r\n") { "\r\n" } else { "\n" };
    let block = handshake_block(identity, newline);
    match frontmatter_end(markdown) {
        Some(index) => format!("{}{block}{}", &markdown[..index], &markdown[index..]),
        None => format!("{block}{markdown}"),
    }
}

pub fn export_skill(
    source_root: &Path,
    name: &str,
    athria_version: &str,
) -> Result<ExportedSkill, String> {
    let directory = source_root.join(name);
    if !directory.is_dir() {
        return Err(missing_skill(name));
    }
    let identity = SkillIdentity {
        name: name.to_string(),
        version: skill_version(&directory),
        hash: hash_tree(&directory)?,
    };
    let mut files = collect_files(&directory)?;
    let skill_markdown = files
        .get("SKILL.md")
        .ok_or_else(|| missing_skill(name))?;
    let skill_markdown = std::str::from_utf8(skill_markdown)
        .map_err(|error| format!("Athria's bundled Skill {name} is not valid UTF-8: {error}"))?;
    files.insert(
        "SKILL.md".to_string(),
        with_handshake(skill_markdown, &identity).into_bytes(),
    );
    files.insert(
        EXPORT_MANIFEST.to_string(),
        serde_json::to_string_pretty(&json!({
            "name": identity.name,
            "version": identity.version,
            "sourceHash": identity.hash,
            "athriaVersion": athria_version,
        }))
        .expect("export manifest")
        .into_bytes(),
    );
    Ok(ExportedSkill { identity, files })
}

/// Identity of every bundled Skill without packaging anything, so status
/// checks stay cheap.
pub fn expected_skills(source_root: &Path) -> Result<Vec<SkillIdentity>, String> {
    BUNDLED_SKILLS
        .into_iter()
        .map(|name| {
            let directory = source_root.join(name);
            if !directory.is_dir() {
                return Err(missing_skill(name));
            }
            Ok(SkillIdentity {
                name: name.to_string(),
                version: skill_version(&directory),
                hash: hash_tree(&directory)?,
            })
        })
        .collect()
}

pub fn archive_file_name(name: &str, version: &str) -> String {
    format!("{name}-{version}.zip")
}

/// Replaces the prepared archives in `dir`. Other files (the handshake report)
/// are kept.
fn clear_archives(dir: &Path) -> Result<(), String> {
    for entry in
        fs::read_dir(dir).map_err(|error| format!("Could not read {}: {error}", dir.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let is_zip = path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"));
        if is_zip && path.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("Could not replace {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

/// Writes one archive per bundled Skill into `dir`, each rooted at its Skill
/// folder, and returns the identities a running Skill can report back.
pub fn export_archives(
    source_root: &Path,
    dir: &Path,
    athria_version: &str,
) -> Result<ArchiveSet, String> {
    fs::create_dir_all(dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    clear_archives(dir)?;
    let mut archives = Vec::new();
    for name in BUNDLED_SKILLS {
        let exported = export_skill(source_root, name, athria_version)?;
        let path = dir.join(archive_file_name(name, &exported.identity.version));
        let entries = exported
            .files
            .iter()
            .map(|(relative, data)| ArchiveEntry {
                name: format!("{name}/{relative}"),
                data: data.clone(),
            })
            .collect::<Vec<_>>();
        write_archive(&path, &entries)?;
        archives.push(SkillArchive {
            identity: exported.identity,
            path,
        });
    }
    Ok(ArchiveSet {
        dir: dir.to_path_buf(),
        archives,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "athria-skills-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        for name in BUNDLED_SKILLS {
            let skill = root.join(name);
            fs::create_dir_all(skill.join("references")).unwrap();
            fs::write(
                skill.join("SKILL.md"),
                "---\nname: test\ndescription: test\n---\n\n# Test\n\nBody.\n",
            )
            .unwrap();
            fs::write(skill.join("manifest.json"), r#"{"version":"1.2.3"}"#).unwrap();
            fs::write(skill.join("references/deep.md"), "deep\n").unwrap();
        }
        root
    }

    #[test]
    fn exports_leave_source_skills_untouched() {
        let root = fixture("source");
        let before: BTreeMap<String, Vec<u8>> = BUNDLED_SKILLS
            .into_iter()
            .map(|name| {
                (
                    name.to_string(),
                    fs::read(root.join(name).join("SKILL.md")).unwrap(),
                )
            })
            .collect();
        let sets = export_archives(&root, &root.join("out"), "0.2.0").unwrap();
        assert_eq!(sets.archives.len(), BUNDLED_SKILLS.len());
        for (name, markdown) in before {
            assert_eq!(fs::read(root.join(&name).join("SKILL.md")).unwrap(), markdown);
            assert!(
                !String::from_utf8(markdown)
                    .unwrap()
                    .contains(HANDSHAKE_MARKER)
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archives_carry_the_handshake_and_a_matching_identity() {
        let root = fixture("archive");
        let dir = root.join("out");
        let sets = export_archives(&root, &dir, "0.2.0").unwrap();
        let coach = sets
            .archives
            .iter()
            .find(|archive| archive.identity.name == "athria-coach")
            .unwrap();
        assert_eq!(coach.identity.version, "1.2.3");
        assert!(coach.identity.hash.len() == 64);
        assert!(coach.path.ends_with("athria-coach-1.2.3.zip"));

        let entries = crate::archive::read_entries(&fs::read(&coach.path).unwrap());
        let names = entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"athria-coach/SKILL.md"));
        assert!(names.contains(&"athria-coach/references/deep.md"));
        assert!(names.contains(&"athria-coach/athria-export.json"));

        let skill_markdown = entries
            .iter()
            .find(|(name, _)| name == "athria-coach/SKILL.md")
            .map(|(_, data)| String::from_utf8(data.clone()).unwrap())
            .unwrap();
        assert_eq!(skill_markdown.matches(HANDSHAKE_MARKER).count(), 1);
        assert!(skill_markdown.contains(&format!("\"hash\":\"{}\"", coach.identity.hash)));
        assert!(skill_markdown.contains("\"version\":\"1.2.3\""));
        assert!(skill_markdown.contains("\"skill\":\"athria-coach\""));
        // Frontmatter stays first: the handshake is a body block.
        assert!(skill_markdown.starts_with("---\nname: test\n"));
        assert!(skill_markdown.contains("# Test"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identity_is_stable_across_exports_and_matches_expected_skills() {
        let root = fixture("stable");
        let first = export_archives(&root, &root.join("out"), "0.2.0").unwrap();
        let second = export_archives(&root, &root.join("out"), "0.2.0").unwrap();
        for (left, right) in first.archives.iter().zip(&second.archives) {
            assert_eq!(left.identity, right.identity);
        }
        assert_eq!(
            expected_skills(&root).unwrap(),
            first
                .archives
                .iter()
                .map(|archive| archive.identity.clone())
                .collect::<Vec<_>>()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn re_export_replaces_archives_and_keeps_the_report_file() {
        let root = fixture("replace");
        let dir = root.join("out");
        export_archives(&root, &dir, "0.2.0").unwrap();
        fs::write(dir.join("skill-reports.json"), "{}").unwrap();
        fs::write(dir.join("stale.zip"), "old").unwrap();
        let sets = export_archives(&root, &dir, "0.2.0").unwrap();
        assert_eq!(sets.archives.len(), BUNDLED_SKILLS.len());
        assert!(!dir.join("stale.zip").exists());
        assert!(dir.join("skill-reports.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_bundled_skills_are_reported() {
        let root = std::env::temp_dir().join(format!(
            "athria-skills-missing-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(expected_skills(&root).is_err());
        assert!(export_skill(&root, "athria-coach", "0.2.0").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
