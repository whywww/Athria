use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}},
};
use tauri::{
    AppHandle, Manager, State, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use zeroize::Zeroizing;

mod application_ipc;
mod agent_integrations;
use application_ipc::{DesktopApplication, dispatch as dispatch_application};
use agent_integrations::{AgentKind, SkillUpdateAction, home_dir, resource_skills};
use athria_application::AthriaApplication;
use athria_integrations::{
    XUNJI_SYNC_DAYS, fetch_intervals, fetch_xunji_training, sync_date_window,
};
use athria_mcp::{McpService, serve_http_with_refresh, serve_stdio_with_refresh};
use athria_runtime::{ReqwestHttpClient, create_local_workspace, preview_backup};
use athria_store::SqliteStore;
use athria_vault::{self as vault, EncryptedSecret, VaultBundle};

struct RuntimeState {
    vault_key: Mutex<Option<Zeroizing<Vec<u8>>>>,
    application: Mutex<DesktopApplication>,
    database_path: Mutex<PathBuf>,
    generation: AtomicU64,
    switch_lock: Mutex<()>,
}

fn credential(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("Athria", &format!("local-user:{name}")).map_err(|error| error.to_string())
}

fn vault_credential(database_uuid: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("Athria", &format!("vault:{database_uuid}:v1"))
        .map_err(|error| error.to_string())
}

fn new_runtime_token() -> String {
    Uuid::new_v4().simple().to_string()
}

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
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|profile| PathBuf::from(profile).join("AppData").join("Local"))
        })
        .ok_or_else(|| "Athria could not determine the local AppData folder.".to_string())?;
    Ok(base.join("Athria"))
}

#[cfg(target_os = "macos")]
fn platform_config_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Athria could not determine the home folder.".to_string())?;
    Ok(home
        .join("Library")
        .join("Application Support")
        .join("Athria"))
}

#[cfg(target_os = "linux")]
fn platform_config_root() -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(root).join("athria"));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Athria could not determine the Linux home folder.".to_string())?;
    Ok(home.join(".local").join("share").join("athria"))
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_config_root() -> Result<PathBuf, String> {
    Err("Unsupported Athria desktop host.".to_string())
}

fn read_config_from(root: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(root.join("athria.config.json")).ok()?;
    let config: AppConfig = serde_json::from_str(&content).ok()?;
    config
        .database_path
        .filter(|path| path.is_absolute())
        .map(|path| simplify_path(&path))
        .or_else(|| {
            config
                .data_dir
                .filter(|dir| dir.is_absolute())
                .map(|dir| simplify_path(&dir).join("athria.sqlite3"))
        })
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
    let config = AppConfig {
        database_path: Some(database_path.to_path_buf()),
        data_dir: None,
    };
    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    let target = root.join("athria.config.json");
    let temporary = root.join(format!("athria.config.{}.tmp", Uuid::new_v4().simple()));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let committed = {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0 }
    };
    #[cfg(not(windows))]
    let committed = fs::rename(&temporary, &target).is_ok();
    if !committed {
        let error = std::io::Error::last_os_error();
        let _ = fs::remove_file(&temporary);
        return Err(format!("Athria could not save the active database: {error}"));
    }
    Ok(())
}

fn checked_database_path() -> Result<PathBuf, String> {
    checked_database_path_at(&platform_config_root()?)
}

fn checked_database_path_at(root: &Path) -> Result<PathBuf, String> {
    if root.join("athria.config.json").exists() {
        read_config_from(&root).ok_or_else(|| "Athria database configuration is invalid.".to_string())
    } else {
        Ok(root.join("data").join("athria.sqlite3"))
    }
}

fn extract_xunji_api_key(skill_text: &str) -> Result<String, String> {
    if skill_text.len() > 65_536 {
        return Err("The Xunji Skill text is too large.".to_string());
    }
    let mut keys: Vec<String> = Vec::new();
    for line in skill_text.lines() {
        let lower = line.to_ascii_lowercase();
        if !(lower.contains("authorization") && lower.contains("bearer"))
            && !lower.contains("x-api-key")
        {
            continue;
        }
        let Some(start) = line.find("xjllm_") else {
            continue;
        };
        let key: String = line[start..]
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
            .collect();
        if key.len() > "xjllm_".len() && !keys.contains(&key) {
            keys.push(key);
        }
    }
    match keys.len() {
        1 => Ok(keys.remove(0)),
        0 => Err("No valid Xunji API key was found in the exported Skill.".to_string()),
        _ => Err("The exported Skill contains multiple different Xunji API keys.".to_string()),
    }
}

fn run_mcp_stdio() -> i32 {
    let database_path = match checked_database_path() {
        Ok(path) => path,
        Err(error) => { eprintln!("{error}"); return 1; }
    };
    let store = match SqliteStore::open(&database_path) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("Athria could not open the MCP database: {error}");
            return 1;
        }
    };
    match serve_stdio_with_refresh(mcp_service(AthriaApplication::new(store)), Some(mcp_refresh(database_path))) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Athria MCP stdio failed: {error}");
            1
        }
    }
}

/// Wires the Skill handshake report sink, which is how Athria verifies the
/// Skills a GUI-managed agent (Claude Desktop) actually loaded.
fn mcp_service(application: AthriaApplication<SqliteStore>) -> McpService<SqliteStore> {
    let service = McpService::new(application);
    match platform_config_root() {
        Ok(root) => service.with_skill_reports(agent_integrations::gui_skill_reports_path(
            &root,
            AgentKind::ClaudeDesktop,
        )),
        Err(_) => service,
    }
}

fn mcp_refresh(initial_path: PathBuf) -> Arc<dyn Fn(&mut McpService<SqliteStore>) -> Result<(), String> + Send + Sync> {
    let active_path = Mutex::new(initial_path);
    Arc::new(move |service| {
        let configured = checked_database_path()?;
        let mut active = active_path.lock().map_err(|_| "MCP database state is unavailable.".to_string())?;
        if *active != configured {
            let store = SqliteStore::open(&configured).map_err(|error| error.message().to_owned())?;
            service.replace_application(AthriaApplication::new(store));
            *active = configured;
        }
        Ok(())
    })
}

fn database_generation(state: &RuntimeState) -> u64 {
    state.generation.load(Ordering::SeqCst)
}

