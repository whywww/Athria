use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use uuid::Uuid;
use zeroize::Zeroizing;

mod vault;
mod application_ipc;
use application_ipc::{DesktopApplication, dispatch as dispatch_application};
use athria_application::AthriaApplication;
use athria_mcp::{McpService, serve_http, serve_stdio};
use athria_store::SqliteStore;
use vault::{EncryptedSecret, VaultBundle};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceInfo {
    base_url: String,
    token: String,
    mcp_url: String,
}

struct RuntimeState {
    service: ServiceInfo,
    child: Mutex<Option<CommandChild>>,
    vault_key: Mutex<Option<Zeroizing<Vec<u8>>>>,
    application: Mutex<DesktopApplication>,
    database_path: PathBuf,
}

#[derive(Deserialize)]
struct ApiErrorEnvelope {
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

fn credential(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("Athria", &format!("local-user:{name}"))
        .map_err(|error| error.to_string())
}

fn vault_credential(database_uuid: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("Athria", &format!("vault:{database_uuid}:v1")).map_err(|error| error.to_string())
}

fn new_runtime_token() -> String { Uuid::new_v4().simple().to_string() }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    database_path: Option<PathBuf>,
    #[serde(default)]
    data_dir: Option<PathBuf>,
}

#[cfg(windows)]
fn platform_config_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|profile| PathBuf::from(profile).join("AppData").join("Local")))
        .ok_or_else(|| "Athria could not determine the local AppData folder.".to_string())?;
    Ok(base.join("Athria"))
}

#[cfg(target_os = "macos")]
fn platform_config_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "Athria could not determine the home folder.".to_string())?;
    Ok(home.join("Library").join("Application Support").join("Athria"))
}

#[cfg(target_os = "linux")]
fn platform_config_root() -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) { return Ok(PathBuf::from(root).join("athria")); }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "Athria could not determine the Linux home folder.".to_string())?;
    Ok(home.join(".local").join("share").join("athria"))
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_config_root() -> Result<PathBuf, String> { Err("Unsupported Athria desktop host.".to_string()) }

fn read_config_from(root: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(root.join("athria.config.json")).ok()?;
    let config: AppConfig = serde_json::from_str(&content).ok()?;
    config.database_path.filter(|path| path.is_absolute()).map(|path| simplify_path(&path))
        .or_else(|| config.data_dir.filter(|dir| dir.is_absolute()).map(|dir| simplify_path(&dir).join("athria.sqlite3")))
}

