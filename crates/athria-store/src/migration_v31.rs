//! Move legacy component classification to the owning planned session.
use athria_core::{Result, training_type};
use rusqlite::params;
use serde_json::Value;
use crate::{SqliteStore, store::database_error};

impl SqliteStore {
    pub(crate) fn migrate_to_v31(&self) -> Result<()> {
        self.transaction(&mut || {
            for table in ["current_mesocycles", "current_planned_sessions", "plan_drafts", "plan_draft_weeks"] {
                if !self.table_exists(table)? { continue; }
                let rows: Vec<(i64, String)> = {
                    let mut statement = self.sqlite().prepare(&format!("SELECT rowid, data FROM {table}")).map_err(database_error)?;
                    statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(database_error)?
                        .collect::<std::result::Result<_, _>>().map_err(database_error)?
                };
                for (id, raw) in rows {
                    let mut value: Value = serde_json::from_str(&raw).map_err(|error| athria_core::AthriaError::new(athria_core::AthriaErrorCode::InvalidData, error.to_string()))?;
                    training_type::migrate_session_domains(&mut value);
                    if let Some(revision) = value.get("revision").and_then(Value::as_i64) { value["revision"] = (revision + 1).into(); }
                    self.sqlite().execute(&format!("UPDATE {table} SET data=?1 WHERE rowid=?2"), params![value.to_string(), id]).map_err(database_error)?;
                }
            }
            self.sqlite().execute_batch("UPDATE current_mesocycles SET revision=revision+1; UPDATE plan_drafts SET draft_revision=draft_revision+1, base_plan_revision=base_plan_revision+1; UPDATE athria_data_version SET version=version+1; INSERT INTO athria_migrations(version, applied_at) VALUES (31, CURRENT_TIMESTAMP);").map_err(database_error)?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use athria_application::AthriaApplication;

    #[test]
    fn v30_plan_migrates_once_and_calendar_uses_the_preserved_session_domain() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.sqlite3");
        {
            let store = SqliteStore::open(&path).unwrap();
            store.sqlite().execute_batch("DELETE FROM athria_migrations WHERE version=31;").unwrap();
            let plan = json!({"ownerId":"local-user","revision":2,"updatedAt":"2026-10-08T00:00:00Z","effectiveStartDate":"2026-10-05","mesocycle":{
                "durationWeeks":1,"domainProgressions":[{"domain":"endurance","phases":[{"id":"base","startWeek":1,"endWeek":1}]}],
                "weeks":[{"weekNumber":1,"sessions":[{"id":"weekend","name":"周末轻松跑走","type":null,"scheduledDate":"2026-10-11","order":0,"durationMinutes":45,"status":"planned","components":[{"id":"easy","name":"Easy","domain":{"value":"endurance"},"prescription":{"kind":"duration_only","notes":"Keep it easy"}}]}]}]
            }});
            store.sqlite().execute("INSERT INTO current_mesocycles VALUES ('local-user',?1,2,'original')", [plan.to_string()]).unwrap();
        }
        let store = SqliteStore::open(&path).unwrap();
        let plan = store.get_current_plan("local-user").unwrap().unwrap();
        assert_eq!(plan["revision"], 3);
        let session = &plan["mesocycle"]["weeks"][0]["sessions"][0];
        assert_eq!(session["domain"], "endurance");
        assert_eq!(session["type"], Value::Null);
        assert!(session["components"][0].get("domain").is_none());
        let version = store.data_version().unwrap();
        let app = AthriaApplication::new(store);
        let calendar = app.get_calendar(None, None).unwrap();
        assert_eq!(calendar[0]["domain"], "endurance");
        assert_eq!(calendar[0]["domains"], json!(["endurance"]));
        assert_eq!(calendar[0]["phaseRefs"], json!([{"domain":"endurance","phaseId":"base"}]));
        drop(app);
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.data_version().unwrap(), version);
        assert_eq!(store.get_current_plan("local-user").unwrap().unwrap(), plan);
    }

    #[test]
    fn malformed_legacy_documents_roll_back_the_entire_upgrade() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.sqlite().execute_batch("DELETE FROM athria_migrations WHERE version=31; INSERT INTO current_mesocycles VALUES ('a','{\"revision\":2}',2,'original'); INSERT INTO plan_drafts VALUES ('broken','a','{invalid',2,'snapshot',1,'active',NULL,'original','original');").unwrap();
        let version = store.data_version().unwrap();
        assert!(store.migrate_to_v31().is_err());
        assert_eq!(store.schema_version().unwrap(), 30);
        assert_eq!(store.get_current_plan("a").unwrap().unwrap()["revision"], 2);
        assert_eq!(store.data_version().unwrap(), version);
    }
}