fn ensure_generation(state: &RuntimeState, expected: u64) -> Result<(), String> {
    if database_generation(state) == expected { Ok(()) } else {
        Err("The database changed while this operation was running. Try again.".to_string())
    }
}

#[tauri::command]
async fn athria_request(
    state: State<'_, RuntimeState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if method.eq_ignore_ascii_case("POST") && path == "/api/system/backup/preview" {
        let selected = body
            .and_then(|value| value.get("path").and_then(Value::as_str).map(PathBuf::from))
            .ok_or_else(|| "A backup path is required.".to_string())?;
        let database_path = state.database_path.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?.clone();
        return serde_json::to_value(
            preview_backup(
                &selected,
                database_path.parent().unwrap_or(Path::new(".")),
            )
            .map_err(|error| error.message().to_owned())?,
        )
        .map_err(|error| error.to_string());
    }
    let application = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    let database_path = state.database_path.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    dispatch_application(&application, &database_path, &method, &path, body)
}

async fn vault_bundle(state: &RuntimeState) -> Result<VaultBundle, String> {
    state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?
        .store()
        .get_vault()
        .map_err(|error| error.message().to_owned())
}

fn cache_master_key(
    state: &RuntimeState,
    database_uuid: &str,
    master_key: &[u8],
    persist: Option<bool>,
) -> Result<(), String> {
    match persist {
        Some(true) => {
            vault_credential(database_uuid)?
                .set_password(&vault::encode_master_key(master_key))
                .map_err(|error| error.to_string())?;
        }
        Some(false) => {
            if let Ok(entry) = vault_credential(database_uuid) {
                let _ = entry.delete_credential();
            }
        }
        None => {}
    }
    *state.vault_key.lock().expect("runtime state poisoned") =
        Some(Zeroizing::new(master_key.to_vec()));
    Ok(())
}

fn cached_master_key(state: &RuntimeState, bundle: &VaultBundle) -> Option<Zeroizing<Vec<u8>>> {
    if let Some(key) = state
        .vault_key
        .lock()
        .expect("runtime state poisoned")
        .as_ref()
    {
        if bundle.envelope.as_ref().is_some_and(|envelope| {
            vault::verify_master_key(&bundle.database_uuid, key, envelope).is_ok()
        }) {
            return Some(Zeroizing::new(key.to_vec()));
        }
    }
    let key = remembered_master_key(bundle)?;
    *state.vault_key.lock().expect("runtime state poisoned") = Some(Zeroizing::new(key.to_vec()));
    Some(key)
}

fn remembered_master_key(bundle: &VaultBundle) -> Option<Zeroizing<Vec<u8>>> {
    let encoded = vault_credential(&bundle.database_uuid)
        .ok()?
        .get_password()
        .ok()?;
    let key = vault::decode_master_key(&encoded).ok()?;
    if bundle.envelope.as_ref().is_some_and(|envelope| {
        vault::verify_master_key(&bundle.database_uuid, &key, envelope).is_ok()
    }) {
        Some(key)
    } else {
        None
    }
}

fn secret_for<'a>(bundle: &'a VaultBundle, source: &str) -> Option<&'a EncryptedSecret> {
    bundle.secrets.iter().find(|secret| secret.source == source)
}

async fn decrypted_connection_key(
    state: &RuntimeState,
    source: &str,
) -> Result<Zeroizing<String>, String> {
    let bundle = vault_bundle(state).await?;
    let envelope = bundle
        .envelope
        .as_ref()
        .ok_or_else(|| "This database has no password set yet.".to_string())?;
    let master = cached_master_key(state, &bundle).ok_or_else(|| {
        "This database is locked. Enter its database password to continue.".to_string()
    })?;
    vault::verify_master_key(&bundle.database_uuid, &master, envelope)?;
    let secret =
        secret_for(&bundle, source).ok_or_else(|| format!("{source} is not configured."))?;
    vault::decrypt_secret(&bundle.database_uuid, secret, &master)
}

async fn save_connection_key(
    state: &RuntimeState,
    expected_generation: u64,
    source: &str,
    config: Value,
    plaintext: &str,
    password: Option<&str>,
) -> Result<(), String> {
    ensure_generation(state, expected_generation)?;
    let bundle = vault_bundle(state).await?;
    if let Some(envelope) = bundle.envelope.as_ref() {
        let master = if let Some(key) = cached_master_key(state, &bundle) {
            key
        } else if let Some(password) = password {
            vault::unlock(&bundle.database_uuid, password, envelope)?
        } else {
            return Err(
                "This database is locked. Enter its database password to continue.".to_string(),
            );
        };
        let secret =
            vault::encrypt_secret(&bundle.database_uuid, source, config, plaintext, &master)?;
        let application = state
            .application
            .lock()
            .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
        ensure_generation(state, expected_generation)?;
        application
            .store()
            .upsert_connection_secret(&secret)
            .map_err(|error| error.message().to_owned())?;
        cache_master_key(state, &bundle.database_uuid, &master, None)?;
        return Ok(());
    }
    let password = password
        .ok_or_else(|| "Set a database password before saving the first connection.".to_string())?;
    let master = vault::new_master_key();
    let envelope = vault::create_envelope(&bundle.database_uuid, password, &master)?;
    let secret = vault::encrypt_secret(&bundle.database_uuid, source, config, plaintext, &master)?;
    let application = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    ensure_generation(state, expected_generation)?;
    application
        .store()
        .initialize_vault(&envelope, &[secret])
        .map_err(|error| error.message().to_owned())?;
    cache_master_key(state, &bundle.database_uuid, &master, None)
}

#[tauri::command]
async fn vault_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let (bundle, database_path) = {
        let application = state.application.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
        let path = state.database_path.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?.clone();
        (application.store().get_vault().map_err(|error| error.message().to_owned())?, path)
    };
    let initialized = bundle.envelope.is_some();
    let remembered = initialized && remembered_master_key(&bundle).is_some();
    let locked = initialized && cached_master_key(&state, &bundle).is_none();
    let legacy_sources: Vec<&str> = [
        ("intervals", "intervals-api-key"),
        ("xunji", "xunji-api-key"),
    ]
    .into_iter()
    .filter_map(|(source, name)| {
        credential(name)
            .ok()?
            .get_password()
            .ok()
            .filter(|value| !value.is_empty())
            .map(|_| source)
    })
    .collect();
    Ok(json!({ "databaseUuid": bundle.database_uuid, "databasePath": database_path, "initialized": initialized, "locked": locked, "remembered": remembered, "legacySources": legacy_sources }))
}