// Windows fs::canonicalize returns verbatim paths (\\?\C:\...), which leak into
// config files and the doctor API. Keep user-facing paths in normal form.
fn simplify_path(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

fn write_config_to(root: &Path, database_path: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let config = AppConfig { database_path: Some(database_path.to_path_buf()), data_dir: None };
    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(root.join("athria.config.json"), content).map_err(|error| error.to_string())
}

fn read_configured_database_path() -> Option<PathBuf> {
    platform_config_root().ok().and_then(|root| read_config_from(&root))
}

fn current_database_path() -> PathBuf {
    read_configured_database_path().unwrap_or_else(|| platform_config_root().map(|root| root.join("data").join("athria.sqlite3")).unwrap_or_else(|_| PathBuf::from("athria.sqlite3")))
}

fn extract_xunji_api_key(skill_text: &str) -> Result<String, String> {
    if skill_text.len() > 65_536 { return Err("The Xunji Skill text is too large.".to_string()); }
    let mut keys: Vec<String> = Vec::new();
    for line in skill_text.lines() {
        let lower = line.to_ascii_lowercase();
        if !(lower.contains("authorization") && lower.contains("bearer")) && !lower.contains("x-api-key") { continue; }
        let Some(start) = line.find("xjllm_") else { continue; };
        let key: String = line[start..].chars().take_while(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-')).collect();
        if key.len() > "xjllm_".len() && !keys.contains(&key) { keys.push(key); }
    }
    match keys.len() {
        1 => Ok(keys.remove(0)),
        0 => Err("No valid Xunji API key was found in the exported Skill.".to_string()),
        _ => Err("The exported Skill contains multiple different Xunji API keys.".to_string()),
    }
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener.local_addr().map(|address| address.port()).map_err(|error| error.to_string())
}

#[cfg(feature = "dev-service")]
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

#[cfg(feature = "dev-service")]
fn resolve_dev_bun(project_root: &Path) -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("ATHRIA_BUN") {
        let path = PathBuf::from(configured);
        return path.is_file().then_some(path).ok_or_else(|| {
            "ATHRIA_BUN does not point to a Bun executable. Set it to the native Bun executable or remove it to use the portable/PATH fallback.".to_string()
        });
    }

    #[cfg(windows)]
    let portable = project_root.join(".tools").join("bun").join("bun-windows-x64").join("bun.exe");
    #[cfg(target_os = "macos")]
    let portable = project_root.join(".tools").join("bun").join("bun-darwin-aarch64").join("bun");
    if portable.is_file() {
        return Ok(portable);
    }

    if let Some(path) = std::env::var_os("PATH") {
        let executable_name = if cfg!(windows) { "bun.exe" } else { "bun" };
        if let Some(bun) = std::env::split_paths(&path).map(|directory| directory.join(executable_name)).find(|candidate| candidate.is_file()) {
            return Ok(bun);
        }
    }

    Err("Bun was not found. Set ATHRIA_BUN to the native Bun executable, install the host portable Bun under .tools/bun, or add Bun to PATH.".to_string())
}

fn run_mcp_stdio() -> i32 {
    let store = match SqliteStore::open(current_database_path()) { Ok(store) => store, Err(error) => { eprintln!("Athria could not open the MCP database: {error}"); return 1; } };
    match serve_stdio(McpService::new(AthriaApplication::new(store))) { Ok(()) => 0, Err(error) => { eprintln!("Athria MCP stdio failed: {error}"); 1 } }
}

#[tauri::command]
fn get_service_info(state: State<'_, RuntimeState>) -> ServiceInfo { state.service.clone() }

#[tauri::command]
async fn athria_request(state: State<'_, RuntimeState>, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if method.eq_ignore_ascii_case("POST") && path == "/api/system/backup/preview" {
        return service_post(&state, &path, body.unwrap_or_else(|| json!({}))).await;
    }
    let application = state.application.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    dispatch_application(&application, &state.database_path, &method, &path, body)
}

async fn service_post(state: &RuntimeState, path: &str, body: Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{}{}", state.service.base_url, path))
        .bearer_auth(&state.service.token)
        .json(&body)
        .send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|error| error.to_string())?;
    if status.is_success() { Ok(value) } else {
        let envelope: ApiErrorEnvelope = serde_json::from_value(value).unwrap_or(ApiErrorEnvelope { error: None });
        Err(envelope.error.map(|error| error.message).unwrap_or_else(|| format!("Athria service returned HTTP {status}")))
    }
}

async fn service_get(state: &RuntimeState, path: &str) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(format!("{}{}", state.service.base_url, path))
        .bearer_auth(&state.service.token)
        .send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|error| error.to_string())?;
    if status.is_success() { Ok(value) } else {
        let envelope: ApiErrorEnvelope = serde_json::from_value(value).unwrap_or(ApiErrorEnvelope { error: None });
        Err(envelope.error.map(|error| error.message).unwrap_or_else(|| format!("Athria service returned HTTP {status}")))
    }
}

async fn service_delete(state: &RuntimeState, path: &str) -> Result<Value, String> {
    let response = reqwest::Client::new().delete(format!("{}{}", state.service.base_url, path)).bearer_auth(&state.service.token)
        .send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|error| error.to_string())?;
    if status.is_success() { Ok(value) } else {
        let envelope: ApiErrorEnvelope = serde_json::from_value(value).unwrap_or(ApiErrorEnvelope { error: None });
        Err(envelope.error.map(|error| error.message).unwrap_or_else(|| format!("Athria service returned HTTP {status}")))
    }
}

async fn vault_bundle(state: &RuntimeState) -> Result<VaultBundle, String> {
    serde_json::from_value(service_get(state, "/api/system/vault").await?).map_err(|error| format!("Athria could not read the database vault: {error}"))
}

