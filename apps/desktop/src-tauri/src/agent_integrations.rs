use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use toml_edit::{Array, DocumentMut, Item, Table, value};
use uuid::Uuid;

const SKILLS: [&str; 5] = [
    "athria-athlete-profile",
    "athria-coach",
    "athria-training-planner",
    "athria-workout",
    "athria-xunji-records",
];
const MARKER: &str = ".athria-managed.json";
const AGENTS: [AgentKind; 7] = [
    AgentKind::Codex,
    AgentKind::ClaudeCode,
    AgentKind::ClaudeDesktop,
    AgentKind::QoderCn,
    AgentKind::TraeCn,
    AgentKind::Cursor,
    AgentKind::WorkBuddy,
];

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Codex,
    ClaudeCode,
    ClaudeDesktop,
    QoderCn,
    TraeCn,
    Cursor,
    /// The snake_case rule would name this `work_buddy`, which no longer matches the id the UI sends back.
    #[serde(rename = "workbuddy")]
    WorkBuddy,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    agent: &'static str,
    name: &'static str,
    available: bool,
    mcp: &'static str,
    skills: &'static str,
    config_path: String,
    skills_path: Option<String>,
    restart_required: bool,
    diagnostic: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    agent: &'static str,
    mcp: &'static str,
    skills: &'static str,
    restart_required: bool,
    backup_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMarker {
    name: String,
    version: String,
    content_hash: String,
    source: String,
}

struct AgentPaths {
    config: PathBuf,
    skills: Option<PathBuf>,
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Athria could not determine your home folder.".to_string())
}

fn paths(agent: AgentKind) -> Result<AgentPaths, String> {
    let home = home_dir()?;
    match agent {
        AgentKind::Codex => Ok(AgentPaths {
            config: home.join(".codex/config.toml"),
            skills: Some(home.join(".agents/skills")),
        }),
        AgentKind::ClaudeCode => Ok(AgentPaths {
            config: home.join(".claude.json"),
            skills: Some(home.join(".claude/skills")),
        }),
        AgentKind::ClaudeDesktop => {
            #[cfg(windows)]
            let config = env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData/Roaming"))
                .join("Claude/claude_desktop_config.json");
            #[cfg(target_os = "macos")]
            let config = home.join("Library/Application Support/Claude/claude_desktop_config.json");
            #[cfg(not(any(windows, target_os = "macos")))]
            let config = home.join(".config/Claude/claude_desktop_config.json");
            Ok(AgentPaths {
                config,
                skills: None,
            })
        }
        AgentKind::QoderCn => Ok(AgentPaths {
            config: home.join(".qoder-cn/mcp.json"),
            skills: None,
        }),
        AgentKind::TraeCn => Ok(AgentPaths {
            config: home.join(".trae-cn/mcp.json"),
            skills: Some(home.join(".trae-cn/skills")),
        }),
        AgentKind::Cursor => Ok(AgentPaths {
            config: home.join(".cursor/mcp.json"),
            skills: Some(home.join(".cursor/skills")),
        }),
        AgentKind::WorkBuddy => Ok(AgentPaths {
            config: home.join(".workbuddy/mcp.json"),
            skills: None,
        }),
    }
}

fn identity(agent: AgentKind) -> (&'static str, &'static str) {
    match agent {
        AgentKind::Codex => ("codex", "Codex"),
        AgentKind::ClaudeCode => ("claude_code", "Claude Code"),
        AgentKind::ClaudeDesktop => ("claude_desktop", "Claude Desktop"),
        AgentKind::QoderCn => ("qoder_cn", "Qoder CN"),
        AgentKind::TraeCn => ("trae_cn", "Trae CN"),
        AgentKind::Cursor => ("cursor", "Cursor"),
        AgentKind::WorkBuddy => ("workbuddy", "WorkBuddy"),
    }
}

fn command_available(name: &str) -> bool {
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    env::split_paths(&path).any(|dir| {
        let plain = dir.join(name);
        plain.is_file() || (cfg!(windows) && dir.join(format!("{name}.exe")).is_file())
    })
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key).map(PathBuf::from)
}

fn exists_in(base: Option<PathBuf>, relative: &str) -> bool {
    base.is_some_and(|base| base.join(relative).exists())
}