#[tauri::command]
async fn setup_vault(
    state: State<'_, RuntimeState>,
    password: String,
    remember: bool,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    if bundle.envelope.is_some() {
        return Err("This database already has a password.".to_string());
    }
    let master = vault::new_master_key();
    let envelope = vault::create_envelope(&bundle.database_uuid, &password, &master)?;
    let mut secrets = Vec::new();
    if let Ok(api_key) = credential("intervals-api-key")
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
    {
        if !api_key.is_empty() {
            let athlete_id = credential("intervals-athlete-id")
                .ok()
                .and_then(|entry| entry.get_password().ok())
                .unwrap_or_else(|| "0".to_string());
            secrets.push(vault::encrypt_secret(
                &bundle.database_uuid,
                "intervals",
                json!({ "athleteId": athlete_id }),
                &api_key,
                &master,
            )?);
        }
    }
    if let Ok(api_key) = credential("xunji-api-key")
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
    {
        if !api_key.is_empty() {
            secrets.push(vault::encrypt_secret(
                &bundle.database_uuid,
                "xunji",
                json!({}),
                &api_key,
                &master,
            )?);
        }
    }
    let application = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    ensure_generation(&state, generation)?;
    application
        .store()
        .initialize_vault(&envelope, &secrets)
        .map_err(|error| error.message().to_owned())?;
    cache_master_key(&state, &bundle.database_uuid, &master, Some(remember))?;
    drop(application);
    for name in ["intervals-api-key", "intervals-athlete-id", "xunji-api-key"] {
        if let Ok(entry) = credential(name) {
            let _ = entry.delete_credential();
        }
    }
    Ok(json!({ "status": "unlocked" }))
}

#[tauri::command]
async fn unlock_vault(
    state: State<'_, RuntimeState>,
    password: String,
    remember: bool,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    let envelope = bundle
        .envelope
        .as_ref()
        .ok_or_else(|| "This database has no password set yet.".to_string())?;
    let master = vault::unlock(&bundle.database_uuid, &password, envelope)?;
    ensure_generation(&state, generation)?;
    cache_master_key(&state, &bundle.database_uuid, &master, Some(remember))?;
    Ok(json!({ "status": "unlocked" }))
}

#[tauri::command]
async fn change_vault_password(
    state: State<'_, RuntimeState>,
    current_password: String,
    new_password: String,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    let old_envelope = bundle
        .envelope
        .as_ref()
        .ok_or_else(|| "This database has no password set yet.".to_string())?;
    let master = vault::unlock(&bundle.database_uuid, &current_password, old_envelope)?;
    let envelope = vault::create_envelope(&bundle.database_uuid, &new_password, &master)?;
    let application = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    ensure_generation(&state, generation)?;
    application
        .store()
        .update_vault_envelope(&envelope)
        .map_err(|error| error.message().to_owned())?;
    cache_master_key(&state, &bundle.database_uuid, &master, None)?;
    Ok(json!({ "status": "changed" }))
}

#[tauri::command]
async fn require_vault_password(
    state: State<'_, RuntimeState>,
    current_password: String,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    let envelope = bundle
        .envelope
        .as_ref()
        .ok_or_else(|| "This database has no password set yet.".to_string())?;
    let master = vault::unlock(&bundle.database_uuid, &current_password, envelope)?;
    ensure_generation(&state, generation)?;
    let entry = vault_credential(&bundle.database_uuid)?;
    if let Err(error) = entry.delete_credential() {
        if !matches!(error, keyring::Error::NoEntry) {
            return Err(format!(
                "Athria could not stop remembering this database: {error}"
            ));
        }
    }
    cache_master_key(&state, &bundle.database_uuid, &master, None)?;
    Ok(json!({ "status": "password-required" }))
}

#[tauri::command]
async fn reset_vault_password(
    state: State<'_, RuntimeState>,
    password: String,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    if bundle.envelope.is_none() {
        return Err("This database has no password set yet.".to_string());
    }
    let master = vault::new_master_key();
    let envelope = vault::create_envelope(&bundle.database_uuid, &password, &master)?;
    let application = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    ensure_generation(&state, generation)?;
    application
        .store()
        .reset_vault(&envelope)
        .map_err(|error| error.message().to_owned())?;
    cache_master_key(&state, &bundle.database_uuid, &master, Some(true))?;
    Ok(json!({ "status": "reset" }))
}

#[tauri::command]
async fn disconnect_connection(
    state: State<'_, RuntimeState>,
    source: String,
) -> Result<Value, String> {
    if !matches!(source.as_str(), "intervals" | "xunji") {
        return Err("Unsupported connection source.".to_string());
    }
    let deleted = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?
        .store()
        .delete_connection_secret(&source)
        .map_err(|error| error.message().to_owned())?;
    Ok(json!({ "deleted": deleted }))
}

#[tauri::command]
async fn test_intervals_credentials(
    state: State<'_, RuntimeState>,
    mut api_key: String,
    athlete_id: String,
    vault_password: Option<String>,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let today = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?
        .store()
        .now();
    let payload = fetch_intervals(
        &ReqwestHttpClient::default(),
        &api_key,
        &athlete_id,
        &today,
        None,
        None,
    );
    if let Some(message) = payload.get("wellness").and_then(Value::as_str) {
        vault::clear_string(&mut api_key);
        return Err(message.to_string());
    }
    let result = json!({ "status": "connected", "athleteId": athlete_id });
    let saved = save_connection_key(
        &state,
        generation,
        "intervals",
        json!({ "athleteId": athlete_id }),
        &api_key,
        vault_password.as_deref(),
    )
    .await;
    vault::clear_string(&mut api_key);
    saved?;
    Ok(result)
}