fn cache_master_key(state: &RuntimeState, database_uuid: &str, master_key: &[u8], persist: Option<bool>) -> Result<(), String> {
    match persist {
        Some(true) => { vault_credential(database_uuid)?.set_password(&vault::encode_master_key(master_key)).map_err(|error| error.to_string())?; }
        Some(false) => { if let Ok(entry) = vault_credential(database_uuid) { let _ = entry.delete_credential(); } }
        None => {}
    }
    *state.vault_key.lock().expect("runtime state poisoned") = Some(Zeroizing::new(master_key.to_vec()));
    Ok(())
}

fn cached_master_key(state: &RuntimeState, bundle: &VaultBundle) -> Option<Zeroizing<Vec<u8>>> {
    if let Some(key) = state.vault_key.lock().expect("runtime state poisoned").as_ref() {
        if bundle.envelope.as_ref().is_some_and(|envelope| vault::verify_master_key(&bundle.database_uuid, key, envelope).is_ok()) {
            return Some(Zeroizing::new(key.to_vec()));
        }
    }
    let encoded = vault_credential(&bundle.database_uuid).ok()?.get_password().ok()?;
    let key = vault::decode_master_key(&encoded).ok()?;
    if bundle.envelope.as_ref().is_some_and(|envelope| vault::verify_master_key(&bundle.database_uuid, &key, envelope).is_ok()) {
        *state.vault_key.lock().expect("runtime state poisoned") = Some(Zeroizing::new(key.to_vec()));
        Some(key)
    } else { None }
}

fn secret_for<'a>(bundle: &'a VaultBundle, source: &str) -> Option<&'a EncryptedSecret> {
    bundle.secrets.iter().find(|secret| secret.source == source)
}

async fn decrypted_connection_key(state: &RuntimeState, source: &str) -> Result<Zeroizing<String>, String> {
    let bundle = vault_bundle(state).await?;
    let envelope = bundle.envelope.as_ref().ok_or_else(|| "This database has no password set yet.".to_string())?;
    let master = cached_master_key(state, &bundle).ok_or_else(|| "This database is locked. Enter its database password to continue.".to_string())?;
    vault::verify_master_key(&bundle.database_uuid, &master, envelope)?;
    let secret = secret_for(&bundle, source).ok_or_else(|| format!("{source} is not configured."))?;
    vault::decrypt_secret(&bundle.database_uuid, secret, &master)
}

async fn save_connection_key(state: &RuntimeState, source: &str, config: Value, plaintext: &str, password: Option<&str>) -> Result<(), String> {
    let bundle = vault_bundle(state).await?;
    if let Some(envelope) = bundle.envelope.as_ref() {
        let master = if let Some(key) = cached_master_key(state, &bundle) { key }
            else if let Some(password) = password { vault::unlock(&bundle.database_uuid, password, envelope)? }
            else { return Err("This database is locked. Enter its database password to continue.".to_string()); };
        let secret = vault::encrypt_secret(&bundle.database_uuid, source, config, plaintext, &master)?;
        service_post(state, &format!("/api/system/vault/secrets/{source}"), json!({ "secret": secret })).await?;
        cache_master_key(state, &bundle.database_uuid, &master, None)?;
        return Ok(());
    }
    let password = password.ok_or_else(|| "Set a database password before saving the first connection.".to_string())?;
    let master = vault::new_master_key();
    let envelope = vault::create_envelope(&bundle.database_uuid, password, &master)?;
    let secret = vault::encrypt_secret(&bundle.database_uuid, source, config, plaintext, &master)?;
    service_post(state, "/api/system/vault/initialize", json!({ "envelope": envelope, "secrets": [secret] })).await?;
    cache_master_key(state, &bundle.database_uuid, &master, None)
}

#[tauri::command]
async fn vault_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    let initialized = bundle.envelope.is_some();
    let locked = initialized && cached_master_key(&state, &bundle).is_none();
    let legacy_sources: Vec<&str> = [("intervals", "intervals-api-key"), ("xunji", "xunji-api-key")].into_iter()
        .filter_map(|(source, name)| credential(name).ok()?.get_password().ok().filter(|value| !value.is_empty()).map(|_| source)).collect();
    Ok(json!({ "databaseUuid": bundle.database_uuid, "initialized": initialized, "locked": locked, "legacySources": legacy_sources }))
}

