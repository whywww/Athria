use super::*;

#[test]
fn fresh_v40_database_enforces_one_canonical_rpe_value() {
    let store=SqliteStore::open_in_memory().unwrap();
    assert!(!store.table_exists("training_session_effort_overrides").unwrap());
    for value in [json!(0),json!(11),json!(3.5),json!("3")] {
        assert!(store.connection.execute("INSERT INTO training_sessions VALUES ('w','a','now',?1)",[json!({"rpe":value}).to_string()]).is_err());
    }
    for value in [json!(1),json!(10),Value::Null] {
        store.connection.execute("INSERT OR REPLACE INTO training_sessions VALUES ('w','a','now',?1)",[json!({"rpe":value}).to_string()]).unwrap();
    }
    for value in [json!(3),Value::Null] {
        assert!(store.connection.execute("INSERT INTO training_session_sources VALUES ('s','a','w','intervals','e','day','now',?1,'now','now')",[json!({"rpe":value}).to_string()]).is_err());
    }
}

#[test]
fn date_and_source_queries_use_range_indexes() {
    let store=SqliteStore::open_in_memory().unwrap();
    for (sql,index) in [
        ("SELECT data FROM wellness WHERE owner_id='a' AND day >= '2026-10-01' ORDER BY day DESC", "wellness_owner_day_v12"),
        ("SELECT data FROM training_session_sources WHERE owner_id='a' AND source='hevy' AND start_at >= '2026-10-01' ORDER BY start_at DESC", "session_sources_owner_source_start"),
        ("SELECT data FROM session_templates WHERE owner_id='a' ORDER BY updated_at DESC", "templates_owner_updated"),
    ] {
        let details=store.connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap().query_map([],|r|r.get::<_,String>(3)).unwrap().map(|r|r.unwrap()).collect::<Vec<_>>().join(" ");
        assert!(details.contains(index),"{details}");
        assert!(!details.contains("TEMP B-TREE"),"{details}");
    }
}

#[test]
fn future_versions_are_rejected_without_changes() {
    let store=SqliteStore::open_in_memory().unwrap();
    store.connection.execute("INSERT INTO athria_migrations VALUES (41,'original')", []).unwrap();
    let before=store.data_version().unwrap();
    assert_eq!(store.require_supported_schema().unwrap_err().code(),AthriaErrorCode::SchemaVersionUnsupported);
    assert_eq!(store.schema_version().unwrap(),41);
    assert_eq!(store.data_version().unwrap(),before);
}

#[test]
fn metadata_timestamp_writes_use_the_injected_clock() {
    let now="2026-10-13T12:34:56.000Z";
    let store=SqliteStore::open_in_memory_with_clock(Arc::new(crate::clock::FixedClock::new(now))).unwrap();
    store.set_database_uuid("replacement").unwrap();
    store.connection.execute_batch("INSERT INTO connection_secrets VALUES ('hevy','{}',1,'nonce','cipher','original');").unwrap();
    store.set_connection_daily_auto_sync("hevy",true).unwrap();
    for query in ["SELECT updated_at FROM vault_meta", "SELECT updated_at FROM connection_secrets", "SELECT applied_at FROM athria_migrations WHERE version=40"] {
        assert_eq!(store.connection.query_row(query, [], |r|r.get::<_,String>(0)).unwrap(),now);
    }
}

#[test]
fn current_schema_has_complete_structure_and_reopens_without_changes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("current.sqlite3");
    let store = SqliteStore::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 40);
    for (kind, count) in [("table", 22), ("trigger", 58)] {
        let actual: i64 = store.connection.query_row("SELECT count(*) FROM sqlite_master WHERE type=?1 AND name NOT LIKE 'sqlite_%'", [kind], |r|r.get(0)).unwrap();
        assert_eq!(actual,count);
    }
    store.save_profile(&json!({"ownerId":"a","preferredName":"Keep"})).unwrap();
    let before = store.data_version().unwrap();
    let uuid = store.database_uuid().unwrap();
    drop(store);
    let reopened = SqliteStore::open(&path).unwrap();
    assert_eq!(reopened.data_version().unwrap(),before);
    assert_eq!(reopened.database_uuid().unwrap(),uuid);
    assert_eq!(reopened.get_profile("a").unwrap().unwrap()["preferredName"],"Keep");
}

#[test]
fn previous_versions_are_rejected_by_writable_and_read_only_opens_without_changes() {
    for version in [37,38,39] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unsupported.sqlite3");
        let store = SqliteStore::open(&path).unwrap();
        store.save_profile(&json!({"ownerId":"a","preferredName":"Keep"})).unwrap();
        store.connection.execute("DELETE FROM athria_migrations WHERE version>?1",[version]).unwrap();
        drop(store);
        let before = std::fs::read(&path).unwrap();
        assert_eq!(SqliteStore::open(&path).unwrap_err().code(),AthriaErrorCode::SchemaVersionUnsupported);
        assert_eq!(SqliteStore::open_read_only(&path).unwrap_err().code(),AthriaErrorCode::SchemaVersionUnsupported);
        assert_eq!(std::fs::read(&path).unwrap(),before);
    }
}