#[tauri::command]
async fn sync_intervals(
    state: State<'_, RuntimeState>,
    range: Option<Value>,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    let secret = secret_for(&bundle, "intervals")
        .ok_or_else(|| "Intervals.icu is not configured".to_string())?;
    let athlete_id = secret
        .config
        .get("athleteId")
        .and_then(Value::as_str)
        .unwrap_or("0")
        .to_string();
    let api_key = decrypted_connection_key(&state, "intervals").await?;
    let (previous, attempted_at) = {
        let app = state
            .application
            .lock()
            .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
        (
            app.get_intervals_sync_status()
                .map_err(|error| error.message().to_owned())?,
            app.store().now(),
        )
    };
    let requested_days = range.as_ref().and_then(Value::as_i64);
    let window = sync_date_window(
        previous
            .as_ref()
            .and_then(|value| value.get("lastSuccessAt"))
            .and_then(Value::as_str),
        requested_days,
        &attempted_at,
    )
    .map_err(|error| error.message().to_owned())?;
    let payload = fetch_intervals(
        &ReqwestHttpClient::default(),
        &api_key,
        &athlete_id,
        &attempted_at,
        Some(&window.range_start),
        Some(&window.range_start),
    );
    let application = state.application.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    ensure_generation(&state, generation)?;
    application.commit_intervals(&payload, &json!({ "attemptedAt": attempted_at, "rangeStart": window.range_start, "rangeEnd": window.range_end })).map_err(|error| error.message().to_owned())
}

#[tauri::command]
async fn intervals_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    let secret = secret_for(&bundle, "intervals");
    let configured = secret.is_some();
    let athlete_id = secret
        .and_then(|value| value.config.get("athleteId"))
        .and_then(Value::as_str)
        .unwrap_or("0")
        .to_string();
    let locked = bundle.envelope.is_some() && cached_master_key(&state, &bundle).is_none();
    let application = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    ensure_generation(&state, generation)?;
    let sync = application
        .get_intervals_sync_status()
        .map_err(|error| error.message().to_owned())?;
    Ok(json!({ "configured": configured, "athleteId": athlete_id, "locked": locked, "sync": sync }))
}

#[tauri::command]
async fn import_xunji_skill(
    state: State<'_, RuntimeState>,
    skill_text: String,
    vault_password: Option<String>,
) -> Result<Value, String> {
    let generation = database_generation(&state);
    let mut api_key = extract_xunji_api_key(&skill_text)?;
    let attempted_at = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?
        .store()
        .now();
    let fetched = fetch_xunji_training(
        &ReqwestHttpClient::default(),
        &api_key,
        XUNJI_SYNC_DAYS,
        &attempted_at,
    )
    .map_err(|_| {
        "Xunji rejected this API key. Export a new Skill from Xunji and try again.".to_string()
    })?;
    let result = {
        let application = state
            .application
            .lock()
            .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
        ensure_generation(&state, generation)?;
        application.commit_xunji(&fetched, &attempted_at)
            .map_err(|error| error.message().to_owned())?
    };
    let saved = save_connection_key(
        &state,
        generation,
        "xunji",
        json!({}),
        &api_key,
        vault_password.as_deref(),
    )
    .await;
    vault::clear_string(&mut api_key);
    saved?;
    Ok(result)
}

#[tauri::command]
async fn sync_xunji(state: State<'_, RuntimeState>, range: Option<Value>) -> Result<Value, String> {
    let generation = database_generation(&state);
    let api_key = decrypted_connection_key(&state, "xunji")
        .await
        .map_err(|_| "Xunji is not configured or its saved key is locked.".to_string())?;
    let (previous, attempted_at) = {
        let app = state
            .application
            .lock()
            .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
        (
            app.get_xunji_sync_status()
                .map_err(|error| error.message().to_owned())?,
            app.store().now(),
        )
    };
    if let Some(last) = previous
        .as_ref()
        .and_then(|value| value.get("lastAttemptAt"))
        .and_then(Value::as_str)
    {
        if athria_core::tz::millis(&attempted_at)
            .ok()
            .zip(athria_core::tz::millis(last).ok())
            .is_some_and(|(now, prior)| now - prior < 30_000)
        {
            return Err("Wait 30 seconds before syncing Xunji again.".to_string());
        }
    }
    let window = sync_date_window(
        previous
            .as_ref()
            .and_then(|value| value.get("lastSuccessAt"))
            .and_then(Value::as_str),
        range
            .as_ref()
            .and_then(Value::as_i64)
            .or(Some(XUNJI_SYNC_DAYS)),
        &attempted_at,
    )
    .map_err(|error| error.message().to_owned())?;
    match fetch_xunji_training(
        &ReqwestHttpClient::default(),
        &api_key,
        window.days,
        &attempted_at,
    ) {
        Ok(fetched) => {
            let application = state.application.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
            ensure_generation(&state, generation)?;
            application.commit_xunji(&fetched, &attempted_at).map_err(|error| error.message().to_owned())
        }
        Err(_) => {
            let app = state
                .application
                .lock()
                .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
            ensure_generation(&state, generation)?;
            app.record_xunji_failure(&json!({ "attemptedAt": attempted_at, "rangeStart": window.range_start, "rangeEnd": window.range_end, "code": "XUNJI_AUTHENTICATION_FAILED", "message": "Xunji rejected this API key. Export a new Skill from Xunji and try again." })).map_err(|error| error.message().to_owned())?;
            Err(
                "Xunji rejected this API key. Export a new Skill from Xunji and try again."
                    .to_string(),
            )
        }
    }
}

#[tauri::command]
async fn xunji_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let generation = database_generation(&state);
    let bundle = vault_bundle(&state).await?;
    let configured = secret_for(&bundle, "xunji").is_some();
    let locked = bundle.envelope.is_some() && cached_master_key(&state, &bundle).is_none();
    let application = state
        .application
        .lock()
        .map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    ensure_generation(&state, generation)?;
    let sync = application
        .get_xunji_sync_status()
        .map_err(|error| error.message().to_owned())?;
    Ok(json!({ "configured": configured, "locked": locked, "sync": sync }))
}

#[tauri::command]
fn mcp_status(app: AppHandle) -> Result<Value, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Athria could not determine its installation path: {error}"))?;
    let skills = resource_skills(&app).ok();
    mcp_stdio_payload(&executable, skills.as_deref())
}

fn mcp_stdio_payload(executable: &Path, skills: Option<&Path>) -> Result<Value, String> {
    let executable = simplify_path(executable);
    let executable_path = executable
        .to_str()
        .ok_or_else(|| "Athria's installation path contains unsupported characters.".to_string())?;
    let skills_path = skills.map(simplify_path).and_then(|path| path.to_str().map(str::to_owned));
    let home_dir = home_dir()
        .ok()
        .map(|path| simplify_path(&path).to_string_lossy().into_owned());
    Ok(json!({
        "configured": true,
        "executablePath": executable_path,
        "arguments": ["mcp"],
        "skillsPath": skills_path,
        "homeDir": home_dir
    }))
}