#[tauri::command]
async fn setup_vault(state: State<'_, RuntimeState>, password: String) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    if bundle.envelope.is_some() { return Err("This database already has a password.".to_string()); }
    let master = vault::new_master_key();
    let envelope = vault::create_envelope(&bundle.database_uuid, &password, &master)?;
    let mut secrets = Vec::new();
    if let Ok(api_key) = credential("intervals-api-key").and_then(|entry| entry.get_password().map_err(|error| error.to_string())) {
        if !api_key.is_empty() {
            let athlete_id = credential("intervals-athlete-id").ok().and_then(|entry| entry.get_password().ok()).unwrap_or_else(|| "0".to_string());
            secrets.push(vault::encrypt_secret(&bundle.database_uuid, "intervals", json!({ "athleteId": athlete_id }), &api_key, &master)?);
        }
    }
    if let Ok(api_key) = credential("xunji-api-key").and_then(|entry| entry.get_password().map_err(|error| error.to_string())) {
        if !api_key.is_empty() { secrets.push(vault::encrypt_secret(&bundle.database_uuid, "xunji", json!({}), &api_key, &master)?); }
    }
    service_post(&state, "/api/system/vault/initialize", json!({ "envelope": envelope, "secrets": secrets })).await?;
    cache_master_key(&state, &bundle.database_uuid, &master, Some(true))?;
    for name in ["intervals-api-key", "intervals-athlete-id", "xunji-api-key"] {
        if let Ok(entry) = credential(name) { let _ = entry.delete_credential(); }
    }
    Ok(json!({ "status": "unlocked" }))
}

#[tauri::command]
async fn unlock_vault(state: State<'_, RuntimeState>, password: String, remember: bool) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    let envelope = bundle.envelope.as_ref().ok_or_else(|| "This database has no password set yet.".to_string())?;
    let master = vault::unlock(&bundle.database_uuid, &password, envelope)?;
    cache_master_key(&state, &bundle.database_uuid, &master, Some(remember))?;
    Ok(json!({ "status": "unlocked" }))
}

#[tauri::command]
async fn change_vault_password(state: State<'_, RuntimeState>, current_password: Option<String>, new_password: String) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    let old_envelope = bundle.envelope.as_ref().ok_or_else(|| "This database has no password set yet.".to_string())?;
    let master = if let Some(key) = cached_master_key(&state, &bundle) { key }
        else { vault::unlock(&bundle.database_uuid, current_password.as_deref().ok_or_else(|| "Enter the current database password.".to_string())?, old_envelope)? };
    let envelope = vault::create_envelope(&bundle.database_uuid, &new_password, &master)?;
    service_post(&state, "/api/system/vault/envelope", json!({ "envelope": envelope })).await?;
    cache_master_key(&state, &bundle.database_uuid, &master, None)?;
    Ok(json!({ "status": "changed" }))
}

#[tauri::command]
async fn reset_vault_password(state: State<'_, RuntimeState>, password: String) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    if bundle.envelope.is_none() { return Err("This database has no password set yet.".to_string()); }
    let master = vault::new_master_key();
    let envelope = vault::create_envelope(&bundle.database_uuid, &password, &master)?;
    service_post(&state, "/api/system/vault/reset", json!({ "envelope": envelope })).await?;
    cache_master_key(&state, &bundle.database_uuid, &master, Some(true))?;
    Ok(json!({ "status": "reset" }))
}

#[tauri::command]
async fn disconnect_connection(state: State<'_, RuntimeState>, source: String) -> Result<Value, String> {
    if !matches!(source.as_str(), "intervals" | "xunji") { return Err("Unsupported connection source.".to_string()); }
    service_delete(&state, &format!("/api/system/vault/secrets/{source}")).await
}

