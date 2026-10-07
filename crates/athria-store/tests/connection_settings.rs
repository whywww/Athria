use athria_store::SqliteStore;
use athria_vault::{create_envelope, decrypt_secret, encrypt_secret, new_master_key};
use serde_json::json;

#[test]
fn connection_preferences_preserve_credentials_survive_restart_and_remain_source_specific() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("preferences.sqlite3");
    let store = SqliteStore::open(&path).unwrap();
    let uuid = store.database_uuid().unwrap();
    let master = new_master_key();
    let envelope = create_envelope(&uuid, "test password", &master).unwrap();
    let intervals = encrypt_secret(&uuid, "intervals", json!({ "athleteId": "123", "other": "keep" }), "intervals key", &master).unwrap();
    let xunji = encrypt_secret(&uuid, "xunji", json!({}), "xunji key", &master).unwrap();
    store.initialize_vault(&envelope, &[intervals.clone(), xunji.clone()]).unwrap();
    store.set_connection_daily_auto_sync("intervals", false).unwrap();
    let bundle = store.get_vault().unwrap();
    let updated = bundle.secrets.iter().find(|secret| secret.source == "intervals").unwrap();
    assert_eq!(updated.config, json!({ "athleteId": "123", "other": "keep", "dailyAutoSync": false }));
    assert_eq!((&updated.nonce, &updated.ciphertext, updated.cipher_version), (&intervals.nonce, &intervals.ciphertext, intervals.cipher_version));
    assert_eq!(bundle.secrets.iter().find(|secret| secret.source == "xunji").unwrap(), &xunji);
    drop(store);
    let store = SqliteStore::open(path).unwrap();
    assert_eq!(store.get_vault().unwrap().secrets.iter().find(|secret| secret.source == "intervals").unwrap().config["dailyAutoSync"], false);
    let replacement = encrypt_secret(&uuid, "intervals", json!({ "athleteId": "456" }), "new key", &master).unwrap();
    store.upsert_connection_secret(&replacement).unwrap();
    let bundle = store.get_vault().unwrap();
    let replaced = bundle.secrets.iter().find(|secret| secret.source == "intervals").unwrap();
    assert_eq!(replaced.config, json!({ "athleteId": "456", "dailyAutoSync": false }));
    assert_eq!(decrypt_secret(&uuid, replaced, &master).unwrap().as_str(), "new key");
    store.delete_connection_secret("intervals").unwrap();
    assert!(store.set_connection_daily_auto_sync("intervals", false).is_err());
    store.upsert_connection_secret(&replacement).unwrap();
    assert!(store.get_vault().unwrap().secrets.iter().find(|secret| secret.source == "intervals").unwrap().config.get("dailyAutoSync").is_none());
}
