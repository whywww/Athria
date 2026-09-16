use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use uuid::Uuid;

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

#[cfg(not(any(windows, target_os = "macos")))]
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

fn candidate_sidecars(executable: &Path) -> Vec<PathBuf> {
    let directory = executable.parent().unwrap_or_else(|| Path::new("."));
    vec![
        directory.join("athria-service"),
        directory.join("athria-service.exe"),
        directory.join("athria-service-aarch64-apple-darwin"),
        directory.join("athria-service-x86_64-pc-windows-msvc.exe"),
        directory.join("resources").join("athria-service"),
        directory.join("resources").join("athria-service.exe"),
        directory.join("resources").join("athria-service-aarch64-apple-darwin"),
        directory.join("resources").join("athria-service-x86_64-pc-windows-msvc.exe"),
        directory.join("..").join("binaries").join("athria-service-aarch64-apple-darwin"),
        directory.join("..").join("binaries").join("athria-service-x86_64-pc-windows-msvc.exe"),
    ]
}

fn run_mcp_passthrough() -> i32 {
    let executable = match std::env::current_exe() { Ok(path) => path, Err(error) => { eprintln!("{error}"); return 1; } };
    let sidecar = match candidate_sidecars(&executable).into_iter().find(|path| path.exists()) {
        Some(path) => path,
        None => { eprintln!("Athria service sidecar was not found next to {}", executable.display()); return 1; }
    };
    let mut command = Command::new(sidecar);
    command.arg("mcp").stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    command.env("ATHRIA_DATABASE_PATH", current_database_path());
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => { eprintln!("Failed to start Athria MCP: {error}"); 1 }
    }
}

#[tauri::command]
fn get_service_info(state: State<'_, RuntimeState>) -> ServiceInfo { state.service.clone() }

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

#[tauri::command]
async fn test_intervals_credentials(state: State<'_, RuntimeState>, api_key: String, athlete_id: String) -> Result<Value, String> {
    let result = service_post(&state, "/api/connections/intervals/test", json!({ "apiKey": api_key, "athleteId": athlete_id })).await?;
    credential("intervals-api-key")?.set_password(&api_key).map_err(|error| error.to_string())?;
    credential("intervals-athlete-id")?.set_password(&athlete_id).map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
async fn sync_intervals(state: State<'_, RuntimeState>, range: Option<Value>) -> Result<Value, String> {
    let api_key = credential("intervals-api-key")?.get_password().map_err(|_| "Intervals.icu is not configured".to_string())?;
    let athlete_id = credential("intervals-athlete-id")?.get_password().unwrap_or_else(|_| "0".to_string());
    service_post(&state, "/api/connections/intervals/sync", json!({ "apiKey": api_key, "athleteId": athlete_id, "range": range.unwrap_or_else(|| json!("incremental")) })).await
}

#[tauri::command]
async fn intervals_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let configured = credential("intervals-api-key").and_then(|entry| entry.get_password().map_err(|error| error.to_string())).is_ok();
    let athlete_id = credential("intervals-athlete-id").ok().and_then(|entry| entry.get_password().ok()).unwrap_or_else(|| "0".to_string());
    let sync = service_get(&state, "/api/connections/intervals/status").await?;
    Ok(json!({ "configured": configured, "athleteId": athlete_id, "sync": sync }))
}

#[tauri::command]
async fn import_xunji_skill(state: State<'_, RuntimeState>, skill_text: String) -> Result<Value, String> {
    let api_key = extract_xunji_api_key(&skill_text)?;
    let result = service_post(&state, "/api/connections/xunji/sync", json!({ "apiKey": api_key, "days": 90, "replaceCredential": true })).await?;
    credential("xunji-api-key")?.set_password(&api_key).map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
async fn sync_xunji(state: State<'_, RuntimeState>, range: Option<Value>) -> Result<Value, String> {
    let api_key = credential("xunji-api-key")?.get_password().map_err(|_| "Xunji is not configured. Import the Skill from Xunji first.".to_string())?;
    service_post(&state, "/api/connections/xunji/sync", json!({ "apiKey": api_key, "range": range.unwrap_or_else(|| json!("incremental")) })).await
}

#[tauri::command]
async fn xunji_status(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let configured = credential("xunji-api-key").and_then(|entry| entry.get_password().map_err(|error| error.to_string())).is_ok();
    let sync = service_get(&state, "/api/connections/xunji/status").await?;
    Ok(json!({ "configured": configured, "sync": sync }))
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
async fn pick_backup_destination(app: AppHandle) -> Option<String> {
    app.dialog().file().add_filter("Athria database", &["sqlite3"]).set_file_name("athria-backup.sqlite3")
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

pub fn run() -> i32 {
    if std::env::args().nth(1).as_deref() == Some("mcp") { return run_mcp_passthrough(); }

    #[cfg(feature = "dev-service")]
    let dev_service = {
        let project_root = workspace_root();
        let bun = match resolve_dev_bun(&project_root) { Ok(value) => value, Err(error) => { eprintln!("{error}"); return 1; } };
        let service_entry = project_root.join("apps").join("service").join("src").join("main.ts");
        (project_root, bun, service_entry)
    };
    let port = match free_port() { Ok(value) => value, Err(error) => { eprintln!("{error}"); return 1; } };
    let token = new_runtime_token();
    let mcp_token = new_runtime_token();
    let service = ServiceInfo { base_url: format!("http://127.0.0.1:{port}"), token: token.clone(), mcp_url: format!("http://127.0.0.1:{port}/mcp") };
    let service_for_setup = service.clone();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(RuntimeState { service, child: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![get_service_info, test_intervals_credentials, sync_intervals, intervals_status, import_xunji_skill, sync_xunji, xunji_status, mcp_status, pick_backup_destination, pick_restore_file, restore_backup])
        .setup(move |app| {
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
                .env("ATHRIA_DATABASE_PATH", current_database_path());
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
    use super::{activate_restore, extract_xunji_api_key, mcp_status, new_runtime_token, read_config_from, simplify_path, write_config_to};
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
    fn activates_a_prepared_restore_and_preserves_the_old_database() {
        let root = temp_root("athria-restore");
        let current = root.join("current.sqlite3");
        let stage = root.join(".athria-restore-test.sqlite3");
        std::fs::write(&current, b"old").unwrap();
        std::fs::write(&stage, b"restored").unwrap();
        std::fs::write(format!("{}-wal", current.display()), b"wal").unwrap();
        let rollback = activate_restore(&current, &stage).unwrap();
        assert_eq!(std::fs::read(&current).unwrap(), b"restored");
        assert_eq!(std::fs::read(&rollback).unwrap(), b"old");
        assert!(!std::path::Path::new(&format!("{}-wal", current.display())).exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