#[tauri::command]
async fn test_intervals_credentials(state: State<'_, RuntimeState>, mut api_key: String, athlete_id: String, vault_password: Option<String>) -> Result<Value, String> {
    let result = service_post(&state, "/api/connections/intervals/test", json!({ "apiKey": api_key, "athleteId": athlete_id })).await?;
    let saved = save_connection_key(&state, "intervals", json!({ "athleteId": athlete_id }), &api_key, vault_password.as_deref()).await;
    vault::clear_string(&mut api_key);
    saved?;
    Ok(result)
}

#[tauri::command]
async fn sync_intervals(state: State<'_, RuntimeState>, range: Option<Value>) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    let secret = secret_for(&bundle, "intervals").ok_or_else(|| "Intervals.icu is not configured".to_string())?;
    let athlete_id = secret.config.get("athleteId").and_then(Value::as_str).unwrap_or("0").to_string();
    let api_key = decrypted_connection_key(&state, "intervals").await?;
    service_post(&state, "/api/connections/intervals/sync", json!({ "apiKey": api_key.as_str(), "athleteId": athlete_id, "range": range.unwrap_or_else(|| json!("incremental")) })).await
}

#[tauri::command]
async fn intervals_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    let secret = secret_for(&bundle, "intervals");
    let configured = secret.is_some();
    let athlete_id = secret.and_then(|value| value.config.get("athleteId")).and_then(Value::as_str).unwrap_or("0").to_string();
    let locked = bundle.envelope.is_some() && cached_master_key(&state, &bundle).is_none();
    let sync = service_get(&state, "/api/connections/intervals/status").await?;
    Ok(json!({ "configured": configured, "athleteId": athlete_id, "locked": locked, "sync": sync }))
}

#[tauri::command]
async fn import_xunji_skill(state: State<'_, RuntimeState>, skill_text: String, vault_password: Option<String>) -> Result<Value, String> {
    let mut api_key = extract_xunji_api_key(&skill_text)?;
    let result = service_post(&state, "/api/connections/xunji/sync", json!({ "apiKey": api_key, "days": 90, "replaceCredential": true })).await?;
    let saved = save_connection_key(&state, "xunji", json!({}), &api_key, vault_password.as_deref()).await;
    vault::clear_string(&mut api_key);
    saved?;
    Ok(result)
}

#[tauri::command]
async fn sync_xunji(state: State<'_, RuntimeState>, range: Option<Value>) -> Result<Value, String> {
    let api_key = decrypted_connection_key(&state, "xunji").await.map_err(|_| "Xunji is not configured or its saved key is locked.".to_string())?;
    service_post(&state, "/api/connections/xunji/sync", json!({ "apiKey": api_key.as_str(), "range": range.unwrap_or_else(|| json!("incremental")) })).await
}

#[tauri::command]
async fn xunji_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let bundle = vault_bundle(&state).await?;
    let configured = secret_for(&bundle, "xunji").is_some();
    let locked = bundle.envelope.is_some() && cached_master_key(&state, &bundle).is_none();
    let sync = service_get(&state, "/api/connections/xunji/status").await?;
    Ok(json!({ "configured": configured, "locked": locked, "sync": sync }))
}

#[tauri::command]
fn mcp_status() -> Result<Value, String> {
    let executable = std::env::current_exe().map_err(|error| format!("Athria could not determine its installation path: {error}"))?;
    let executable_path = executable.to_str().ok_or_else(|| "Athria's installation path contains unsupported characters.".to_string())?;
    Ok(json!({
        "configured": true,
        "executablePath": executable_path,
        "arguments": ["mcp"]
    }))
}

#[tauri::command]
async fn pick_restore_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Athria database", &["sqlite3"])
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_new_profile_destination(app: AppHandle) -> Option<String> {
    app.dialog().file().add_filter("Athria database", &["sqlite3"]).set_file_name("athria-profile.sqlite3")
        .blocking_save_file().and_then(|file| file.into_path().ok()).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn restore_backup(app: AppHandle, state: State<'_, RuntimeState>, path: String) -> Result<Value, String> {
    let selected = PathBuf::from(&path);
    if !selected.is_absolute() { return Err("The selected backup path must be absolute.".to_string()); }
    let selected = simplify_path(&fs::canonicalize(&selected).map_err(|error| format!("Athria could not open the selected backup: {error}"))?);
    if selected.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("sqlite3")) || !selected.is_file() {
        return Err("Select an existing .sqlite3 file.".to_string());
    }
    if selected == simplify_path(&fs::canonicalize(current_database_path()).map_err(|error| format!("Athria could not open the current database: {error}"))?) {
        return Err("That database is already active.".to_string());
    }
    fs::OpenOptions::new().read(true).write(true).open(&selected).map_err(|error| format!("Athria needs write access to use this database: {error}"))?;
    service_post(&state, "/api/system/backup/preview", json!({ "path": selected })).await?;
    if let Some(child) = state.child.lock().expect("runtime state poisoned").take() { let _ = child.kill(); std::thread::sleep(Duration::from_millis(600)); }
    write_config_to(&platform_config_root()?, &selected)?;
    app.restart()
}