/// Serializes a command payload for the frontend.
///
/// Never hand a `Result` straight to `serde_json::to_value`: `Result` itself
/// implements `Serialize`, so the payload would reach the frontend wrapped as
/// `{"Ok": ...}` instead of as the value, and callers indexing into it (for
/// example `.filter` over the agent list) would fail at runtime.
fn command_json<T: serde::Serialize>(payload: Result<T, String>) -> Result<Value, String> {
    serde_json::to_value(payload?).map_err(|error| error.to_string())
}

#[tauri::command]
fn agent_integrations_status(app: AppHandle) -> Result<Value, String> {
    command_json(agent_integrations::statuses(&app, &platform_config_root()?))
}

/// Reveals the folder holding the prepared Skill archives. The path is resolved
/// here rather than supplied by the caller, so the frontend can never ask
/// Athria to open an arbitrary location.
#[tauri::command]
fn open_skill_archive_folder() -> Result<(), String> {
    let directory =
        agent_integrations::gui_skill_archive_dir(&platform_config_root()?, AgentKind::ClaudeDesktop);
    if !directory.is_dir() {
        return Err(
            "Athria has not prepared the Claude Desktop Skill archives yet. Connect Claude Desktop first."
                .to_string(),
        );
    }
    open_folder(&directory)
}

fn spawn_folder_opener(command: &mut std::process::Command, path: &Path) -> Result<(), String> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Athria could not open {}: {error}", path.display()))
}

#[cfg(windows)]
fn open_folder(path: &Path) -> Result<(), String> {
    spawn_folder_opener(std::process::Command::new("explorer").arg(path), path)
}

#[cfg(target_os = "macos")]
fn open_folder(path: &Path) -> Result<(), String> {
    spawn_folder_opener(std::process::Command::new("open").arg(path), path)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_folder(path: &Path) -> Result<(), String> {
    spawn_folder_opener(std::process::Command::new("xdg-open").arg(path), path)
}

#[tauri::command]
fn install_agent_integration(app: AppHandle, agent: String) -> Result<Value, String> {
    command_json(agent_integrations::install_by_id(
        &app,
        &agent,
        &platform_config_root()?,
    ))
}

const TRAY_OPEN_ID: &str = "open";
const TRAY_QUIT_ID: &str = "quit";
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

fn log_lifecycle(message: &str) {
    use std::io::Write;
    eprintln!("{message}");
    if let Ok(root) = platform_config_root() {
        let _ = fs::create_dir_all(&root);
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(root.join("athria-lifecycle.log")) {
            let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |value| value.as_secs());
            let _ = writeln!(file, "{time} pid={} {message}", std::process::id());
        }
    }
}

#[cfg(windows)]
struct StartupGuard(Mutex<Option<isize>>);

#[cfg(windows)]
unsafe impl Send for StartupGuard {}

#[cfg(windows)]
impl StartupGuard {
    fn release(&self) {
        if let Some(handle) = self.0.lock().expect("startup guard poisoned").take() {
            unsafe {
                windows_sys::Win32::System::Threading::ReleaseMutex(handle as _);
                windows_sys::Win32::Foundation::CloseHandle(handle as _);
            }
        }
    }
}

#[cfg(windows)]
impl Drop for StartupGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(windows)]
fn acquire_startup_guard() -> Option<StartupGuard> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, SW_SHOW, SetForegroundWindow, ShowWindow};
    const STARTUP_MUTEX: &str = "Local\\com.athria.desktop-single-v2";
    let guard = acquire_named_guard(STARTUP_MUTEX, 2_000);
    if guard.is_none() {
        let title: Vec<u16> = "Athria".encode_utf16().chain(Some(0)).collect();
        let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if !window.is_null() {
            unsafe {
                ShowWindow(window, SW_SHOW);
                SetForegroundWindow(window);
            }
        }
        log_lifecycle("duplicate desktop launch exited");
    } else {
        log_lifecycle("desktop acquired startup guard");
        clean_legacy_desktops();
    }
    guard
}

#[cfg(windows)]
fn acquire_named_guard(name: &str, timeout_ms: u32) -> Option<StartupGuard> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{ERROR_ALREADY_EXISTS, GetLastError, WAIT_ABANDONED, WAIT_OBJECT_0},
        System::Threading::{CreateMutexW, WaitForSingleObject},
    };

    let mutex_name: Vec<u16> = std::ffi::OsStr::new(name)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr()) };
    if handle.is_null() {
        log_lifecycle("could not create desktop startup guard");
        return None;
    }

    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        let wait_result = unsafe { WaitForSingleObject(handle, timeout_ms) };
        if wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle); }
            return None;
        }
    }

    Some(StartupGuard(Mutex::new(Some(handle as isize))))
}

#[cfg(not(windows))]
struct StartupGuard(());

#[cfg(not(windows))]
impl StartupGuard {
    fn release(&self) {}
}

#[cfg(not(windows))]
fn acquire_startup_guard() -> Option<()> {
    Some(())
}

#[cfg(windows)]
static QUIT_EVENT: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

#[cfg(windows)]
fn init_quit_event(app: &AppHandle) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};
    let name: Vec<u16> = std::ffi::OsStr::new("Local\\com.athria.desktop-quit-v2")
        .encode_wide().chain(Some(0)).collect();
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(format!("Athria could not register desktop Quit: {}", std::io::Error::last_os_error()));
    }
    QUIT_EVENT.store(handle as isize, Ordering::SeqCst);
    let app = app.clone();
    let handle_value = handle as isize;
    std::thread::spawn(move || {
        unsafe { WaitForSingleObject(handle_value as _, INFINITE); }
        exit_desktop(&app);
    });
    Ok(())
}

#[cfg(not(windows))]
fn init_quit_event(_: &AppHandle) -> Result<(), String> { Ok(()) }

fn exit_desktop(app: &AppHandle) {
    if EXIT_REQUESTED.swap(true, Ordering::SeqCst) { return; }
    log_lifecycle("desktop received Quit");
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(4));
        std::process::exit(0);
    });
    app.exit(0);
}