fn is_available(agent: AgentKind, target: &AgentPaths) -> bool {
    if !cfg!(any(windows, target_os = "macos")) {
        return false;
    }
    match agent {
        AgentKind::Codex => {
            command_available("codex")
                || target.config.exists()
                || target.skills.as_ref().is_some_and(|path| path.exists())
        }
        AgentKind::ClaudeCode => {
            command_available("claude")
                || target.config.exists()
                || target.skills.as_ref().is_some_and(|path| path.exists())
        }
        AgentKind::ClaudeDesktop => {
            target.config.exists()
                || if cfg!(windows) {
                    exists_in(env_path("LOCALAPPDATA"), "AnthropicClaude/Claude.exe")
                } else {
                    Path::new("/Applications/Claude.app").exists()
                }
        }
        AgentKind::QoderCn => {
            target.config.exists()
                || if cfg!(windows) {
                    exists_in(env_path("ProgramFiles"), "Qoder CN IDE/Qoder CN IDE.exe")
                } else {
                    Path::new("/Applications/Qoder CN.app").exists()
                }
        }
        AgentKind::TraeCn => {
            target.config.exists()
                || target.skills.as_ref().is_some_and(|path| path.exists())
                || if cfg!(windows) {
                    exists_in(env_path("APPDATA"), "Trae CN")
                } else {
                    Path::new("/Applications/Trae CN.app").exists()
                }
        }
        AgentKind::Cursor => {
            target.config.exists()
                || command_available("cursor")
                || if cfg!(windows) {
                    exists_in(env_path("LOCALAPPDATA"), "Programs/cursor/Cursor.exe")
                } else {
                    Path::new("/Applications/Cursor.app").exists()
                }
        }
        AgentKind::WorkBuddy => {
            target.config.exists() || target.config.parent().is_some_and(Path::exists)
        }
    }
}

pub(crate) fn resource_skills(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Athria could not locate its resources: {error}"))?
        .join("skills");
    if SKILLS
        .iter()
        .all(|name| path.join(name).join("SKILL.md").is_file())
    {
        Ok(path)
    } else {
        Err("Athria's bundled Skills are missing. Reinstall Athria and try again.".to_string())
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
}

fn mcp_status(agent: AgentKind, path: &Path, executable: &str) -> &'static str {
    if !path.exists() {
        return "missing";
    }
    match agent {
        AgentKind::Codex => {
            let Ok(text) = fs::read_to_string(path) else {
                return "conflict";
            };
            let Ok(doc) = text.parse::<DocumentMut>() else {
                return "conflict";
            };
            let Some(entry) = doc.get("mcp_servers").and_then(|v| v.get("athria")) else {
                return "missing";
            };
            let command = entry.get("command").and_then(Item::as_str);
            let args_ok = entry
                .get("args")
                .and_then(Item::as_array)
                .is_some_and(|args| {
                    args.len() == 1 && args.get(0).and_then(|v| v.as_str()) == Some("mcp")
                });
            if command == Some(executable) && args_ok {
                "installed"
            } else {
                "outdated"
            }
        }
        _ => match read_json(path) {
            Ok(root) => match root.get("mcpServers").and_then(|v| v.get("athria")) {
                None => "missing",
                Some(entry)
                    if entry.get("command").and_then(Value::as_str) == Some(executable)
                        && entry
                            .get("args")
                            .and_then(Value::as_array)
                            .is_some_and(|args| args == &[json!("mcp")]) =>
                {
                    "installed"
                }
                Some(_) => "outdated",
            },
            Err(_) => "conflict",
        },
    }
}