// The save dialog may return a path whose file does not exist yet, so the
// target is resolved through its parent folder. Existing files are rejected so
// a mistyped name can never replace a backup or another database.
fn validate_new_profile_target(path: &str, current: &Path) -> Result<PathBuf, String> {
    let selected = PathBuf::from(path);
    if !selected.is_absolute() { return Err("The selected path must be absolute.".to_string()); }
    if selected.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("sqlite3")) {
        return Err("The new database file must end in .sqlite3.".to_string());
    }
    let parent = selected.parent().ok_or_else(|| "The selected path has no parent folder.".to_string())?;
    let file_name = selected.file_name().ok_or_else(|| "The selected path has no file name.".to_string())?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| format!("Athria could not open the selected folder: {error}"))?;
    let target = simplify_path(&canonical_parent.join(file_name));
    if let Ok(current) = fs::canonicalize(current) {
        if target == simplify_path(&current) { return Err("That is the active Athria database. Choose a different file name.".to_string()); }
    }
    if target.exists() { return Err("A file already exists at this path. Choose a different file name.".to_string()); }
    Ok(target)
}

#[tauri::command]
async fn create_new_profile(app: AppHandle, state: State<'_, RuntimeState>, path: String, password: String) -> Result<Value, String> {
    let target = validate_new_profile_target(&path, &current_database_path())?;
    let database_uuid = Uuid::new_v4().to_string();
    let master = vault::new_master_key();
    let envelope = vault::create_envelope(&database_uuid, &password, &master)?;
    service_post(&state, "/api/system/profile/create", json!({ "path": target, "databaseUuid": database_uuid, "envelope": envelope })).await?;
    cache_master_key(&state, &database_uuid, &master, Some(true))?;
    if let Some(child) = state.child.lock().expect("runtime state poisoned").take() { let _ = child.kill(); std::thread::sleep(Duration::from_millis(600)); }
    write_config_to(&platform_config_root()?, &target)?;
    app.restart()
}

