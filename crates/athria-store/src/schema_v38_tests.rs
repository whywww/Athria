use super::*;

fn old_store() -> SqliteStore {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(include_str!("schema/schema-v37-test.sql")).unwrap();
    SqliteStore::from_connection(connection, Arc::new(SystemClock), false).unwrap()
}

fn structure(store: &SqliteStore) -> Vec<(String, String, String, Option<String>)> {
    store.connection.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap()
        .map(|row| row.unwrap()).collect()
}

#[test]
fn migration_preserves_documents_and_matches_current_structure() {
    let old = old_store();
    old.connection.execute_batch("INSERT INTO current_mesocycles VALUES ('a','{\"revision\":7,\"updatedAt\":\"original\"}',7,'original');
        INSERT INTO profiles VALUES ('a','{\"heightCm\":-1}','original');
        INSERT INTO training_sessions VALUES ('w','a','manual','e','2026-10-01T12:00:00Z','{\"id\":\"w\",\"sources\":[{\"source\":\"manual\",\"externalId\":\"e\"}]}');
        INSERT INTO training_session_sources VALUES ('s','a','w','manual','e','2026-10-01','2026-10-01T12:00:00Z','{}','original','original');
        INSERT INTO plan_drafts VALUES ('d','a','{}',7,'hash',2,'original','original');
        INSERT INTO plan_draft_weeks VALUES ('d',1,'{}');
        INSERT INTO plan_workout_matches VALUES ('m','a','p','w','manual',100,'v1','{}','original');
        INSERT INTO connection_secrets VALUES ('hevy','{}',1,'nonce','ciphertext','2026-10-01 12:34:56');
        INSERT INTO vault_meta(id,database_uuid,format_version,wrapped_master_key,updated_at) VALUES (1,'uuid',1,'key','2026-10-01 12:34:56');").unwrap();
    let tables = ["profiles", "training_session_sources", "plan_drafts", "plan_draft_weeks", "plan_workout_matches"];
    let snapshot = |table: &str| -> Vec<Vec<Value>> {
        let mut stmt = old.connection.prepare(&format!("SELECT * FROM {table}")).unwrap();
        let columns = stmt.column_count();
        stmt.query_map([], |row| (0..columns).map(|i| match row.get_ref(i)? {
            rusqlite::types::ValueRef::Text(v) => Ok(json!(std::str::from_utf8(v).unwrap())),
            rusqlite::types::ValueRef::Integer(v) => Ok(json!(v)),
            _ => Ok(Value::Null),
        }).collect()).unwrap().map(|r| r.unwrap()).collect()
    };
    let before: Vec<_> = tables.iter().map(|t| snapshot(t)).collect();
    old.connection.execute("UPDATE athria_migrations SET applied_at='2026-10-01T08:00:00+08:00' WHERE version=36", []).unwrap();
    let training: String=old.connection.query_row("SELECT data FROM training_sessions", [], |r|r.get(0)).unwrap();
    let plan = old.get_current_plan("a").unwrap();
    old.require_supported_schema().unwrap();
    assert_eq!(old.schema_version().unwrap(), 38);
    assert_eq!(old.get_current_plan("a").unwrap(), plan);
    assert_eq!(old.connection.query_row("SELECT data FROM training_sessions", [], |r|r.get::<_,String>(0)).unwrap(),training);
    assert_eq!(old.connection.query_row("SELECT applied_at FROM athria_migrations WHERE version=36", [], |r|r.get::<_,String>(0)).unwrap(),"2026-10-01T08:00:00+08:00");
    assert_eq!(tables.iter().map(|t| snapshot(t)).collect::<Vec<_>>(), before);
    let secret: (String, String) = old.connection.query_row("SELECT ciphertext,updated_at FROM connection_secrets", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(secret, ("ciphertext".into(), "2026-10-01T12:34:56.000Z".into()));
    assert_eq!(old.connection.query_row("SELECT wrapped_master_key FROM vault_meta", [], |r| r.get::<_,String>(0)).unwrap(), "key");
    let current = SqliteStore::open_in_memory().unwrap();
    // SQLite rewrites CREATE text during DROP COLUMN; compare normalized semantic definitions.
    let normalize = |s: &SqliteStore| structure(s).into_iter().map(|(kind,name,table,sql)| {
        let sql = sql.map(|v| v.chars().filter(|c| !c.is_whitespace() && *c != '"').collect::<String>());
        (kind,name,table,sql)
    }).collect::<Vec<_>>();
    assert_eq!(normalize(&old), normalize(&current));
    assert_eq!(structure(&old).iter().filter(|r| r.0=="table").count(),21);
    assert_eq!(structure(&old).iter().filter(|r| r.0=="trigger").count(),54);
    let version = old.data_version().unwrap();
    old.require_supported_schema().unwrap();
    assert_eq!(old.data_version().unwrap(), version);
}

#[test]
fn migration_failure_rolls_back_all_schema_changes() {
    let old = old_store();
    old.connection.execute_batch("CREATE TRIGGER fail_upgrade BEFORE INSERT ON athria_migrations WHEN NEW.version=38 BEGIN SELECT RAISE(ABORT,'failure'); END;").unwrap();
    let before = structure(&old);
    let version = old.data_version().unwrap();
    assert!(old.require_supported_schema().is_err());
    assert_eq!(old.schema_version().unwrap(),37);
    assert_eq!(structure(&old),before);
    assert_eq!(old.data_version().unwrap(),version);
}

#[test]
fn wal_upgrade_and_read_only_preview_are_separate() {
    let directory=tempfile::tempdir().unwrap();
    let path=directory.path().join("old.sqlite");
    let connection=Connection::open(&path).unwrap();
    connection.execute_batch(include_str!("schema/schema-v37-test.sql")).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; INSERT INTO profiles VALUES ('a','{\"preferredName\":\"WAL\"}','original');").unwrap();
    assert!(SqliteStore::open_read_only(&path).is_err());
    assert_eq!(connection.query_row("SELECT MAX(version) FROM athria_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),37);
    drop(connection);
    let upgraded=SqliteStore::open(&path).unwrap();
    assert_eq!(upgraded.schema_version().unwrap(),38);
    assert_eq!(upgraded.get_profile("a").unwrap().unwrap()["preferredName"],"WAL");
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
    store.connection.execute("INSERT INTO athria_migrations VALUES (39,'original')", []).unwrap();
    let before=store.data_version().unwrap();
    assert_eq!(store.require_supported_schema().unwrap_err().code(),AthriaErrorCode::SchemaVersionUnsupported);
    assert_eq!(store.schema_version().unwrap(),39);
    assert_eq!(store.data_version().unwrap(),before);
}

#[test]
fn metadata_timestamp_writes_use_the_injected_clock() {
    let now="2026-10-13T12:34:56.000Z";
    let store=SqliteStore::open_in_memory_with_clock(Arc::new(crate::clock::FixedClock::new(now))).unwrap();
    store.set_database_uuid("replacement").unwrap();
    store.connection.execute_batch("INSERT INTO connection_secrets VALUES ('hevy','{}',1,'nonce','cipher','original');").unwrap();
    store.set_connection_daily_auto_sync("hevy",true).unwrap();
    for query in ["SELECT updated_at FROM vault_meta", "SELECT updated_at FROM connection_secrets", "SELECT applied_at FROM athria_migrations WHERE version=38"] {
        assert_eq!(store.connection.query_row(query, [], |r|r.get::<_,String>(0)).unwrap(),now);
    }
}
