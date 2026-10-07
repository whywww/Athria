use std::{collections::HashSet, sync::Mutex};
use serde_json::{Value, json};
use tauri::State;
use athria_integrations::{SyncDateWindow, sync_date_window};
use super::{RuntimeState, active_application, cached_master_key, database_generation, ensure_generation, secret_for, vault_bundle};

#[derive(Default)]
pub struct SyncRegistry(Mutex<HashSet<(u64, String)>>);

pub struct SyncLease<'a> {
    registry: &'a SyncRegistry,
    key: (u64, String),
}

impl SyncRegistry {
    pub fn acquire(&self, generation: u64, source: &str) -> Result<Option<SyncLease<'_>>, String> {
        let key = (generation, source.to_owned());
        if !self.0.lock().map_err(|_| "Sync state is unavailable.")?.insert(key.clone()) {
            return Ok(None);
        }
        Ok(Some(SyncLease { registry: self, key }))
    }
}

impl Drop for SyncLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.registry.0.lock() { active.remove(&self.key); }
    }
}

pub fn record_attempt(state: &RuntimeState, generation: u64, source: &str, attempted_at: &str, automatic: bool) -> Result<bool, String> {
    let app = active_application(state)?;
    ensure_generation(state, generation)?;
    if automatic {
        let bundle = app.store().get_vault().map_err(|error| error.message().to_owned())?;
        if !secret_for(&bundle, source).is_some_and(daily_auto_sync_enabled) { return Ok(false); }
    }
    let profile = app.get_profile().map_err(|error| error.message().to_owned())?;
    let timezone = profile["timezone"].as_str().ok_or("The athlete profile has no timezone.")?;
    app.store().begin_daily_sync_attempt(
        source,
        app.owner_id(), timezone, attempted_at, automatic,
    ).map_err(|error| error.message().to_owned())
}

pub fn daily_auto_sync_enabled(secret: &athria_vault::EncryptedSecret) -> bool {
    secret.config.get("dailyAutoSync").and_then(Value::as_bool).unwrap_or(true)
}

#[tauri::command]
pub fn set_connection_daily_auto_sync(state: State<'_, RuntimeState>, source: String, enabled: bool) -> Result<Value, String> {
    if !["intervals", "xunji"].contains(&source.as_str()) { return Err("Unsupported training app.".to_string()); }
    let generation = database_generation(&state);
    let app = active_application(&state)?;
    ensure_generation(&state, generation)?;
    let bundle = app.store().get_vault().map_err(|error| error.message().to_owned())?;
    if cached_master_key(&state, &bundle).is_none() {
        return Err("This database is locked. Enter its database password to continue.".to_string());
    }
    app.store().set_connection_daily_auto_sync(&source, enabled).map_err(|error| error.message().to_owned())?;
    Ok(json!({ "dailyAutoSync": enabled }))
}

pub fn sync_window(previous: Option<&Value>, range: Option<&Value>, attempted_at: &str) -> Result<SyncDateWindow, String> {
    sync_date_window(
        previous.and_then(|value| value.get("lastSuccessAt")).and_then(Value::as_str),
        range.and_then(Value::as_i64),
        attempted_at,
    ).map_err(|error| error.message().to_owned())
}

#[tauri::command]
pub async fn sync_training_apps_daily(state: State<'_, RuntimeState>) -> Result<Value, String> {
    run_daily_sync(&state).await
}