pub fn run() -> i32 {
    if std::env::args().nth(1).as_deref() == Some("mcp") { return run_mcp_stdio(); }

    #[cfg(feature = "dev-service")]
    let dev_service = {
        let project_root = workspace_root();
        let bun = match resolve_dev_bun(&project_root) { Ok(value) => value, Err(error) => { eprintln!("{error}"); return 1; } };
        let service_entry = project_root.join("apps").join("service").join("src").join("main.ts");
        (project_root, bun, service_entry)
    };
    let port = match free_port() { Ok(value) => value, Err(error) => { eprintln!("{error}"); return 1; } };
    let mcp_listener = match TcpListener::bind("127.0.0.1:0") { Ok(value) => value, Err(error) => { eprintln!("Athria could not bind MCP HTTP: {error}"); return 1; } };
    let mcp_port = match mcp_listener.local_addr() { Ok(value) => value.port(), Err(error) => { eprintln!("Athria could not read the MCP HTTP address: {error}"); return 1; } };
    let token = new_runtime_token();
    let mcp_token = new_runtime_token();
    let service = ServiceInfo { base_url: format!("http://127.0.0.1:{port}"), token: token.clone(), mcp_url: format!("http://127.0.0.1:{mcp_port}/mcp") };
    let service_for_setup = service.clone();
    let database_path = current_database_path();
    let application = match SqliteStore::open(&database_path) {
        Ok(store) => AthriaApplication::new(store),
        Err(error) => { eprintln!("Athria could not open the database: {error}"); return 1; }
    };
    let mcp_application = match SqliteStore::open(&database_path) { Ok(store) => AthriaApplication::new(store), Err(error) => { eprintln!("Athria could not open the MCP database: {error}"); return 1; } };
    let rust_mcp_token = mcp_token.clone();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(RuntimeState { service, child: Mutex::new(None), vault_key: Mutex::new(None), application: Mutex::new(application), database_path: database_path.clone() })
        .invoke_handler(tauri::generate_handler![athria_request, get_service_info, vault_status, setup_vault, unlock_vault, change_vault_password, reset_vault_password, disconnect_connection, test_intervals_credentials, sync_intervals, intervals_status, import_xunji_skill, sync_xunji, xunji_status, mcp_status, pick_restore_file, pick_new_profile_destination, restore_backup, create_new_profile])
        .setup(move |app| {
            std::thread::spawn(move || { if let Err(error) = serve_http(mcp_listener, McpService::new(mcp_application), &rust_mcp_token) { eprintln!("Athria MCP HTTP stopped: {error}"); } });
            #[cfg(feature = "dev-service")]
            let command = {
                let (project_root, bun, service_entry) = dev_service;
                app.shell().command(bun)
                    .args(["--watch".as_ref(), service_entry.as_os_str(), "serve".as_ref()])
                    .current_dir(project_root)
            };
            #[cfg(not(feature = "dev-service"))]
            let command = app.shell().sidecar("athria-service")?
                .args(["serve"]);
            let command = command
                .env("ATHRIA_PORT", port.to_string())
                .env("ATHRIA_SESSION_TOKEN", token)
                .env("ATHRIA_MCP_TOKEN", mcp_token)
                .env("ATHRIA_PARENT_PID", std::process::id().to_string())
                .env("ATHRIA_DATABASE_PATH", database_path);
            let (mut events, child) = command.spawn()?;
            *app.state::<RuntimeState>().child.lock().expect("runtime state poisoned") = Some(child);
            let address = format!("127.0.0.1:{port}").parse().map_err(|error| std::io::Error::other(format!("Invalid service address: {error}")))?;
            let mut ready = false;
            for _ in 0..100 {
                if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() { ready = true; break; }
                std::thread::sleep(Duration::from_millis(50));
            }
            if !ready {
                if let Some(child) = app.state::<RuntimeState>().child.lock().expect("runtime state poisoned").take() { let _ = child.kill(); }
                return Err(std::io::Error::other("Athria service did not become healthy within five seconds").into());
            }
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        tauri_plugin_shell::process::CommandEvent::Stderr(bytes) => eprintln!("{}", String::from_utf8_lossy(&bytes)),
                        tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                            let _ = app_handle.emit("athria-service-crashed", json!({ "code": payload.code, "signal": payload.signal }));
                        }
                        _ => {}
                    }
                }
            });
            let _ = &service_for_setup;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(child) = window.state::<RuntimeState>().child.lock().expect("runtime state poisoned").take() { let _ = child.kill(); }
            }
        })
        .run(tauri::generate_context!());
    match result { Ok(()) => 0, Err(error) => { eprintln!("Athria failed: {error}"); 1 } }
}

#[cfg(test)]
mod tests {
    use super::{extract_xunji_api_key, mcp_status, new_runtime_token, read_config_from, simplify_path, validate_new_profile_target, write_config_to};
    use uuid::Uuid;