#[cfg(windows)]
fn quit_all_desktops(app: &AppHandle) {
    use windows_sys::Win32::System::Threading::SetEvent;
    clean_legacy_desktops();
    let handle = QUIT_EVENT.load(Ordering::SeqCst);
    if handle != 0 {
        if unsafe { SetEvent(handle as _) } == 0 {
            log_lifecycle("could not broadcast desktop Quit");
        }
    }
    exit_desktop(app);
}

#[cfg(not(windows))]
fn quit_all_desktops(app: &AppHandle) { exit_desktop(app); }

#[cfg(windows)]
fn clean_legacy_desktops() {
    use std::os::windows::process::CommandExt;
    let current = std::process::id();
    let script = format!(r#"
Start-Sleep -Milliseconds 700
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
try {{
Get-CimInstance Win32_Process -Filter "Name='athria.exe'" -ErrorAction Stop | Where-Object {{ $_.ProcessId -ne {current} -and $_.SessionId -eq $session -and $_.CommandLine -and $_.ExecutablePath }} | ForEach-Object {{
  try {{
    $quoted = '"' + $_.ExecutablePath + '"'
    $arguments = $null
    if ($_.CommandLine.StartsWith($quoted, [StringComparison]::OrdinalIgnoreCase)) {{ $arguments = $_.CommandLine.Substring($quoted.Length).TrimStart() }}
    elseif ($_.CommandLine.StartsWith($_.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {{ $arguments = $_.CommandLine.Substring($_.ExecutablePath.Length).TrimStart() }}
    if ($null -ne $arguments -and $arguments -notmatch '^mcp(?:\s|$)') {{
      $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath)
      if ($info.ProductName -eq 'Athria') {{
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
        Add-Content -Path (Join-Path $env:LOCALAPPDATA 'Athria\athria-lifecycle.log') -Value "legacy desktop pid=$($_.ProcessId) terminated" -ErrorAction SilentlyContinue
      }}
    }}
  }} catch {{ Add-Content -Path (Join-Path $env:LOCALAPPDATA 'Athria\athria-lifecycle.log') -Value "legacy desktop pid=$($_.ProcessId) cleanup failed: $($_.Exception.Message)" -ErrorAction SilentlyContinue }}
}}
}} catch {{ Add-Content -Path (Join-Path $env:LOCALAPPDATA 'Athria\athria-lifecycle.log') -Value "legacy cleanup failed: $($_.Exception.Message)" -ErrorAction SilentlyContinue }}
"#);
    if let Err(error) = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x08000000)
        .spawn()
    {
        log_lifecycle(&format!("could not start legacy desktop cleanup: {error}"));
    }
}

fn should_hide_main_window_on_close(window_label: &str, exit_requested: bool) -> bool {
    window_label == "main" && !exit_requested
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Athria", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit Athria", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("athria-tray")
        .icon(tauri::include_image!("icons/32x32.png"))
        .tooltip("Athria")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN_ID => show_main_window(app),
            TRAY_QUIT_ID => quit_all_desktops(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
fn add_custom_agent(app: AppHandle, name: String, config_path: String, skills_path: String) -> Result<Value, String> {
    command_json(agent_integrations::add_custom_agent(&app, &name, &config_path, &skills_path, &platform_config_root()?))
}

#[tauri::command]
fn reconcile_agent_skills(app: AppHandle) -> Result<Value, String> {
    command_json(agent_integrations::reconcile_skills(&app, &platform_config_root()?))
}

#[tauri::command]
fn resolve_agent_skill_update(
    app: AppHandle,
    agent: String,
    action: SkillUpdateAction,
) -> Result<Value, String> {
    command_json(agent_integrations::resolve_skill_update_by_id(
        &app,
        &agent,
        action,
        &platform_config_root()?,
    ))
}

#[tauri::command]
fn remove_agent_integration(agent: String) -> Result<Value, String> {
    command_json(agent_integrations::remove_by_id(&agent, &platform_config_root()?))
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
    app.dialog()
        .file()
        .add_filter("Athria database", &["sqlite3"])
        .set_file_name("athria-profile.sqlite3")
        .blocking_save_file()
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn restore_backup(
    state: State<'_, RuntimeState>,
    path: String,
) -> Result<Value, String> {
    let selected = PathBuf::from(&path);
    if !selected.is_absolute() {
        return Err("The selected backup path must be absolute.".to_string());
    }
    let selected = simplify_path(
        &fs::canonicalize(&selected)
            .map_err(|error| format!("Athria could not open the selected backup: {error}"))?,
    );
    if selected
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("sqlite3"))
        || !selected.is_file()
    {
        return Err("Select an existing .sqlite3 file.".to_string());
    }
    let current = state.database_path.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?.clone();
    if selected
        == simplify_path(
            &fs::canonicalize(&current)
                .map_err(|error| format!("Athria could not open the current database: {error}"))?,
        )
    {
        return Err("That database is already active.".to_string());
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&selected)
        .map_err(|error| format!("Athria needs write access to use this database: {error}"))?;
    preview_backup(
        &selected,
        current.parent().unwrap_or(Path::new(".")),
    )
    .map_err(|error| error.message().to_owned())?;
    switch_database(&state, &selected)
}

fn switch_database(state: &RuntimeState, target: &Path) -> Result<Value, String> {
    switch_database_at(state, target, &platform_config_root()?)
}

fn switch_database_at(state: &RuntimeState, target: &Path, config_root: &Path) -> Result<Value, String> {
    let _switch = state.switch_lock.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    if !target.is_file() {
        return Err("The selected database no longer exists.".to_string());
    }
    let store = SqliteStore::open(target).map_err(|error| error.message().to_owned())?;
    let mut application = state.application.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    let mut path = state.database_path.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?;
    write_config_to(config_root, target)?;
    *application = AthriaApplication::new(store);
    *path = target.to_path_buf();
    *state.vault_key.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())? = None;
    state.generation.fetch_add(1, Ordering::SeqCst);
    log_lifecycle(&format!("switched database to {}", target.display()));
    Ok(json!({ "databasePath": target }))
}

// The save dialog may return a path whose file does not exist yet, so the
// target is resolved through its parent folder. Existing files are rejected so
// a mistyped name can never replace a backup or another database.
fn validate_new_profile_target(path: &str, current: &Path) -> Result<PathBuf, String> {
    let selected = PathBuf::from(path);
    if !selected.is_absolute() {
        return Err("The selected path must be absolute.".to_string());
    }
    if selected
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("sqlite3"))
    {
        return Err("The new database file must end in .sqlite3.".to_string());
    }
    let parent = selected
        .parent()
        .ok_or_else(|| "The selected path has no parent folder.".to_string())?;
    let file_name = selected
        .file_name()
        .ok_or_else(|| "The selected path has no file name.".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Athria could not open the selected folder: {error}"))?;
    let target = simplify_path(&canonical_parent.join(file_name));
    if let Ok(current) = fs::canonicalize(current) {
        if target == simplify_path(&current) {
            return Err(
                "That is the active Athria database. Choose a different file name.".to_string(),
            );
        }
    }
    if target.exists() {
        return Err(
            "A file already exists at this path. Choose a different file name.".to_string(),
        );
    }
    Ok(target)
}

#[tauri::command]
async fn create_new_profile(state: State<'_, RuntimeState>, path: String) -> Result<Value, String> {
    let current = state.database_path.lock().map_err(|_| "Athria runtime state is unavailable.".to_string())?.clone();
    let target = validate_new_profile_target(&path, &current)?;
    let database_uuid = Uuid::new_v4().to_string();
    create_local_workspace(&target, &database_uuid, None)
        .map_err(|error| error.message().to_owned())?;
    switch_database(&state, &target)
}

pub fn run() -> i32 {
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        return run_mcp_stdio();
    }

    let Some(startup_guard) = acquire_startup_guard() else {
        return 0;
    };

    let mcp_listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Athria could not bind MCP HTTP: {error}");
            return 1;
        }
    };
    let mcp_port = match mcp_listener.local_addr() {
        Ok(value) => value.port(),
        Err(error) => {
            eprintln!("Athria could not read the MCP HTTP address: {error}");
            return 1;
        }
    };
    let mcp_token = new_runtime_token();
    let database_path = match checked_database_path() {
        Ok(path) => path,
        Err(error) => { log_lifecycle(&error); return 1; }
    };
    let application = match SqliteStore::open(&database_path) {
        Ok(store) => AthriaApplication::new(store),
        Err(error) => {
            eprintln!("Athria could not open the database: {error}");
            return 1;
        }
    };
    let mcp_application = match SqliteStore::open(&database_path) {
        Ok(store) => AthriaApplication::new(store),
        Err(error) => {
            eprintln!("Athria could not open the MCP database: {error}");
            return 1;
        }
    };
    let rust_mcp_token = mcp_token.clone();

    let result = tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("athria-startup-guard")
                .on_event(move |_, event| {
                    if matches!(event, tauri::RunEvent::Exit) {
                        log_lifecycle("desktop event loop exited");
                        startup_guard.release();
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(RuntimeState {
            vault_key: Mutex::new(None),
            application: Mutex::new(application),
            database_path: Mutex::new(database_path.clone()),
            generation: AtomicU64::new(0),
            switch_lock: Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            athria_request,
            vault_status,
            setup_vault,
            unlock_vault,
            change_vault_password,
            require_vault_password,
            reset_vault_password,
            disconnect_connection,
            test_intervals_credentials,
            sync_intervals,
            intervals_status,
            import_xunji_skill,
            sync_xunji,
            xunji_status,
            mcp_status,
            agent_integrations_status,
            install_agent_integration,
            add_custom_agent,
            reconcile_agent_skills,
            resolve_agent_skill_update,
            remove_agent_integration,
            open_skill_archive_folder,
            pick_restore_file,
            pick_new_profile_destination,
            restore_backup,
            create_new_profile
        ])
        .setup(move |app| {
            init_quit_event(app.handle()).map_err(std::io::Error::other)?;
            setup_tray(app.handle())?;
            std::thread::spawn(move || {
                if let Err(error) = serve_http_with_refresh(
                    mcp_listener,
                    mcp_service(mcp_application),
                    &rust_mcp_token,
                    Some(mcp_refresh(database_path)),
                ) {
                    eprintln!("Athria MCP HTTP stopped: {error}");
                }
            });
            let _ = app;
            Ok(())
        })
        .on_window_event(|window, event| {
            if should_hide_main_window_on_close(
                window.label(),
                EXIT_REQUESTED.load(Ordering::SeqCst),
            ) && let WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!());
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Athria failed: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeState, command_json, database_generation, ensure_generation, extract_xunji_api_key,
        checked_database_path_at, mcp_stdio_payload, new_runtime_token, read_config_from,
        should_hide_main_window_on_close, simplify_path, switch_database_at,
        validate_new_profile_target, write_config_to,
    };
    use athria_application::AthriaApplication;
    use athria_store::SqliteStore;
    use serde_json::{Value, json};
    use std::path::Path;
    use std::sync::{Mutex, atomic::AtomicU64};
    use uuid::Uuid;

    fn temp_root(prefix: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn database_switch_commits_only_after_target_and_config_are_ready() {
        let root = temp_root("athria-live-switch");
        let old = root.join("old.sqlite3");
        let next = root.join("next.sqlite3");
        drop(SqliteStore::open(&next).unwrap());
        let state = RuntimeState {
            vault_key: Mutex::new(None),
            application: Mutex::new(AthriaApplication::new(SqliteStore::open(&old).unwrap())),
            database_path: Mutex::new(old.clone()),
            generation: AtomicU64::new(0),
            switch_lock: Mutex::new(()),
        };
        let missing = root.join("missing.sqlite3");
        assert!(switch_database_at(&state, &missing, &root).is_err());
        assert!(!missing.exists());
        let invalid_root = root.join("not-a-directory");
        std::fs::write(&invalid_root, "occupied").unwrap();
        assert!(switch_database_at(&state, &next, &invalid_root).is_err());
        assert_eq!(*state.database_path.lock().unwrap(), old);
        assert_eq!(database_generation(&state), 0);
        assert_eq!(switch_database_at(&state, &next, &root).unwrap()["databasePath"], next.to_string_lossy().as_ref());
        assert_eq!(read_config_from(&root), Some(next.clone()));
        assert_eq!(database_generation(&state), 1);
        assert!(ensure_generation(&state, 0).is_err());
    }

    #[test]
    fn invalid_database_config_never_falls_back_to_another_database() {
        let root = temp_root("athria-bad-config");
        assert_eq!(checked_database_path_at(&root).unwrap(), root.join("data").join("athria.sqlite3"));
        std::fs::write(root.join("athria.config.json"), "not json").unwrap();
        assert!(checked_database_path_at(&root).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn startup_guard_allows_only_one_owner_and_can_be_reacquired() {
        let name = format!("Local\\athria-test-{}", Uuid::new_v4().simple());
        let first = super::acquire_named_guard(&name, 0).unwrap();
        let duplicate_name = name.clone();
        assert!(std::thread::spawn(move || super::acquire_named_guard(&duplicate_name, 0).is_none()).join().unwrap());
        drop(first);
        assert!(super::acquire_named_guard(&name, 0).is_some());
    }

    #[test]
    fn tray_quit_does_not_get_blocked_by_close_to_tray_behavior() {
        assert!(should_hide_main_window_on_close("main", false));
        assert!(!should_hide_main_window_on_close("main", true));
        assert!(!should_hide_main_window_on_close("settings", false));
    }

    #[test]
    fn extracts_bearer_and_api_key_headers() {
        let key = "xjllm_example-123";
        assert_eq!(
            extract_xunji_api_key(&format!("Authorization: Bearer {key}")),
            Ok(key.to_string())
        );
        assert_eq!(
            extract_xunji_api_key(&format!("请求头: `x-api-key: {key}`")),
            Ok(key.to_string())
        );
    }

    #[test]
    fn rejects_missing_ambiguous_and_oversized_input() {
        assert!(extract_xunji_api_key("no credential").is_err());
        assert!(
            extract_xunji_api_key("Authorization: Bearer xjllm_one\nx-api-key: xjllm_two").is_err()
        );
        assert!(extract_xunji_api_key(&"x".repeat(65_537)).is_err());
    }

    #[test]
    fn accepts_repeated_occurrences_of_the_same_key() {
        assert_eq!(
            extract_xunji_api_key("Authorization: Bearer xjllm_same\nx-api-key: xjllm_same"),
            Ok("xjllm_same".to_string())
        );
    }

    #[test]
    fn reports_the_current_executable_and_bundled_skills_for_mcp_stdio() {
        let expected = std::env::current_exe().unwrap();
        let status = mcp_stdio_payload(&expected, Some(Path::new("/skills"))).unwrap();
        assert_eq!(status["configured"], true);
        assert_eq!(status["executablePath"], expected.to_str().unwrap());
        assert_eq!(status["arguments"], serde_json::json!(["mcp"]));
        assert_eq!(status["skillsPath"], "/skills");
        assert!(expected.is_absolute());
    }

    #[test]
    fn omits_the_skills_path_when_bundled_skills_are_missing() {
        let status = mcp_stdio_payload(Path::new("/Athria"), None).unwrap();
        assert_eq!(status["skillsPath"], serde_json::Value::Null);
    }

    #[test]
    fn strips_verbatim_prefixes_from_the_mcp_stdio_paths() {
        let status = mcp_stdio_payload(
            Path::new(r"\\?\C:\Program Files\Athria\athria.exe"),
            Some(Path::new(r"\\?\C:\Program Files\Athria\skills")),
        )
        .unwrap();
        assert_eq!(
            status["executablePath"],
            r"C:\Program Files\Athria\athria.exe"
        );
        assert_eq!(status["skillsPath"], r"C:\Program Files\Athria\skills");
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
        std::fs::write(
            root.join("athria.config.json"),
            serde_json::json!({ "dataDir": data }).to_string(),
        )
        .unwrap();
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
        assert_eq!(
            simplify_path(std::path::Path::new(r"\\?\C:\Users\tclre\Fitness\data")),
            std::path::PathBuf::from(r"C:\Users\tclre\Fitness\data")
        );
        assert_eq!(
            simplify_path(std::path::Path::new(r"\\?\UNC\server\share\data")),
            std::path::PathBuf::from(r"\\server\share\data")
        );
        assert_eq!(
            simplify_path(std::path::Path::new(r"C:\Athria\data")),
            std::path::PathBuf::from(r"C:\Athria\data")
        );
    }

    #[test]
    #[cfg(windows)]
    fn normalizes_verbatim_paths_when_reading_the_config() {
        let root = temp_root("athria-config-verbatim");
        let target = root.join("custom.sqlite3");
        write_config_to(
            &root,
            std::path::Path::new(&format!(r"\\?\{}", target.display())),
        )
        .unwrap();
        assert_eq!(read_config_from(&root), Some(target));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn accepts_a_new_profile_path_beside_the_active_database() {
        let root = temp_root("athria-profile");
        let current = root.join("athria.sqlite3");
        std::fs::write(&current, b"active").unwrap();
        let target = root.join("fresh.sqlite3");
        assert_eq!(
            validate_new_profile_target(target.to_str().unwrap(), &current),
            Ok(target)
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_non_sqlite_and_relative_new_profile_targets() {
        let root = temp_root("athria-profile-name");
        let current = root.join("athria.sqlite3");
        std::fs::write(&current, b"active").unwrap();
        let wrong_extension = root.join("fresh.txt");
        assert!(
            validate_new_profile_target(wrong_extension.to_str().unwrap(), &current)
                .unwrap_err()
                .contains(".sqlite3")
        );
        assert!(
            validate_new_profile_target("fresh.sqlite3", &current)
                .unwrap_err()
                .contains("absolute")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_existing_or_active_new_profile_targets() {
        let root = temp_root("athria-profile-conflict");
        let current = root.join("athria.sqlite3");
        std::fs::write(&current, b"active").unwrap();
        let existing = root.join("existing.sqlite3");
        std::fs::write(&existing, b"keep").unwrap();
        assert!(
            validate_new_profile_target(existing.to_str().unwrap(), &current)
                .unwrap_err()
                .contains("already exists")
        );
        assert!(
            validate_new_profile_target(current.to_str().unwrap(), &current)
                .unwrap_err()
                .contains("active Athria database")
        );
        assert_eq!(std::fs::read(&existing).unwrap(), b"keep");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn command_payloads_are_serialized_without_a_result_wrapper() {
        let list = command_json::<Vec<Value>>(Ok(vec![json!({ "agent": "codex" })])).unwrap();
        assert!(list.is_array(), "{list}");
        assert_eq!(list[0]["agent"], "codex");

        let object = command_json::<Value>(Ok(json!({ "agent": "codex" }))).unwrap();
        assert!(object.is_object(), "{object}");

        assert_eq!(
            command_json::<Value>(Err("nope".into())).unwrap_err(),
            "nope"
        );
    }
}
