//! Desktop networking and coordination for signed Skill releases.
use athria_skills::updates::{self, Index, Package, Preferences};
use semver::Version;
use serde::Serialize;
use std::{path::PathBuf, sync::{Mutex, atomic::{AtomicU64, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, State};
use crate::{agent_integrations, platform_config_root};

const INDEX_URL: &str = "https://github.com/whywww/Athria/releases/download/skills-index/index.json";

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub automatic: bool,
    pub key_configured: bool,
    pub current_version: String,
    pub source: String,
    pub phase: String,
    pub available_version: Option<String>,
    pub latest_version: Option<String>,
    pub upgrade_required: bool,
    pub last_attempt: Option<u64>,
    pub last_success: Option<u64>,
    pub error: Option<String>,
    pub sync_failures: Vec<String>,
    pub claude_install_required: bool,
}
#[derive(Default)]
pub struct UpdateRuntime {
    gate: tokio::sync::Mutex<()>,
    revision: AtomicU64,
    status: Mutex<UpdateStatus>,
    last_operation: Mutex<String>,
}
pub fn root() -> Result<PathBuf, String> { Ok(platform_config_root()?.join("skill-updates")) }
fn context() -> Result<(Version, String, Version), String> {
    Ok((Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?,
        updates::contract_fingerprint(athria_mcp::skill_contract()),
        Version::parse(&updates::bundled_release()?.version).map_err(|e| e.to_string())?))
}
pub fn source(bundled: &std::path::Path) -> Result<PathBuf, String> {
    let (app, contract, baseline) = context()?;
    Ok(updates::resolve_source(&root()?, bundled, &baseline, &app, &contract, updates::PUBLIC_KEY))
}
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
pub fn automatic_due(prefs: &Preferences, time: u64) -> bool {
    prefs.automatic && prefs.last_attempt.is_none_or(|last| time.saturating_sub(last) >= 86400)
}

impl UpdateRuntime {
    fn completed_install(&self, revision: u64, version: &str) -> Result<bool, String> {
        Ok(revision != self.revision.load(Ordering::SeqCst)
            && *self.last_operation.lock().map_err(|_| "Skill update state is unavailable.")? == version)
    }
    fn set_phase(&self, phase: &str) -> Result<(), String> {
        self.status.lock().map_err(|_| "Skill update state is unavailable.")?.phase = phase.into(); Ok(())
    }
    fn refresh(&self, app: &AppHandle) -> Result<UpdateStatus, String> {
        let root = root()?;
        let prefs = updates::read_preferences(&root)?;
        let baseline = updates::bundled_release()?.version;
        let source = agent_integrations::resource_skills(app)?;
        let version = source.file_name().and_then(|v| v.to_str()).filter(|v| Version::parse(v).is_ok()).unwrap_or(&baseline).to_owned();
        let mut status = self.status.lock().map_err(|_| "Skill update state is unavailable.")?;
        status.automatic = prefs.automatic; status.key_configured = !updates::PUBLIC_KEY.trim().is_empty();
        status.current_version = version;
        status.source = if source.starts_with(root.join("versions")) { "downloaded" } else { "bundled" }.into();
        status.last_attempt = prefs.last_attempt; status.last_success = prefs.last_success;
        status.available_version = None; status.latest_version = None; status.upgrade_required = false;
        if status.phase.is_empty() { status.phase = "idle".into(); }
        if let Ok(index) = updates::cached_index(&root, updates::PUBLIC_KEY) {
            let (app_version, contract, _) = context()?;
            let current = Version::parse(&status.current_version).map_err(|e| e.to_string())?;
            status.available_version = updates::available_update(&index, &app_version, &contract, &current).map(|p| p.version.clone());
            let latest = index.packages.iter().filter(|p| !p.revoked).max_by_key(|p| Version::parse(&p.version).ok());
            status.latest_version = latest.map(|p| p.version.clone());
            status.upgrade_required = latest.is_some_and(|p| Version::parse(&p.version).is_ok_and(|v| v > current) && !p.compatible(&app_version, &contract));
        }
        Ok(status.clone())
    }
    fn finish(&self, error: Option<String>) -> Result<(), String> {
        let mut status = self.status.lock().map_err(|_| "Skill update state is unavailable.")?;
        status.phase = "idle".into(); status.error = error;
        self.revision.fetch_add(1, Ordering::SeqCst); Ok(())
    }
}

async fn download(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.map_err(|e| format!("Could not download Skill updates: {e}"))?
        .error_for_status().map_err(|e| format!("Could not download Skill updates: {e}"))?;
    if response.content_length().is_some_and(|v| v > limit as u64) { return Err("Skill download exceeds the size limit.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > limit { return Err("Skill download exceeds the size limit.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().https_only(true).timeout(Duration::from_secs(30))
        .user_agent(concat!("Athria/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())
}

fn sync_agents(app: &AppHandle, runtime: &UpdateRuntime) -> Result<(), String> {
    let mut failures = Vec::new();
    match agent_integrations::reconcile_skills(app, &platform_config_root()?) {
        Ok(result) => failures.extend(result.failures.into_iter().map(|f| f.message)),
        Err(e) => failures.push(e),
    }
    let (claude, export_error) = agent_integrations::refresh_gui_archives(app, &platform_config_root()?);
    if let Some(error) = export_error { failures.push(error); }
    let mut status = runtime.status.lock().map_err(|_| "Skill update state is unavailable.")?;
    status.sync_failures = failures; status.claude_install_required = claude;
    Ok(())
}
async fn install_checked(app: &AppHandle, runtime: &UpdateRuntime, index: &Index, package: &Package) -> Result<(), String> {
    let (app_version, contract, _) = context()?;
    if !package.compatible(&app_version, &contract) || !index.packages.iter().any(|p| p.version == package.version && !p.revoked) {
        return Err("This Skill package requires a different Athria version.".into());
    }
    runtime.set_phase("downloading")?;
    let bytes = download(&client()?, &package.url, updates::PACKAGE_LIMIT).await?;
    runtime.set_phase("installing")?;
    updates::install(&root()?, &bytes, package)?;
    sync_agents(app, runtime)
}

#[tauri::command]
pub fn skill_update_status(app: AppHandle, runtime: State<'_, UpdateRuntime>) -> Result<UpdateStatus, String> { runtime.refresh(&app) }

#[tauri::command]
pub async fn set_skill_auto_update(app: AppHandle, automatic: bool, runtime: State<'_, UpdateRuntime>) -> Result<UpdateStatus, String> {
    let _guard = runtime.gate.lock().await;
    let mut prefs = updates::read_preferences(&root()?)?; prefs.automatic = automatic;
    updates::save_preferences(&root()?, &prefs)?; runtime.refresh(&app)
}

#[tauri::command]
pub async fn check_skill_updates(app: AppHandle, background: bool, runtime: State<'_, UpdateRuntime>) -> Result<UpdateStatus, String> {
    let revision = runtime.revision.load(Ordering::SeqCst);
    let _guard = runtime.gate.lock().await;
    if revision != runtime.revision.load(Ordering::SeqCst) { return runtime.refresh(&app); }
    let mut prefs = updates::read_preferences(&root()?)?;
    if background && !automatic_due(&prefs, now()) { return runtime.refresh(&app); }
    *runtime.last_operation.lock().map_err(|_| "Skill update state is unavailable.")? = "check".into();
    runtime.set_phase("checking")?;
    prefs.last_attempt = Some(now());
    let result = async {
        updates::save_preferences(&root()?, &prefs)?;
        if updates::PUBLIC_KEY.trim().is_empty() { return Err("Skill update public key is not configured.".to_string()); }
        let previous = agent_integrations::resource_skills(&app)?;
        let bytes = download(&client()?, INDEX_URL, updates::INDEX_LIMIT).await?;
        let index = updates::verify_index(&bytes, updates::PUBLIC_KEY)?;
        updates::atomic_write(&root()?.join("index.json"), &bytes)?;
        prefs.last_success = Some(now()); updates::save_preferences(&root()?, &prefs)?;
        // Revocation or application upgrade may change the source without a download.
        if !background || previous != agent_integrations::resource_skills(&app)? { sync_agents(&app, &runtime)?; }
        let status = runtime.refresh(&app)?;
        if prefs.automatic && let Some(version) = status.available_version {
            let package = index.packages.iter().find(|p| p.version == version).ok_or("Skill release not found.")?;
            install_checked(&app, &runtime, &index, package).await?;
        }
        Ok::<(), String>(())
    }.await;
    runtime.finish(result.err())?; runtime.refresh(&app)
}

#[tauri::command]
pub async fn install_skill_update(app: AppHandle, version: String, runtime: State<'_, UpdateRuntime>) -> Result<UpdateStatus, String> {
    let revision = runtime.revision.load(Ordering::SeqCst);
    let _guard = runtime.gate.lock().await;
    if runtime.completed_install(revision, &version)? {
        return runtime.refresh(&app);
    }
    if runtime.refresh(&app)?.current_version == version { return runtime.refresh(&app); }
    *runtime.last_operation.lock().map_err(|_| "Skill update state is unavailable.")? = version.clone();
    let result = async {
        // Use a fresh signed index to honour revocations since the last check.
        runtime.set_phase("checking")?;
        let bytes = download(&client()?, INDEX_URL, updates::INDEX_LIMIT).await?;
        let index = updates::verify_index(&bytes, updates::PUBLIC_KEY)?;
        let package = index.packages.iter().find(|p| p.version == version).ok_or("Check for an available Skill update first.")?;
        let status = runtime.refresh(&app)?;
        if status.available_version.as_deref() != Some(&version) { return Err("Check for an available Skill update first.".to_string()); }
        updates::atomic_write(&root()?.join("index.json"), &bytes)?;
        install_checked(&app, &runtime, &index, package).await
    }.await;
    runtime.finish(result.err())?; runtime.refresh(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn automatic_check_interval_and_opt_out() {
        let mut prefs = Preferences::default(); assert!(automatic_due(&prefs, 10));
        prefs.last_attempt = Some(10); assert!(!automatic_due(&prefs, 86409)); assert!(automatic_due(&prefs, 86410));
        assert!(!automatic_due(&prefs, 5)); prefs.automatic = false; assert!(!automatic_due(&prefs, 90000));
    }
    #[tokio::test] async fn concurrent_installs_share_the_completed_operation() {
        use std::sync::Arc;
        let runtime = Arc::new(UpdateRuntime::default());
        let barrier = Arc::new(tokio::sync::Barrier::new(4));
        let downloads = Arc::new(AtomicU64::new(0));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..4 {
            let runtime = runtime.clone(); let barrier = barrier.clone(); let downloads = downloads.clone();
            tasks.spawn(async move {
                let revision = runtime.revision.load(Ordering::SeqCst);
                barrier.wait().await;
                let _guard = runtime.gate.lock().await;
                if runtime.completed_install(revision, "0.1.1").unwrap() { return; }
                *runtime.last_operation.lock().unwrap() = "0.1.1".into();
                downloads.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                runtime.finish(Some("simulated network failure".into())).unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await { result.unwrap(); }
        assert_eq!(downloads.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.status.lock().unwrap().error.as_deref(), Some("simulated network failure"));
    }
    #[tokio::test] async fn bounded_download_handles_http_failure_and_truncation() {
        use std::io::{Read, Write};
        fn server(response: &'static [u8]) -> String {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); let addr = listener.local_addr().unwrap();
            std::thread::spawn(move || { let (mut socket, _) = listener.accept().unwrap(); let mut buffer = [0; 4096]; let _ = socket.read(&mut buffer); socket.write_all(response).unwrap(); });
            format!("http://{addr}")
        }
        let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();
        assert_eq!(download(&client, &server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"), 2).await.unwrap(), b"ok");
        assert!(download(&client, &server(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbig"), 2).await.is_err());
        assert!(download(&client, &server(b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n"), 2).await.is_err());
        assert!(download(&client, &server(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nok"), 10).await.is_err());
    }
}