    fn temp_root(prefix: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn extracts_bearer_and_api_key_headers() {
        let key = "xjllm_example-123";
        assert_eq!(extract_xunji_api_key(&format!("Authorization: Bearer {key}")), Ok(key.to_string()));
        assert_eq!(extract_xunji_api_key(&format!("请求头: `x-api-key: {key}`")), Ok(key.to_string()));
    }

    #[test]
    fn rejects_missing_ambiguous_and_oversized_input() {
        assert!(extract_xunji_api_key("no credential").is_err());
        assert!(extract_xunji_api_key("Authorization: Bearer xjllm_one\nx-api-key: xjllm_two").is_err());
        assert!(extract_xunji_api_key(&"x".repeat(65_537)).is_err());
    }

    #[test]
    fn accepts_repeated_occurrences_of_the_same_key() {
        assert_eq!(extract_xunji_api_key("Authorization: Bearer xjllm_same\nx-api-key: xjllm_same"), Ok("xjllm_same".to_string()));
    }

    #[test]
    fn reports_the_current_executable_for_mcp_stdio() {
        let expected = std::env::current_exe().unwrap();
        let status = mcp_status().unwrap();
        assert_eq!(status["configured"], true);
        assert_eq!(status["executablePath"], expected.to_str().unwrap());
        assert_eq!(status["arguments"], serde_json::json!(["mcp"]));
        assert!(expected.is_absolute());
    }

    #[test]
    fn creates_distinct_runtime_tokens() {
        let first = new_runtime_token();
        let second = new_runtime_token();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn round_trips_the_configured_database_path() {
        let root = temp_root("athria-config");
        assert!(read_config_from(&root).is_none());
        let target = root.join("custom.sqlite3");
        write_config_to(&root, &target).unwrap();
        assert_eq!(read_config_from(&root), Some(target));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_a_legacy_data_dir_as_a_database_path() {
        let root = temp_root("athria-config-legacy");
        let data = root.join("legacy-data");
        std::fs::write(root.join("athria.config.json"), serde_json::json!({ "dataDir": data }).to_string()).unwrap();
        assert_eq!(read_config_from(&root), Some(data.join("athria.sqlite3")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ignores_relative_paths_in_the_config() {
        let root = temp_root("athria-config-relative");
        write_config_to(&root, std::path::Path::new("relative/data")).unwrap();
        assert!(read_config_from(&root).is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn strips_verbatim_prefixes_from_stored_paths() {
        assert_eq!(simplify_path(std::path::Path::new(r"\\?\C:\Users\tclre\Fitness\data")), std::path::PathBuf::from(r"C:\Users\tclre\Fitness\data"));
        assert_eq!(simplify_path(std::path::Path::new(r"\\?\UNC\server\share\data")), std::path::PathBuf::from(r"\\server\share\data"));
        assert_eq!(simplify_path(std::path::Path::new(r"C:\Athria\data")), std::path::PathBuf::from(r"C:\Athria\data"));
    }

    #[test]
    #[cfg(windows)]
    fn normalizes_verbatim_paths_when_reading_the_config() {
        let root = temp_root("athria-config-verbatim");
        let target = root.join("custom.sqlite3");
        write_config_to(&root, std::path::Path::new(&format!(r"\\?\{}", target.display()))).unwrap();
        assert_eq!(read_config_from(&root), Some(target));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn accepts_a_new_profile_path_beside_the_active_database() {
        let root = temp_root("athria-profile");
        let current = root.join("athria.sqlite3");
        std::fs::write(&current, b"active").unwrap();
        let target = root.join("fresh.sqlite3");
        assert_eq!(validate_new_profile_target(target.to_str().unwrap(), &current), Ok(target));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_non_sqlite_and_relative_new_profile_targets() {
        let root = temp_root("athria-profile-name");
        let current = root.join("athria.sqlite3");
        std::fs::write(&current, b"active").unwrap();
        let wrong_extension = root.join("fresh.txt");
        assert!(validate_new_profile_target(wrong_extension.to_str().unwrap(), &current).unwrap_err().contains(".sqlite3"));
        assert!(validate_new_profile_target("fresh.sqlite3", &current).unwrap_err().contains("absolute"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_existing_or_active_new_profile_targets() {
        let root = temp_root("athria-profile-conflict");
        let current = root.join("athria.sqlite3");
        std::fs::write(&current, b"active").unwrap();
        let existing = root.join("existing.sqlite3");
        std::fs::write(&existing, b"keep").unwrap();
        assert!(validate_new_profile_target(existing.to_str().unwrap(), &current).unwrap_err().contains("already exists"));
        assert!(validate_new_profile_target(current.to_str().unwrap(), &current).unwrap_err().contains("active Athria database"));
        assert_eq!(std::fs::read(&existing).unwrap(), b"keep");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