fn hash_tree(root: &Path) -> Result<String, String> {
    fn collect(root: &Path, path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let child = entry.path();
            if child.is_dir() {
                collect(root, &child, files)?;
            } else if child.file_name().and_then(|v| v.to_str()) != Some(MARKER) {
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

fn skill_version(path: &Path) -> String {
    fs::read_to_string(path.join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}

fn skills_status(source: &Path, target: &Path) -> &'static str {
    let mut missing = false;
    for name in SKILLS {
        let destination = target.join(name);
        if !destination.exists() {
            missing = true;
            continue;
        }
        let marker = fs::read_to_string(destination.join(MARKER))
            .ok()
            .and_then(|text| serde_json::from_str::<SkillMarker>(&text).ok());
        let Some(marker) = marker else {
            return "conflict";
        };
        let Ok(source_hash) = hash_tree(&source.join(name)) else {
            return "conflict";
        };
        let Ok(target_hash) = hash_tree(&destination) else {
            return "conflict";
        };
        if marker.name != name || marker.content_hash != source_hash || target_hash != source_hash {
            return "outdated";
        }
    }
    if missing { "missing" } else { "installed" }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| format!("{} has no parent folder", path.display()))?,
    )
    .map_err(|error| format!("Could not create the configuration folder: {error}"))
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    ensure_parent(path)?;
    let temporary = path.with_extension(format!("athria-{}.tmp", Uuid::new_v4().simple()));
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not update {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not install {}: {error}", path.display()))
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), &destination)
                .map_err(|error| format!("Could not copy {}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

fn backup_path(root: &Path, label: &str) -> Result<PathBuf, String> {
    let path = root.join("agent-integration-backups").join(format!(
        "{}-{}-{}",
        label,
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create backup folder: {error}"))?;
    Ok(path)
}

fn backup_existing(path: &Path, backup: &Path, name: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let destination = backup.join(name);
    if path.is_dir() {
        copy_tree(path, &destination)
    } else {
        ensure_parent(&destination)?;
        fs::copy(path, destination)
            .map(|_| ())
            .map_err(|error| format!("Could not back up {}: {error}", path.display()))
    }
}

fn install_mcp(agent: AgentKind, path: &Path, executable: &str) -> Result<(), String> {
    match agent {
        AgentKind::Codex => {
            let text = if path.exists() {
                fs::read_to_string(path)
                    .map_err(|error| format!("Could not read {}: {error}", path.display()))?
            } else {
                String::new()
            };
            let mut doc = text
                .parse::<DocumentMut>()
                .map_err(|error| format!("{} is not valid TOML: {error}", path.display()))?;
            if !doc.as_table().contains_key("mcp_servers") {
                doc["mcp_servers"] = Item::Table(Table::new());
            }
            doc["mcp_servers"]["athria"] = Item::Table(Table::new());
            doc["mcp_servers"]["athria"]["command"] = value(executable);
            let mut args = Array::new();
            args.push("mcp");
            doc["mcp_servers"]["athria"]["args"] = value(args);
            atomic_write(path, doc.to_string().as_bytes())
        }
        _ => {
            let mut root = read_json(path)?;
            let object = root
                .as_object_mut()
                .ok_or_else(|| format!("{} must contain a JSON object.", path.display()))?;
            let servers = object
                .entry("mcpServers")
                .or_insert_with(|| Value::Object(Map::new()));
            let servers = servers
                .as_object_mut()
                .ok_or_else(|| format!("{}.mcpServers must be an object.", path.display()))?;
            servers.insert(
                "athria".to_string(),
                json!({ "command": executable, "args": ["mcp"] }),
            );
            atomic_write(
                path,
                serde_json::to_string_pretty(&root).unwrap().as_bytes(),
            )
        }
    }
}

fn remove_mcp(agent: AgentKind, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    match agent {
        AgentKind::Codex => {
            let mut doc = fs::read_to_string(path)
                .map_err(|error| error.to_string())?
                .parse::<DocumentMut>()
                .map_err(|error| format!("{} is not valid TOML: {error}", path.display()))?;
            if let Some(servers) = doc.get_mut("mcp_servers").and_then(Item::as_table_mut) {
                servers.remove("athria");
            }
            atomic_write(path, doc.to_string().as_bytes())
        }
        _ => {
            let mut root = read_json(path)?;
            if let Some(servers) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
                servers.remove("athria");
            }
            atomic_write(
                path,
                serde_json::to_string_pretty(&root).unwrap().as_bytes(),
            )
        }
    }
}

fn install_skills(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
    for name in SKILLS {
        let from = source.join(name);
        let to = target.join(name);
        if to.exists() {
            fs::remove_dir_all(&to)
                .map_err(|error| format!("Could not replace {}: {error}", to.display()))?;
        }
        copy_tree(&from, &to)?;
        let marker = SkillMarker {
            name: name.to_string(),
            version: skill_version(&from),
            content_hash: hash_tree(&from)?,
            source: "Athria Desktop".to_string(),
        };
        atomic_write(
            &to.join(MARKER),
            serde_json::to_string_pretty(&marker).unwrap().as_bytes(),
        )?;
    }
    Ok(())
}

fn remove_skills(target: &Path) -> Result<(), String> {
    for name in SKILLS {
        let path = target.join(name);
        if path.join(MARKER).is_file() {
            fs::remove_dir_all(&path)
                .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

fn restore_backup(target: &AgentPaths, backup: &Path) {
    if backup.join("config").exists() {
        let _ = ensure_parent(&target.config);
        let _ = fs::copy(backup.join("config"), &target.config);
    } else {
        let _ = fs::remove_file(&target.config);
    }
    if let Some(skills) = &target.skills {
        for name in SKILLS {
            let destination = skills.join(name);
            let _ = fs::remove_dir_all(&destination);
            let source = backup.join("skills").join(name);
            if source.exists() {
                let _ = copy_tree(&source, &destination);
            }
        }
    }
}

fn mcp_only_diagnostic(name: &str) -> String {
    format!("{name} supports Athria through MCP only. Install Athria Skills in an agent that supports them, such as Codex, Claude Code, Trae CN, or Cursor.")
}

pub fn statuses(app: &AppHandle) -> Result<Vec<AgentStatus>, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("Athria could not determine its installation path: {error}"))?;
    let executable = executable.to_string_lossy();
    let source = resource_skills(app);
    AGENTS.into_iter().map(|agent| {
        let target = paths(agent)?;
        let (id, name) = identity(agent);
        let supported = cfg!(any(windows, target_os = "macos"));
        let available = supported && is_available(agent, &target);
        let mcp = if supported { mcp_status(agent, &target.config, &executable) } else { "unavailable" };
        let (skills, diagnostic) = if !supported {
            ("unavailable", Some("Agent integration is currently supported on Windows and macOS only.".to_string()))
        } else if !available {
            let skills = if target.skills.is_some() { "missing" } else { "unsupported" };
            (skills, Some(format!("{name} was not detected. You can configure it after installing the agent.")))
        } else if let Some(skills) = &target.skills {
            match &source {
                Ok(source) => (skills_status(source, skills), None),
                Err(error) => ("unavailable", Some(error.clone())),
            }
        } else {
            ("unsupported", Some(mcp_only_diagnostic(name)))
        };
        Ok(AgentStatus { agent: id, name, available, mcp, skills, config_path: target.config.to_string_lossy().into_owned(), skills_path: target.skills.map(|v| v.to_string_lossy().into_owned()), restart_required: mcp == "installed" || skills == "installed", diagnostic })
    }).collect()
}

pub fn install(
    app: &AppHandle,
    agent: AgentKind,
    backup_root: &Path,
) -> Result<OperationResult, String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err(
            "Agent integration is currently supported on Windows and macOS only.".to_string(),
        );
    }
    let target = paths(agent)?;
    let (id, _) = identity(agent);
    let backup = backup_path(backup_root, id)?;
    backup_existing(&target.config, &backup, "config")?;
    if let Some(skills) = &target.skills {
        for name in SKILLS {
            backup_existing(&skills.join(name), &backup.join("skills"), name)?;
        }
    }
    let executable = env::current_exe()
        .map_err(|error| format!("Athria could not determine its installation path: {error}"))?;
    let result: Result<(), String> = (|| {
        install_mcp(agent, &target.config, &executable.to_string_lossy())?;
        if let Some(skills) = &target.skills {
            install_skills(&resource_skills(app)?, skills)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        restore_backup(&target, &backup);
        return Err(format!(
            "{error} Athria restored the previous Agent configuration."
        ));
    }
    Ok(OperationResult {
        agent: id,
        mcp: "installed",
        skills: if target.skills.is_some() {
            "installed"
        } else {
            "unsupported"
        },
        restart_required: true,
        backup_path: Some(backup.to_string_lossy().into_owned()),
    })
}

pub fn remove(agent: AgentKind, backup_root: &Path) -> Result<OperationResult, String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err(
            "Agent integration is currently supported on Windows and macOS only.".to_string(),
        );
    }
    let target = paths(agent)?;
    let (id, _) = identity(agent);
    let backup = backup_path(backup_root, id)?;
    backup_existing(&target.config, &backup, "config")?;
    if let Some(skills) = &target.skills {
        for name in SKILLS {
            if skills.join(name).join(MARKER).is_file() {
                backup_existing(&skills.join(name), &backup.join("skills"), name)?;
            }
        }
    }
    let result = remove_mcp(agent, &target.config).and_then(|_| {
        if let Some(skills) = &target.skills {
            remove_skills(skills)?;
        }
        Ok(())
    });
    if let Err(error) = result {
        restore_backup(&target, &backup);
        return Err(format!(
            "{error} Athria restored the previous Agent configuration."
        ));
    }
    Ok(OperationResult {
        agent: id,
        mcp: "missing",
        skills: if target.skills.is_some() {
            "missing"
        } else {
            "unsupported"
        },
        restart_required: true,
        backup_path: Some(backup.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_merge_preserves_other_servers() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        let path = root.join("claude.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"other"}}}"#,
        )
        .unwrap();
        install_mcp(AgentKind::ClaudeCode, &path, "/Athria").unwrap();
        let value = read_json(&path).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcpServers"]["other"]["command"], "other");
        assert_eq!(value["mcpServers"]["athria"]["args"], json!(["mcp"]));
        remove_mcp(AgentKind::ClaudeCode, &path).unwrap();
        let value = read_json(&path).unwrap();
        assert!(value["mcpServers"].get("athria").is_none());
        assert!(value["mcpServers"].get("other").is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn toml_merge_preserves_other_settings() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        let path = root.join("config.toml");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            "model = \"test\"\n[mcp_servers.other]\ncommand = \"other\"\n",
        )
        .unwrap();
        install_mcp(AgentKind::Codex, &path, "C:/Athria.exe").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("model = \"test\""));
        assert!(text.contains("[mcp_servers.other]"));
        assert!(text.contains("[mcp_servers.athria]"));
        remove_mcp(AgentKind::Codex, &path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("[mcp_servers.other]"));
        assert!(!text.contains("[mcp_servers.athria]"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_skills_leaves_unmanaged_directories() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        let managed = root.join(SKILLS[0]);
        let unmanaged = root.join(SKILLS[1]);
        fs::create_dir_all(&managed).unwrap();
        fs::create_dir_all(&unmanaged).unwrap();
        fs::write(managed.join(MARKER), "{}").unwrap();
        remove_skills(&root).unwrap();
        assert!(!managed.exists());
        assert!(unmanaged.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_configs_are_reported_without_rewriting_them() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let json_path = root.join("claude.json");
        let toml_path = root.join("config.toml");
        fs::write(&json_path, "not json").unwrap();
        fs::write(&toml_path, "not = [toml").unwrap();
        assert_eq!(
            mcp_status(AgentKind::ClaudeCode, &json_path, "/Athria"),
            "conflict"
        );
        assert_eq!(
            mcp_status(AgentKind::Codex, &toml_path, "/Athria"),
            "conflict"
        );
        assert!(install_mcp(AgentKind::ClaudeCode, &json_path, "/Athria").is_err());
        assert!(install_mcp(AgentKind::Codex, &toml_path, "/Athria").is_err());
        assert_eq!(fs::read_to_string(json_path).unwrap(), "not json");
        assert_eq!(fs::read_to_string(toml_path).unwrap(), "not = [toml");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_install_writes_markers_and_detects_local_edits() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        for name in SKILLS {
            let skill = source.join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(skill.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
            fs::write(skill.join("manifest.json"), r#"{"version":"1.0.0"}"#).unwrap();
        }
        install_skills(&source, &target).unwrap();
        assert_eq!(skills_status(&source, &target), "installed");
        assert!(target.join(SKILLS[0]).join(MARKER).is_file());
        fs::write(target.join(SKILLS[0]).join("SKILL.md"), "changed").unwrap();
        assert_eq!(skills_status(&source, &target), "outdated");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agent_identity_round_trips_through_serde() {
        for agent in AGENTS {
            let (id, _) = identity(agent);
            let decoded: AgentKind = serde_json::from_str(&format!("\"{id}\""))
                .unwrap_or_else(|error| panic!("{id} is not a valid agent id: {error}"));
            assert_eq!(identity(decoded).0, id);
        }
    }

    #[test]
    fn agent_config_paths_are_stable() {
        let cases = [
            (AgentKind::QoderCn, ".qoder-cn/mcp.json", false),
            (AgentKind::TraeCn, ".trae-cn/mcp.json", true),
            (AgentKind::Cursor, ".cursor/mcp.json", true),
            (AgentKind::WorkBuddy, ".workbuddy/mcp.json", false),
        ];
        for (agent, config, skills) in cases {
            let target = paths(agent).unwrap();
            assert!(target.config.ends_with(config), "{}", target.config.display());
            assert_eq!(target.skills.is_some(), skills, "{config}");
        }
    }

    #[test]
    fn json_merge_into_an_empty_server_map() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        let path = root.join("mcp.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, "{\n  \"mcpServers\": {}\n}\n").unwrap();
        install_mcp(AgentKind::QoderCn, &path, "/Athria").unwrap();
        let value = read_json(&path).unwrap();
        assert_eq!(value["mcpServers"]["athria"]["command"], "/Athria");
        assert_eq!(value["mcpServers"]["athria"]["args"], json!(["mcp"]));
        assert_eq!(mcp_status(AgentKind::QoderCn, &path, "/Athria"), "installed");
        remove_mcp(AgentKind::QoderCn, &path).unwrap();
        let value = read_json(&path).unwrap();
        assert!(value["mcpServers"].as_object().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
