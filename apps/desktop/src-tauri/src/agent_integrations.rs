use athria_skills::{
    BUNDLED_SKILLS as SKILLS, MANAGED_MARKER as MARKER, SkillReport, SkillsVerification,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use toml_edit::{Array, DocumentMut, Item, Table, value};
use uuid::Uuid;
const AGENTS: [AgentKind; 7] = [
    AgentKind::Codex,
    AgentKind::ClaudeCode,
    AgentKind::ClaudeDesktop,
    AgentKind::QoderCn,
    AgentKind::TraeCn,
    AgentKind::Cursor,
    AgentKind::WorkBuddy,
];

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
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

impl AgentKind {
    fn from_id(id: &str) -> Option<Self> {
        AGENTS.into_iter().find(|agent| identity(*agent).0 == id)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum McpConfigFormat {
    Json,
    Toml,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomAgentDefinition {
    id: String,
    name: String,
    config_path: PathBuf,
    skills_path: PathBuf,
    format: McpConfigFormat,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    agent: String,
    name: String,
    available: bool,
    mcp: &'static str,
    skills: &'static str,
    /// How this agent receives Athria Skills: `filesystem` for agents Athria
    /// copies into, `gui_managed` for agents the user installs Skills into.
    skills_mode: &'static str,
    config_path: String,
    skills_path: Option<String>,
    /// Folder holding the Skill archives prepared for a GUI-managed agent.
    skill_archive_dir: Option<String>,
    /// Skill versions a GUI-managed agent reported through the handshake.
    skill_reports: Vec<SkillReportView>,
    restart_required: bool,
    diagnostic: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReportView {
    name: String,
    /// Version the agent reported through the handshake, once that Skill ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    reported_version: Option<String>,
    /// Version Athria currently ships for this Skill.
    expected_version: String,
    current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_seen_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillArchiveView {
    name: String,
    version: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    agent: String,
    mcp: &'static str,
    skills: &'static str,
    restart_required: bool,
    backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skill_archive_dir: Option<String>,
    skill_archives: Vec<SkillArchiveView>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMarker {
    #[serde(default)]
    schema_version: Option<u32>,
    #[serde(default)]
    managed_by: Option<String>,
    name: String,
    #[serde(alias = "version")]
    installed_version: String,
    #[serde(alias = "contentHash")]
    installed_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdate {
    name: String,
    installed_version: String,
    bundled_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillUpdate {
    agent: String,
    name: String,
    skills: Vec<SkillUpdate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillUpdateFailure {
    agent: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReconciliationResult {
    updated: Vec<AgentSkillUpdate>,
    conflicts: Vec<AgentSkillUpdate>,
    failures: Vec<AgentSkillUpdateFailure>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillUpdateAction {
    Replace,
    BackupReplace,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateResult {
    agent: String,
    skills: Vec<String>,
    backup_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SkillState {
    Current,
    UpdateAvailable,
    Modified,
    LocallyModified,
    Missing,
    Unmanaged,
    Invalid,
}

/// How an agent receives Athria Skills.
#[derive(Clone, Debug)]
enum SkillsTarget {
    /// Athria copies the bundled Skills into the agent's own Skills folder and
    /// tracks the installed copies with `.athria-managed.json`.
    Filesystem(PathBuf),
    /// The agent installs Skills through its own settings, so Athria exports
    /// archives the user uploads there and verifies them through the handshake.
    GuiManaged,
}

impl AgentPaths {
    fn skills_dir(&self) -> Option<&Path> {
        match &self.skills {
            SkillsTarget::Filesystem(path) => Some(path),
            SkillsTarget::GuiManaged => None,
        }
    }
}

/// Where Athria keeps the archives and handshake reports for a GUI-managed
/// agent. This is machine-wide integration state, so it sits beside the agent
/// configuration it belongs to rather than in the profile database.
struct GuiSkillsPaths {
    dir: PathBuf,
    reports: PathBuf,
}

struct AgentPaths {
    config: PathBuf,
    skills: SkillsTarget,
}

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Athria could not determine your home folder.".to_string())
}

fn paths(agent: AgentKind) -> Result<AgentPaths, String> {
    let home = home_dir()?;
    let skills = |relative: &str| SkillsTarget::Filesystem(home.join(relative));
    match agent {
        AgentKind::Codex => Ok(AgentPaths {
            config: home.join(".codex/config.toml"),
            skills: skills(".agents/skills"),
        }),
        AgentKind::ClaudeCode => Ok(AgentPaths {
            config: home.join(".claude.json"),
            skills: skills(".claude/skills"),
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
                skills: SkillsTarget::GuiManaged,
            })
        }
        AgentKind::QoderCn => Ok(AgentPaths {
            config: home.join(".qoder-cn/settings.json"),
            skills: skills(".qoder-cn/skills"),
        }),
        AgentKind::TraeCn => Ok(AgentPaths {
            config: home.join(".trae-cn/mcp.json"),
            skills: skills(".trae-cn/skills"),
        }),
        AgentKind::Cursor => Ok(AgentPaths {
            config: home.join(".cursor/mcp.json"),
            skills: skills(".cursor/skills"),
        }),
        AgentKind::WorkBuddy => Ok(AgentPaths {
            config: home.join(".workbuddy/mcp.json"),
            skills: skills(".workbuddy/skills"),
        }),
    }
}

fn skills_mode(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::ClaudeDesktop => "gui_managed",
        _ => "filesystem",
    }
}

/// Claude Desktop Skills are uploaded in Claude's own settings, so Athria
/// prepares the archives instead of writing into a Skills folder.
fn gui_skills_paths(config_root: &Path, agent: AgentKind) -> GuiSkillsPaths {
    let dir = config_root
        .join("agent-integration")
        .join(identity(agent).0);
    GuiSkillsPaths {
        dir: dir.clone(),
        reports: dir.join("skill-reports.json"),
    }
}

/// Folder holding the prepared Skill archives for `agent`.
pub(crate) fn gui_skill_archive_dir(config_root: &Path, agent: AgentKind) -> PathBuf {
    gui_skills_paths(config_root, agent).dir
}

/// Where a GUI-managed agent's Skill handshakes are recorded. The MCP server
/// Athria spawns for that agent writes here.
pub(crate) fn gui_skill_reports_path(config_root: &Path, agent: AgentKind) -> PathBuf {
    gui_skills_paths(config_root, agent).reports
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

fn official_format(agent: AgentKind) -> McpConfigFormat {
    if matches!(agent, AgentKind::Codex) { McpConfigFormat::Toml } else { McpConfigFormat::Json }
}

fn custom_agents_path(config_root: &Path) -> PathBuf {
    config_root.join("custom-agents.json")
}

fn read_custom_agents(config_root: &Path) -> Result<Vec<CustomAgentDefinition>, String> {
    let path = custom_agents_path(config_root);
    if !path.exists() { return Ok(Vec::new()); }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
}

fn write_custom_agents(config_root: &Path, agents: &[CustomAgentDefinition]) -> Result<(), String> {
    let path = custom_agents_path(config_root);
    let content = serde_json::to_vec_pretty(agents).map_err(|error| error.to_string())?;
    atomic_write(&path, &content)
}

fn custom_agent<'a>(agents: &'a [CustomAgentDefinition], id: &str) -> Result<&'a CustomAgentDefinition, String> {
    agents.iter().find(|agent| agent.id == id).ok_or_else(|| format!("Unknown agent: {id}"))
}

fn custom_paths(agent: &CustomAgentDefinition) -> AgentPaths {
    AgentPaths { config: agent.config_path.clone(), skills: SkillsTarget::Filesystem(agent.skills_path.clone()) }
}

fn format_from_path(path: &Path) -> Result<McpConfigFormat, String> {
    match path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("json") => Ok(McpConfigFormat::Json),
        Some("toml") => Ok(McpConfigFormat::Toml),
        _ => Err("The MCP config file must end in .json or .toml.".to_string()),
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
                || target.skills_dir().is_some_and(|path| path.exists())
        }
        AgentKind::ClaudeCode => {
            command_available("claude")
                || target.config.exists()
                || target.skills_dir().is_some_and(|path| path.exists())
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
                || target.skills_dir().is_some_and(|path| path.exists())
                || if cfg!(windows) {
                    exists_in(env_path("ProgramFiles"), "Qoder CN IDE/Qoder CN IDE.exe")
                } else {
                    Path::new("/Applications/Qoder CN.app").exists()
                }
        }
        AgentKind::TraeCn => {
            target.config.exists()
                || target.skills_dir().is_some_and(|path| path.exists())
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
            target.config.exists()
                || target.skills_dir().is_some_and(|path| path.exists())
                || target.config.parent().is_some_and(Path::exists)
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
    mcp_status_for_format(official_format(agent), path, executable)
}

fn mcp_status_for_format(format: McpConfigFormat, path: &Path, executable: &str) -> &'static str {
    if !path.exists() {
        return "missing";
    }
    match format {
        McpConfigFormat::Toml => {
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
        McpConfigFormat::Json => match read_json(path) {
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
    athria_skills::hash_tree(root)
}

fn skill_version(path: &Path) -> String {
    athria_skills::skill_version(path)
}

fn read_skill_marker(path: &Path) -> Result<SkillMarker, String> {
    let text = fs::read_to_string(path.join(MARKER))
        .map_err(|error| format!("Could not read {}: {error}", path.join(MARKER).display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.join(MARKER).display()))
}

fn skill_state(source: &Path, destination: &Path, name: &str) -> (SkillState, Option<SkillMarker>) {
    if !destination.exists() {
        return (SkillState::Missing, None);
    }
    if !destination.join(MARKER).is_file() {
        return (SkillState::Unmanaged, None);
    }
    let Ok(marker) = read_skill_marker(destination) else {
        return (SkillState::Invalid, None);
    };
    if marker.name != name || marker.managed_by.as_deref().is_some_and(|value| value != "athria") {
        return (SkillState::Invalid, Some(marker));
    }
    let (Ok(source_hash), Ok(target_hash)) = (hash_tree(source), hash_tree(destination)) else {
        return (SkillState::Invalid, Some(marker));
    };
    let source_changed = marker.installed_hash != source_hash;
    let locally_changed = marker.installed_hash != target_hash;
    let state = match (source_changed, locally_changed) {
        (false, false) => SkillState::Current,
        (true, false) => SkillState::UpdateAvailable,
        (true, true) => SkillState::Modified,
        (false, true) => SkillState::LocallyModified,
    };
    (state, Some(marker))
}

fn skills_status(source: &Path, target: &Path) -> &'static str {
    let mut missing = false;
    let mut outdated = false;
    let mut modified = false;
    for name in SKILLS {
        let destination = target.join(name);
        match skill_state(&source.join(name), &destination, name).0 {
            SkillState::Current => {}
            SkillState::UpdateAvailable => outdated = true,
            SkillState::Modified => modified = true,
            SkillState::LocallyModified => {}
            SkillState::Missing => missing = true,
            SkillState::Unmanaged | SkillState::Invalid => return "conflict",
        }
    }
    if modified {
        "modified"
    } else if outdated {
        "outdated"
    } else if missing {
        "missing"
    } else {
        "installed"
    }
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

fn write_skill_marker(source: &Path, destination: &Path, name: &str) -> Result<(), String> {
    let marker = SkillMarker {
        schema_version: Some(1),
        managed_by: Some("athria".to_string()),
        name: name.to_string(),
        installed_version: skill_version(source),
        installed_hash: hash_tree(source)?,
        source: None,
    };
    atomic_write(
        &destination.join(MARKER),
        serde_json::to_string_pretty(&marker).unwrap().as_bytes(),
    )
}

fn replace_skill(source: &Path, destination: &Path, name: &str) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", destination.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temporary = parent.join(format!(".{name}.athria-new-{}", Uuid::new_v4().simple()));
    let previous = parent.join(format!(".{name}.athria-old-{}", Uuid::new_v4().simple()));
    let prepared = copy_tree(source, &temporary)
        .and_then(|_| write_skill_marker(source, &temporary, name));
    if let Err(error) = prepared {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    let had_previous = destination.exists();
    if had_previous {
        fs::rename(destination, &previous)
            .map_err(|error| format!("Could not prepare to replace {}: {error}", destination.display()))?;
    }
    if let Err(error) = fs::rename(&temporary, destination) {
        if had_previous {
            let _ = fs::rename(&previous, destination);
        }
        let _ = fs::remove_dir_all(&temporary);
        return Err(format!("Could not install {}: {error}", destination.display()));
    }
    if had_previous {
        let _ = fs::remove_dir_all(&previous);
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
    install_mcp_for_format(official_format(agent), path, executable)
}

fn install_mcp_for_format(format: McpConfigFormat, path: &Path, executable: &str) -> Result<(), String> {
    match format {
        McpConfigFormat::Toml => {
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
        McpConfigFormat::Json => {
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
    remove_mcp_for_format(official_format(agent), path)
}

fn remove_mcp_for_format(format: McpConfigFormat, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    match format {
        McpConfigFormat::Toml => {
            let mut doc = fs::read_to_string(path)
                .map_err(|error| error.to_string())?
                .parse::<DocumentMut>()
                .map_err(|error| format!("{} is not valid TOML: {error}", path.display()))?;
            if let Some(servers) = doc.get_mut("mcp_servers").and_then(Item::as_table_mut) {
                servers.remove("athria");
            }
            atomic_write(path, doc.to_string().as_bytes())
        }
        McpConfigFormat::Json => {
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
        replace_skill(&from, &to, name)?;
    }
    Ok(())
}

fn skill_update(name: &str, marker: &SkillMarker, source: &Path) -> SkillUpdate {
    SkillUpdate {
        name: name.to_string(),
        installed_version: marker.installed_version.clone(),
        bundled_version: skill_version(source),
    }
}

pub fn reconcile_skills(app: &AppHandle, config_root: &Path) -> Result<SkillReconciliationResult, String> {
    let source_root = resource_skills(app)?;
    let mut updated = Vec::new();
    let mut conflicts = Vec::new();
    let mut failures = Vec::new();
    for agent in AGENTS {
        let target = paths(agent)?;
        // GUI-managed agents are verified through their handshake, not by
        // scanning installed Skill folders.
        let SkillsTarget::Filesystem(skills_root) = &target.skills else {
            continue;
        };
        let (id, display_name) = identity(agent);
        let mut agent_updated = Vec::new();
        let mut agent_conflicts = Vec::new();
        let mut agent_failure = None;
        for name in SKILLS {
            let source = source_root.join(name);
            let destination = skills_root.join(name);
            let (state, marker) = skill_state(&source, &destination, name);
            match (state, marker) {
                (SkillState::UpdateAvailable, Some(marker)) => {
                    let update = skill_update(name, &marker, &source);
                    match replace_skill(&source, &destination, name) {
                        Ok(()) => agent_updated.push(update),
                        Err(error) => {
                            agent_failure = Some(error);
                            break;
                        }
                    }
                }
                (SkillState::Modified, Some(marker)) => {
                    agent_conflicts.push(skill_update(name, &marker, &source));
                }
                _ => {}
            }
        }
        if !agent_updated.is_empty() {
            updated.push(AgentSkillUpdate { agent: id.to_string(), name: display_name.to_string(), skills: agent_updated });
        }
        if !agent_conflicts.is_empty() {
            conflicts.push(AgentSkillUpdate { agent: id.to_string(), name: display_name.to_string(), skills: agent_conflicts });
        }
        if let Some(message) = agent_failure {
            failures.push(AgentSkillUpdateFailure { agent: id.to_string(), message });
        }
    }
    for agent in read_custom_agents(config_root)? {
        let mut agent_updated = Vec::new();
        let mut agent_conflicts = Vec::new();
        let mut agent_failure = None;
        for name in SKILLS {
            let source = source_root.join(name);
            let destination = agent.skills_path.join(name);
            let (state, marker) = skill_state(&source, &destination, name);
            match (state, marker) {
                (SkillState::UpdateAvailable, Some(marker)) => {
                    let update = skill_update(name, &marker, &source);
                    if let Err(error) = replace_skill(&source, &destination, name) { agent_failure = Some(error); break; }
                    agent_updated.push(update);
                }
                (SkillState::Modified, Some(marker)) => agent_conflicts.push(skill_update(name, &marker, &source)),
                _ => {}
            }
        }
        if !agent_updated.is_empty() { updated.push(AgentSkillUpdate { agent: agent.id.clone(), name: agent.name.clone(), skills: agent_updated }); }
        if !agent_conflicts.is_empty() { conflicts.push(AgentSkillUpdate { agent: agent.id.clone(), name: agent.name.clone(), skills: agent_conflicts }); }
        if let Some(message) = agent_failure { failures.push(AgentSkillUpdateFailure { agent: agent.id, message }); }
    }
    Ok(SkillReconciliationResult { updated, conflicts, failures })
}

pub fn resolve_skill_update(
    app: &AppHandle,
    agent: AgentKind,
    action: SkillUpdateAction,
    backup_root: &Path,
) -> Result<SkillUpdateResult, String> {
    let source_root = resource_skills(app)?;
    let target = paths(agent)?;
    let SkillsTarget::Filesystem(skills_root) = &target.skills else {
        return Err(format!(
            "{} installs Athria Skills in its own settings. Use Update MCP / Skills, then upload the refreshed archives there.",
            identity(agent).1
        ));
    };
    resolve_skill_update_at(&source_root, skills_root, action, backup_root, identity(agent).0)
}

fn resolve_skill_update_at(
    source_root: &Path,
    skills_root: &Path,
    action: SkillUpdateAction,
    backup_root: &Path,
    id: &str,
) -> Result<SkillUpdateResult, String> {
    let conflicts: Vec<&str> = SKILLS
        .into_iter()
        .filter(|name| {
            skill_state(&source_root.join(name), &skills_root.join(name), name).0
                == SkillState::Modified
        })
        .collect();
    if conflicts.is_empty() {
        return Err("The conflicting Skills changed since the update prompt. Scan again before replacing them.".to_string());
    }
    let backup = if matches!(action, SkillUpdateAction::BackupReplace) {
        let path = backup_path(backup_root, id)?;
        for name in &conflicts {
            backup_existing(&skills_root.join(name), &path.join("skills"), name)?;
        }
        Some(path)
    } else {
        None
    };
    for name in &conflicts {
        replace_skill(&source_root.join(name), &skills_root.join(name), name)?;
    }
    Ok(SkillUpdateResult {
        agent: id.to_string(),
        skills: conflicts.into_iter().map(str::to_string).collect(),
        backup_path: backup.map(|path| path.to_string_lossy().into_owned()),
    })
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
    if let SkillsTarget::Filesystem(skills) = &target.skills {
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

struct GuiSkillsStatus {
    status: &'static str,
    reports: Vec<SkillReportView>,
    /// Skills the agent reported that no longer match the bundled Skills.
    stale: Vec<String>,
    /// No Skill has reported itself, so the archives may never have been uploaded.
    awaiting_handshake: bool,
}

/// Compares what the agent reported through the handshake with the bundled
/// Skills. Athria cannot read an agent's installed Skill list, so these reports
/// are the only evidence of what actually loaded.
fn gui_skills_status(source_root: &Path, paths: &GuiSkillsPaths) -> Result<GuiSkillsStatus, String> {
    let expected = athria_skills::expected_skills(source_root)?;
    let stored = athria_skills::read_reports(&paths.reports);
    let reports = expected
        .iter()
        .map(|identity| {
            let report: Option<&SkillReport> = stored.reports.get(&identity.name);
            SkillReportView {
                name: identity.name.clone(),
                reported_version: report.map(|value| value.version.clone()),
                expected_version: identity.version.clone(),
                current: report.is_some_and(|value| {
                    value.version == identity.version && value.hash == identity.hash
                }),
                last_seen_at: report.map(|value| value.last_seen_at.clone()),
            }
        })
        .collect();
    let (status, stale, awaiting_handshake) = match athria_skills::verify_skills(&expected, &stored)
    {
        SkillsVerification::Unverified => ("unverified", Vec::new(), true),
        SkillsVerification::Outdated { stale } => ("outdated", stale, false),
        SkillsVerification::Verified { .. } => ("installed", Vec::new(), false),
    };
    Ok(GuiSkillsStatus {
        status,
        reports,
        stale,
        awaiting_handshake,
    })
}

fn gui_skills_diagnostic(name: &str, report: &GuiSkillsStatus) -> Option<String> {
    if report.awaiting_handshake {
        return Some(format!(
            "Upload the Athria Skill archives Athria prepared in {name}'s own Skills settings. Athria verifies each Skill the first time it runs."
        ));
    }
    if !report.stale.is_empty() {
        return Some(format!(
            "{} in {name} still runs the previous Athria Skills. Choose Update MCP / Skills, then upload the refreshed archives.",
            report.stale.join(", ")
        ));
    }
    None
}

/// Prepares one archive per bundled Skill for the user to upload.
fn export_gui_skills(source_root: &Path, paths: &GuiSkillsPaths) -> Result<athria_skills::ArchiveSet, String> {
    athria_skills::export_archives(source_root, &paths.dir, env!("CARGO_PKG_VERSION"))
}

/// The agent keeps its own copy of an uploaded Skill, so removing the
/// integration only clears what Athria prepared.
fn remove_gui_skills(paths: &GuiSkillsPaths) -> Result<(), String> {
    if !paths.dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&paths.dir)
        .map_err(|error| format!("Could not remove {}: {error}", paths.dir.display()))
}

pub fn statuses(app: &AppHandle, config_root: &Path) -> Result<Vec<AgentStatus>, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("Athria could not determine its installation path: {error}"))?;
    let executable = executable.to_string_lossy();
    let source = resource_skills(app);
    let mut statuses: Vec<AgentStatus> = AGENTS.into_iter().map(|agent| {
        let target = paths(agent)?;
        let (id, name) = identity(agent);
        let supported = cfg!(any(windows, target_os = "macos"));
        let available = supported && is_available(agent, &target);
        let mcp = if supported { mcp_status(agent, &target.config, &executable) } else { "unavailable" };
        let skills_path = target.skills_dir().map(|path| path.to_string_lossy().into_owned());
        let mut skill_archive_dir = None;
        let mut skill_reports = Vec::new();
        let (skills, diagnostic) = if !supported {
            ("unavailable", Some("Agent integration is currently supported on Windows and macOS only.".to_string()))
        } else if !available {
            ("missing", Some(format!("{name} was not detected. You can configure it after installing the agent.")))
        } else {
            match &target.skills {
                SkillsTarget::Filesystem(skills) => match &source {
                    Ok(source) => (skills_status(source, skills), None),
                    Err(error) => ("unavailable", Some(error.clone())),
                },
                SkillsTarget::GuiManaged => {
                    let paths = gui_skills_paths(config_root, agent);
                    if paths.dir.is_dir() {
                        skill_archive_dir = Some(paths.dir.to_string_lossy().into_owned());
                    }
                    match &source {
                        Ok(source) => match gui_skills_status(source, &paths) {
                            Ok(report) => {
                                let diagnostic = gui_skills_diagnostic(name, &report);
                                skill_reports = report.reports;
                                (report.status, diagnostic)
                            }
                            Err(error) => ("unavailable", Some(error)),
                        },
                        Err(error) => ("unavailable", Some(error.clone())),
                    }
                }
            }
        };
        Ok(AgentStatus { agent: id.to_string(), name: name.to_string(), available, mcp, skills, skills_mode: skills_mode(agent), config_path: target.config.to_string_lossy().into_owned(), skills_path, skill_archive_dir, skill_reports, restart_required: mcp == "installed" || skills == "installed", diagnostic })
    }).collect::<Result<_, String>>()?;
    for agent in read_custom_agents(config_root)? {
        let mcp = mcp_status_for_format(agent.format, &agent.config_path, &executable);
        let skills = match &source {
            Ok(source) => skills_status(source, &agent.skills_path),
            Err(_) => "unavailable",
        };
        statuses.push(AgentStatus {
            agent: agent.id,
            name: agent.name,
            available: true,
            mcp,
            skills,
            skills_mode: "filesystem",
            config_path: agent.config_path.to_string_lossy().into_owned(),
            skills_path: Some(agent.skills_path.to_string_lossy().into_owned()),
            skill_archive_dir: None,
            skill_reports: Vec::new(),
            restart_required: mcp == "installed" || skills == "installed",
            diagnostic: None,
        });
    }
    Ok(statuses)
}

pub fn resolve_skill_update_by_id(app: &AppHandle, id: &str, action: SkillUpdateAction, backup_root: &Path) -> Result<SkillUpdateResult, String> {
    if let Some(agent) = AgentKind::from_id(id) { return resolve_skill_update(app, agent, action, backup_root); }
    let agents = read_custom_agents(backup_root)?;
    let agent = custom_agent(&agents, id)?;
    resolve_skill_update_at(&resource_skills(app)?, &agent.skills_path, action, backup_root, &agent.id)
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
    if let SkillsTarget::Filesystem(skills) = &target.skills {
        for name in SKILLS {
            backup_existing(&skills.join(name), &backup.join("skills"), name)?;
        }
    }
    let executable = env::current_exe()
        .map_err(|error| format!("Athria could not determine its installation path: {error}"))?;
    let mut gui_archives = None;
    let result: Result<(), String> = (|| {
        install_mcp(agent, &target.config, &executable.to_string_lossy())?;
        match &target.skills {
            SkillsTarget::Filesystem(skills) => install_skills(&resource_skills(app)?, skills)?,
            SkillsTarget::GuiManaged => {
                gui_archives = Some(export_gui_skills(
                    &resource_skills(app)?,
                    &gui_skills_paths(backup_root, agent),
                )?);
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        restore_backup(&target, &backup);
        return Err(format!(
            "{error} Athria restored the previous Agent configuration."
        ));
    }
    let (skills, skill_archive_dir, skill_archives) = match gui_archives {
        // The archives are ready to upload, but Athria only reports Connected
        // once a Skill has actually run and reported the version it loaded.
        Some(set) => (
            "unverified",
            Some(set.dir.to_string_lossy().into_owned()),
            set.archives
                .into_iter()
                .map(|archive| SkillArchiveView {
                    name: archive.identity.name,
                    version: archive.identity.version,
                    path: archive.path.to_string_lossy().into_owned(),
                })
                .collect::<Vec<_>>(),
        ),
        None => ("installed", None, Vec::new()),
    };
    Ok(OperationResult {
        agent: id.to_string(),
        mcp: "installed",
        skills,
        restart_required: true,
        backup_path: Some(backup.to_string_lossy().into_owned()),
        skill_archive_dir,
        skill_archives,
    })
}

fn install_custom_at(app: &AppHandle, agent: &CustomAgentDefinition, backup_root: &Path) -> Result<OperationResult, String> {
    let target = custom_paths(agent);
    let backup = backup_path(backup_root, &agent.id)?;
    backup_existing(&target.config, &backup, "config")?;
    for name in SKILLS {
        backup_existing(&agent.skills_path.join(name), &backup.join("skills"), name)?;
    }
    let executable = env::current_exe()
        .map_err(|error| format!("Athria could not determine its installation path: {error}"))?;
    let executable = executable.to_string_lossy();
    let result = install_mcp_for_format(agent.format, &agent.config_path, &executable)
        .and_then(|_| install_skills(&resource_skills(app)?, &agent.skills_path))
        .and_then(|_| {
            if mcp_status_for_format(agent.format, &agent.config_path, &executable) != "installed" {
                return Err("Athria could not verify the MCP configuration after writing it.".to_string());
            }
            if skills_status(&resource_skills(app)?, &agent.skills_path) != "installed" {
                return Err("Athria could not verify the Skills after installing them.".to_string());
            }
            Ok(())
        });
    if let Err(error) = result {
        restore_backup(&target, &backup);
        return Err(format!("{error} Athria restored the previous Agent configuration."));
    }
    Ok(OperationResult {
        agent: agent.id.clone(), mcp: "installed", skills: "installed", restart_required: true,
        backup_path: Some(backup.to_string_lossy().into_owned()), skill_archive_dir: None, skill_archives: Vec::new(),
    })
}

pub fn install_by_id(app: &AppHandle, id: &str, backup_root: &Path) -> Result<OperationResult, String> {
    if let Some(agent) = AgentKind::from_id(id) { return install(app, agent, backup_root); }
    let agents = read_custom_agents(backup_root)?;
    install_custom_at(app, custom_agent(&agents, id)?, backup_root)
}

pub fn add_custom_agent(app: &AppHandle, name: &str, config_path: &str, skills_path: &str, config_root: &Path) -> Result<OperationResult, String> {
    let name = name.trim();
    if name.is_empty() { return Err("Agent name is required.".to_string()); }
    let config_path = PathBuf::from(config_path.trim());
    let skills_path = PathBuf::from(skills_path.trim());
    if !config_path.is_absolute() || !skills_path.is_absolute() {
        return Err("MCP config and Skills paths must be absolute paths.".to_string());
    }
    let format = format_from_path(&config_path)?;
    let mut agents = read_custom_agents(config_root)?;
    if AGENTS.into_iter().any(|agent| identity(agent).1.eq_ignore_ascii_case(name))
        || agents.iter().any(|agent| agent.name.eq_ignore_ascii_case(name)) {
        return Err(format!("An agent named {name} already exists."));
    }
    let definition = CustomAgentDefinition {
        id: format!("custom_{}", Uuid::new_v4().simple()), name: name.to_string(), config_path, skills_path, format,
    };
    let result = install_custom_at(app, &definition, config_root)?;
    agents.push(definition);
    if let Err(error) = write_custom_agents(config_root, &agents) {
        if let Some(path) = &result.backup_path {
            restore_backup(&custom_paths(agents.last().expect("custom agent was just appended")), Path::new(path));
        }
        return Err(format!("The connection was verified, but Athria could not save the custom agent: {error}"));
    }
    Ok(result)
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
    if let SkillsTarget::Filesystem(skills) = &target.skills {
        for name in SKILLS {
            if skills.join(name).join(MARKER).is_file() {
                backup_existing(&skills.join(name), &backup.join("skills"), name)?;
            }
        }
    }
    let result = remove_mcp(agent, &target.config).and_then(|_| match &target.skills {
        SkillsTarget::Filesystem(skills) => remove_skills(skills),
        SkillsTarget::GuiManaged => remove_gui_skills(&gui_skills_paths(backup_root, agent)),
    });
    if let Err(error) = result {
        restore_backup(&target, &backup);
        return Err(format!(
            "{error} Athria restored the previous Agent configuration."
        ));
    }
    Ok(OperationResult {
        agent: id.to_string(),
        mcp: "missing",
        skills: "missing",
        restart_required: true,
        backup_path: Some(backup.to_string_lossy().into_owned()),
        skill_archive_dir: None,
        skill_archives: Vec::new(),
    })
}

pub fn remove_by_id(id: &str, backup_root: &Path) -> Result<OperationResult, String> {
    if let Some(agent) = AgentKind::from_id(id) { return remove(agent, backup_root); }
    let agents = read_custom_agents(backup_root)?;
    let agent = custom_agent(&agents, id)?;
    let target = custom_paths(agent);
    let backup = backup_path(backup_root, &agent.id)?;
    backup_existing(&target.config, &backup, "config")?;
    for name in SKILLS {
        if agent.skills_path.join(name).join(MARKER).is_file() {
            backup_existing(&agent.skills_path.join(name), &backup.join("skills"), name)?;
        }
    }
    let result = remove_mcp_for_format(agent.format, &agent.config_path).and_then(|_| remove_skills(&agent.skills_path));
    if let Err(error) = result {
        restore_backup(&target, &backup);
        return Err(format!("{error} Athria restored the previous Agent configuration."));
    }
    Ok(OperationResult { agent: agent.id.clone(), mcp: "missing", skills: "missing", restart_required: true,
        backup_path: Some(backup.to_string_lossy().into_owned()), skill_archive_dir: None, skill_archives: Vec::new() })
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
        assert_eq!(
            skill_state(
                &source.join(SKILLS[0]),
                &target.join(SKILLS[0]),
                SKILLS[0]
            )
            .0,
            SkillState::LocallyModified
        );
        assert_eq!(skills_status(&source, &target), "installed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn distinguishes_clean_updates_from_update_conflicts() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        for name in SKILLS {
            let skill = source.join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(skill.join("SKILL.md"), "original").unwrap();
            fs::write(skill.join("manifest.json"), r#"{"version":"1.0.0"}"#).unwrap();
        }
        install_skills(&source, &target).unwrap();
        fs::write(source.join(SKILLS[0]).join("SKILL.md"), "bundled update").unwrap();
        assert_eq!(
            skill_state(&source.join(SKILLS[0]), &target.join(SKILLS[0]), SKILLS[0]).0,
            SkillState::UpdateAvailable
        );
        fs::write(target.join(SKILLS[0]).join("SKILL.md"), "local edit").unwrap();
        assert_eq!(
            skill_state(&source.join(SKILLS[0]), &target.join(SKILLS[0]), SKILLS[0]).0,
            SkillState::Modified
        );
        assert_eq!(skills_status(&source, &target), "modified");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_legacy_markers_and_rewrites_them_after_update() {
        let root = env::temp_dir().join(format!("athria-agent-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("SKILL.md"), "old").unwrap();
        fs::write(source.join("manifest.json"), r#"{"version":"1.0.0"}"#).unwrap();
        fs::write(target.join("SKILL.md"), "old").unwrap();
        fs::write(target.join("manifest.json"), r#"{"version":"1.0.0"}"#).unwrap();
        let installed_hash = hash_tree(&target).unwrap();
        fs::write(
            target.join(MARKER),
            format!(r#"{{"name":"legacy","version":"1.0.0","contentHash":"{installed_hash}","source":"Athria Desktop"}}"#),
        ).unwrap();
        fs::write(source.join("SKILL.md"), "new").unwrap();
        assert_eq!(skill_state(&source, &target, "legacy").0, SkillState::UpdateAvailable);
        replace_skill(&source, &target, "legacy").unwrap();
        let marker = read_skill_marker(&target).unwrap();
        assert_eq!(marker.schema_version, Some(1));
        assert_eq!(marker.managed_by.as_deref(), Some("athria"));
        assert_eq!(marker.installed_version, "1.0.0");
        assert_eq!(skill_state(&source, &target, "legacy").0, SkillState::Current);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conflict_resolution_only_backs_up_when_requested() {
        fn conflict_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
            let root = env::temp_dir().join(format!("athria-agent-test-{label}-{}", Uuid::new_v4()));
            let source = root.join("source");
            let target = root.join("target");
            for name in SKILLS {
                let skill = source.join(name);
                fs::create_dir_all(&skill).unwrap();
                fs::write(skill.join("SKILL.md"), "original").unwrap();
                fs::write(skill.join("manifest.json"), r#"{"version":"1.0.0"}"#).unwrap();
            }
            install_skills(&source, &target).unwrap();
            fs::write(source.join(SKILLS[0]).join("SKILL.md"), "bundled update").unwrap();
            fs::write(target.join(SKILLS[0]).join("SKILL.md"), "local edit").unwrap();
            (root, source, target)
        }

        let (backup_root, source, target) = conflict_fixture("backup");
        let result = resolve_skill_update_at(&source, &target, SkillUpdateAction::BackupReplace, &backup_root, "codex").unwrap();
        let backup = PathBuf::from(result.backup_path.unwrap());
        assert_eq!(fs::read_to_string(backup.join("skills").join(SKILLS[0]).join("SKILL.md")).unwrap(), "local edit");
        assert_eq!(fs::read_to_string(target.join(SKILLS[0]).join("SKILL.md")).unwrap(), "bundled update");
        fs::remove_dir_all(backup_root).unwrap();

        let (replace_root, source, target) = conflict_fixture("replace");
        let result = resolve_skill_update_at(&source, &target, SkillUpdateAction::Replace, &replace_root, "codex").unwrap();
        assert!(result.backup_path.is_none());
        assert!(!replace_root.join("agent-integration-backups").exists());
        assert_eq!(fs::read_to_string(target.join(SKILLS[0]).join("SKILL.md")).unwrap(), "bundled update");
        fs::remove_dir_all(replace_root).unwrap();
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
            (AgentKind::QoderCn, ".qoder-cn/settings.json", ".qoder-cn/skills"),
            (AgentKind::TraeCn, ".trae-cn/mcp.json", ".trae-cn/skills"),
            (AgentKind::Cursor, ".cursor/mcp.json", ".cursor/skills"),
            (AgentKind::WorkBuddy, ".workbuddy/mcp.json", ".workbuddy/skills"),
        ];
        for (agent, config, skills) in cases {
            let target = paths(agent).unwrap();
            assert!(target.config.ends_with(config), "{}", target.config.display());
            let path = target.skills_dir().expect("filesystem Skills");
            assert!(path.ends_with(skills), "{}", path.display());
        }
    }

    #[test]
    fn only_claude_desktop_is_a_gui_managed_agent() {
        for agent in AGENTS {
            let expected = if matches!(agent, AgentKind::ClaudeDesktop) {
                "gui_managed"
            } else {
                "filesystem"
            };
            assert_eq!(skills_mode(agent), expected, "{}", identity(agent).0);
        }
        let target = paths(AgentKind::ClaudeDesktop).unwrap();
        assert!(matches!(target.skills, SkillsTarget::GuiManaged));
        assert!(target.skills_dir().is_none());
        assert!(matches!(
            paths(AgentKind::Cursor).unwrap().skills,
            SkillsTarget::Filesystem(_)
        ));
    }

    fn gui_fixture(label: &str) -> (PathBuf, PathBuf) {
        let root = env::temp_dir().join(format!("athria-agent-test-{label}-{}", Uuid::new_v4()));
        let source = root.join("skills");
        for name in SKILLS {
            let skill = source.join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(skill.join("SKILL.md"), format!("---\nname: {name}\n---\n\n# Body\n")).unwrap();
            fs::write(skill.join("manifest.json"), r#"{"version":"1.0.0"}"#).unwrap();
        }
        (root, source)
    }

    fn report_as_installed(set: &athria_skills::ArchiveSet, reports: &Path) {
        let archive = &set.archives[0];
        athria_skills::record_report(
            reports,
            &athria_skills::ReportInput {
                skill: archive.identity.name.clone(),
                version: archive.identity.version.clone(),
                hash: archive.identity.hash.clone(),
            },
        )
        .unwrap();
    }

    #[test]
    fn installing_a_gui_managed_agent_prepares_archives_without_claiming_success() {
        let (root, source) = gui_fixture("gui-install");
        let paths = gui_skills_paths(&root, AgentKind::ClaudeDesktop);
        let set = export_gui_skills(&source, &paths).unwrap();
        assert_eq!(set.archives.len(), SKILLS.len());
        assert!(set.archives.iter().all(|archive| archive.path.is_file()));
        assert!(paths.dir.ends_with("agent-integration/claude_desktop"));

        let status = gui_skills_status(&source, &paths).unwrap();
        assert_eq!(status.status, "unverified");
        assert!(status.awaiting_handshake);
        assert!(status.stale.is_empty());
        assert!(gui_skills_diagnostic("Claude Desktop", &status)
            .unwrap()
            .contains("Upload the Athria Skill archives"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_matching_handshake_verifies_the_gui_managed_skills() {
        let (root, source) = gui_fixture("gui-handshake");
        let paths = gui_skills_paths(&root, AgentKind::ClaudeDesktop);
        let set = export_gui_skills(&source, &paths).unwrap();
        report_as_installed(&set, &paths.reports);

        let status = gui_skills_status(&source, &paths).unwrap();
        assert_eq!(status.status, "installed");
        assert!(status.stale.is_empty());
        assert!(gui_skills_diagnostic("Claude Desktop", &status).is_none());
        let reported = status
            .reports
            .iter()
            .find(|report| report.name == set.archives[0].identity.name)
            .unwrap();
        assert!(reported.current);
        assert_eq!(reported.reported_version.as_deref(), Some("1.0.0"));
        assert!(reported.last_seen_at.is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_stale_handshake_asks_for_an_update() {
        let (root, source) = gui_fixture("gui-stale");
        let paths = gui_skills_paths(&root, AgentKind::ClaudeDesktop);
        let set = export_gui_skills(&source, &paths).unwrap();
        report_as_installed(&set, &paths.reports);

        // Athria ships a newer version of the same Skill.
        fs::write(
            source.join(&set.archives[0].identity.name).join("manifest.json"),
            r#"{"version":"2.0.0"}"#,
        )
        .unwrap();

        let status = gui_skills_status(&source, &paths).unwrap();
        assert_eq!(status.status, "outdated");
        assert_eq!(status.stale, vec![set.archives[0].identity.name.clone()]);
        let diagnostic = gui_skills_diagnostic("Claude Desktop", &status).unwrap();
        assert!(diagnostic.contains(&set.archives[0].identity.name));
        assert!(diagnostic.contains("Update MCP / Skills"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_newer_export_verifies_again_after_the_next_handshake() {
        let (root, source) = gui_fixture("gui-reverify");
        let paths = gui_skills_paths(&root, AgentKind::ClaudeDesktop);
        let set = export_gui_skills(&source, &paths).unwrap();
        report_as_installed(&set, &paths.reports);
        fs::write(source.join(&set.archives[0].identity.name).join("SKILL.md"), "---\nname: x\n---\n\nChanged.\n").unwrap();
        assert_eq!(gui_skills_status(&source, &paths).unwrap().status, "outdated");

        let refreshed = export_gui_skills(&source, &paths).unwrap();
        report_as_installed(&refreshed, &paths.reports);
        assert_eq!(gui_skills_status(&source, &paths).unwrap().status, "installed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_a_gui_managed_agent_clears_only_what_athria_prepared() {
        let (root, source) = gui_fixture("gui-remove");
        let paths = gui_skills_paths(&root, AgentKind::ClaudeDesktop);
        let set = export_gui_skills(&source, &paths).unwrap();
        report_as_installed(&set, &paths.reports);
        assert!(paths.reports.is_file());

        remove_gui_skills(&paths).unwrap();
        assert!(!paths.dir.exists());
        assert!(source.join(SKILLS[0]).join("SKILL.md").is_file());
        assert_eq!(gui_skills_status(&source, &paths).unwrap().status, "unverified");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gui_managed_agents_are_skipped_by_filesystem_reconciliation() {
        let (root, source) = gui_fixture("gui-skip");
        let target = root.join("managed");
        install_skills(&source, &target).unwrap();
        assert_eq!(skills_status(&source, &target), "installed");
        assert!(target.join(SKILLS[0]).join(MARKER).is_file());
        // Claude Desktop has no managed Skills folder to scan or reconcile.
        assert!(paths(AgentKind::ClaudeDesktop).unwrap().skills_dir().is_none());
        fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn custom_agents_round_trip_with_stable_paths_and_format() {
        let root = env::temp_dir().join(format!("athria-agent-test-custom-store-{}", Uuid::new_v4()));
        let agent = CustomAgentDefinition {
            id: "custom_test".to_string(),
            name: "Nimbus".to_string(),
            config_path: root.join("nimbus.json"),
            skills_path: root.join("skills"),
            format: McpConfigFormat::Json,
        };
        write_custom_agents(&root, std::slice::from_ref(&agent)).unwrap();
        let stored = read_custom_agents(&root).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, agent.id);
        assert_eq!(stored[0].name, agent.name);
        assert_eq!(stored[0].config_path, agent.config_path);
        assert_eq!(stored[0].skills_path, agent.skills_path);
        assert_eq!(stored[0].format, McpConfigFormat::Json);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_mcp_formats_install_verify_and_remove() {
        let root = env::temp_dir().join(format!("athria-agent-test-custom-mcp-{}", Uuid::new_v4()));
        for (format, file) in [(McpConfigFormat::Json, "mcp.json"), (McpConfigFormat::Toml, "config.toml")] {
            let path = root.join(file);
            install_mcp_for_format(format, &path, "/Athria").unwrap();
            assert_eq!(mcp_status_for_format(format, &path, "/Athria"), "installed");
            remove_mcp_for_format(format, &path).unwrap();
            assert_eq!(mcp_status_for_format(format, &path, "/Athria"), "missing");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_definition_survives_connection_removal() {
        let root = env::temp_dir().join(format!("athria-agent-test-custom-remove-{}", Uuid::new_v4()));
        let agent = CustomAgentDefinition {
            id: "custom_keep".to_string(), name: "Keep Me".to_string(),
            config_path: root.join("mcp.json"), skills_path: root.join("skills"), format: McpConfigFormat::Json,
        };
        write_custom_agents(&root, std::slice::from_ref(&agent)).unwrap();
        install_mcp_for_format(agent.format, &agent.config_path, "/Athria").unwrap();
        remove_mcp_for_format(agent.format, &agent.config_path).unwrap();
        assert_eq!(read_custom_agents(&root).unwrap()[0].id, "custom_keep");
        fs::remove_dir_all(root).unwrap();
    }
}