async fn run_daily_sync(state: &RuntimeState) -> Result<Value, String> {
    let generation = database_generation(state);
    let bundle = vault_bundle(state).await?;
    // A locked database does not consume today's attempt.
    if bundle.envelope.is_none() || cached_master_key(&state, &bundle).is_none() {
        return Ok(json!({ "results": [] }));
    }
    let mut results = Vec::new();
    for source in ["intervals", "xunji"] {
        ensure_generation(&state, generation)?;
        if !secret_for(&bundle, source).is_some_and(daily_auto_sync_enabled) { continue; }
        let outcome = if source == "intervals" {
            super::run_intervals_sync(&state, Some(json!("incremental")), true, generation).await
        } else {
            super::run_xunji_sync(&state, Some(json!("incremental")), true, generation).await
        };
        match outcome {
            Ok(Some(result)) => results.push(json!({ "source": source, "result": result })),
            Ok(None) => {},
            Err(error) => results.push(json!({ "source": source, "error": error })),
        }
    }
    ensure_generation(&state, generation)?;
    Ok(json!({ "results": results }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use athria_application::AthriaApplication;
    use athria_core::FixedClock;
    use athria_store::SqliteStore;
    use std::sync::{Arc, atomic::AtomicU64};
    use zeroize::Zeroizing;

    #[test]
    fn incremental_ranges_use_the_success_cursor_and_keep_first_sync_defaults() {
        let previous = json!({ "lastSuccessAt": "2026-10-04T10:00:00Z" });
        let today = "2026-10-07T08:00:00Z";
        let incremental = json!("incremental");
        assert_eq!(sync_window(Some(&previous), Some(&incremental), today).unwrap().days, 4);
        assert_eq!(sync_window(None, Some(&incremental), today).unwrap().days, 90);
        assert_eq!(sync_window(Some(&previous), Some(&json!(30)), today).unwrap().days, 30);
    }

    fn configured_state() -> (RuntimeState, Zeroizing<Vec<u8>>) {
        let clock = Arc::new(FixedClock::new("2026-10-07T08:00:00Z"));
        let store = SqliteStore::open_in_memory_with_clock(clock.clone()).unwrap();
        let uuid = store.database_uuid().unwrap();
        let master = athria_vault::new_master_key();
        let envelope = athria_vault::create_envelope(&uuid, "test password", &master).unwrap();
        let secret = athria_vault::encrypt_secret(&uuid, "intervals", json!({}), "test key", &master).unwrap();
        store.initialize_vault(&envelope, &[secret]).unwrap();
        let state = RuntimeState {
            vault_key: Mutex::new(None),
            application: Mutex::new(Some(AthriaApplication::with_clock(store, "local-user", clock))),
            database_path: Mutex::new("test.sqlite3".into()),
            startup_error: Mutex::new(None),
            mcp_listener: Mutex::new(None),
            mcp_token: String::new(),
            generation: AtomicU64::new(0),
            switch_lock: Mutex::new(()),
            syncs: SyncRegistry::default(),
        };
        (state, master)
    }

    #[test]
    fn locked_and_unconfigured_sources_do_not_consume_daily_attempts() {
        let (state, master) = configured_state();
        assert_eq!(tauri::async_runtime::block_on(run_daily_sync(&state)).unwrap(), json!({ "results": [] }));
        // Today's claim is still available after the locked startup check.
        assert!(record_attempt(&state, 0, "intervals", "2026-10-07T08:00:00Z", true).unwrap());
        *state.vault_key.lock().unwrap() = Some(Zeroizing::new(master.to_vec()));
        assert_eq!(tauri::async_runtime::block_on(run_daily_sync(&state)).unwrap(), json!({ "results": [] }));
        // The configured source is already attempted; the other source is unconfigured.
        assert!(!record_attempt(&state, 0, "intervals", "2026-10-07T08:00:00Z", true).unwrap());
        assert!(active_application(&state).unwrap().store().begin_daily_sync_attempt("xunji", "local-user", "Asia/Hong_Kong", "2026-10-07T08:00:00Z", true).unwrap());
        assert!(record_attempt(&state, 1, "intervals", "2026-10-08T08:00:00Z", true).is_err());
        assert!(record_attempt(&state, 0, "intervals", "2026-10-08T08:00:00Z", true).unwrap());
    }

    #[test]
    fn disabling_daily_sync_skips_without_consuming_the_day_and_manual_sync_remains_allowed() {
        let (state, master) = configured_state();
        *state.vault_key.lock().unwrap() = Some(Zeroizing::new(master.to_vec()));
        {
            let app = active_application(&state).unwrap();
            let mut secret = app.store().get_vault().unwrap().secrets[0].clone();
            assert!(daily_auto_sync_enabled(&secret));
            secret.ciphertext = "invalid ciphertext".to_owned();
            app.store().upsert_connection_secret(&secret).unwrap();
            app.store().set_connection_daily_auto_sync("intervals", false).unwrap();
            assert!(!daily_auto_sync_enabled(&app.store().get_vault().unwrap().secrets[0]));
        }
        assert_eq!(tauri::async_runtime::block_on(run_daily_sync(&state)).unwrap(), json!({ "results": [] }));
        assert!(!record_attempt(&state, 0, "intervals", "2026-10-07T08:00:00Z", true).unwrap());
        // Re-enabling may use today's still-unconsumed attempt.
        active_application(&state).unwrap().store().set_connection_daily_auto_sync("intervals", true).unwrap();
        let response = tauri::async_runtime::block_on(run_daily_sync(&state)).unwrap();
        assert_eq!(response["results"].as_array().unwrap().len(), 1);
        assert_eq!(response["results"][0]["source"], "intervals");
        assert!(response["results"][0]["error"].is_string());
        active_application(&state).unwrap().store().set_connection_daily_auto_sync("intervals", false).unwrap();
        assert!(record_attempt(&state, 0, "intervals", "2026-10-07T08:00:00Z", false).unwrap());
        active_application(&state).unwrap().store().set_connection_daily_auto_sync("intervals", true).unwrap();
        assert_eq!(tauri::async_runtime::block_on(run_daily_sync(&state)).unwrap(), json!({ "results": [] }));
    }

    #[test]
    fn one_source_failure_does_not_stop_the_other_or_repeat_the_same_day() {
        let (state, master) = configured_state();
        *state.vault_key.lock().unwrap() = Some(Zeroizing::new(master.to_vec()));
        {
            let app = active_application(&state).unwrap();
            let uuid = app.store().database_uuid().unwrap();
            for source in ["intervals", "xunji"] {
                let mut secret = athria_vault::encrypt_secret(&uuid, source, json!({}), "test key", &master).unwrap();
                secret.ciphertext = "invalid ciphertext".to_owned();
                app.store().upsert_connection_secret(&secret).unwrap();
            }
        }
        let response = tauri::async_runtime::block_on(run_daily_sync(&state)).unwrap();
        let results = response["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["source"], "intervals");
        assert_eq!(results[1]["source"], "xunji");
        assert!(results.iter().all(|entry| entry["error"].is_string()));
        assert_eq!(tauri::async_runtime::block_on(run_daily_sync(&state)).unwrap(), json!({ "results": [] }));
    }

    #[test]
    fn sync_leases_isolate_sources_and_database_generations_and_release_on_failure() {
        let registry = SyncRegistry::default();
        let first = registry.acquire(0, "intervals").unwrap().unwrap();
        assert!(registry.acquire(0, "intervals").unwrap().is_none());
        let other_source = registry.acquire(0, "xunji").unwrap().unwrap();
        let other_database = registry.acquire(1, "intervals").unwrap().unwrap();
        drop(first);
        assert!(registry.acquire(0, "intervals").unwrap().is_some());
        assert!(registry.acquire(0, "xunji").unwrap().is_none());
        assert!(registry.acquire(1, "intervals").unwrap().is_none());
        drop((other_source, other_database));
    }
}
