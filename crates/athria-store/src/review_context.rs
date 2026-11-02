//! Compact net Profile changes since the last confirmed plan commit.
use athria_core::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use crate::{SqliteStore, store::database_error};


const FIELDS: &[&str] = &[
    "goals", "preference", "usualSessionMinutes", "trainingRhythm", "equipment",
    "injuries", "constraintNotes", "explicitRecoveryDays", "mesocycleDurationWeeks", "raceDays",
];

impl SqliteStore {
    pub fn get_plan_review_context(&self, owner_id: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self.sqlite().query_row(
            "SELECT data FROM plan_review_context WHERE owner_id=?1", params![owner_id], |row| row.get(0),
        ).optional().map_err(database_error)?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(|error| athria_core::AthriaError::new(
            athria_core::AthriaErrorCode::InvalidData, error.to_string(),
        ))).transpose()
    }

    fn write_plan_review_context(&self, owner_id: &str, context: &Value) -> Result<()> {
        self.sqlite().execute(
            "INSERT INTO plan_review_context(owner_id, data) VALUES (?1, ?2) ON CONFLICT(owner_id) DO UPDATE SET data=excluded.data",
            params![owner_id, context.to_string()],
        ).map_err(database_error)?;
        Ok(())
    }

    pub fn reset_plan_review_context(&self, owner_id: &str, committed_at: &str, revision: i64) -> Result<()> {
        self.write_plan_review_context(owner_id, &json!({
            "committedAt": committed_at, "committedPlanRevision": revision,
            "trackingStartedAt": committed_at, "trackingComplete": true, "profileChanges": [],
        }))
    }

    pub(crate) fn track_profile_changes(&self, owner_id: &str, before: &Value, after: &Value, now: &str) -> Result<()> {
        if FIELDS.iter().all(|field| before[*field] == after[*field]) { return Ok(()); }
        let mut context = self.get_plan_review_context(owner_id)?.unwrap_or_else(|| json!({
            "committedAt": null, "committedPlanRevision": null, "trackingStartedAt": now,
            "trackingComplete": false, "profileChanges": [],
        }));
        let changes = context["profileChanges"].as_array_mut().expect("stored changes are an array");
        for field in FIELDS {
            if before[*field] == after[*field] { continue; }
            if let Some(index) = changes.iter().position(|change| change["field"] == *field) {
                if changes[index]["before"] == after[*field] {
                    changes.remove(index);
                } else {
                    changes[index]["after"] = after[*field].clone();
                    changes[index]["lastChangedAt"] = now.into();
                }
            } else {
                changes.push(json!({"field": field, "before": before[*field], "after": after[*field],
                    "firstChangedAt": now, "lastChangedAt": now}));
            }
        }
        self.write_plan_review_context(owner_id, &context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use athria_core::{AthriaError, AthriaErrorCode};

    #[test]
    fn profile_and_diff_roll_back_together_and_owners_are_isolated() {
        let store = SqliteStore::open_in_memory().unwrap();
        let profile = json!({"ownerId":"a", "preference":"A"});
        store.save_profile(&profile).unwrap();
        store.reset_plan_review_context("a", "2026-10-01T00:00:00Z", 1).unwrap();
        let original = store.get_plan_review_context("a").unwrap();
        let result: Result<()> = store.transaction(&mut || {
            store.save_profile(&json!({"ownerId":"a", "preference":"B"}))?;
            Err(AthriaError::new(AthriaErrorCode::InvalidData, "rollback"))
        });
        assert!(result.is_err());
        assert_eq!(store.get_profile("a").unwrap().unwrap(), profile);
        assert_eq!(store.get_plan_review_context("a").unwrap(), original);
        store.save_profile(&json!({"ownerId":"b", "preference":"B"})).unwrap();
        store.save_profile(&json!({"ownerId":"b", "preference":"C"})).unwrap();
        assert_eq!(store.get_plan_review_context("a").unwrap(), original);
        assert_eq!(store.get_plan_review_context("b").unwrap().unwrap()["trackingComplete"], false);
        let other_database = SqliteStore::open_in_memory().unwrap();
        assert!(other_database.get_plan_review_context("a").unwrap().is_none());
    }

    #[test]
    fn first_profile_write_after_a_default_profile_plan_still_tracks_changes() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.reset_plan_review_context("local-user", "2026-10-01T00:00:00Z", 1).unwrap();
        let mut profile = athria_core::vocab::default_profile();
        profile["preference"] = "More running".into();
        store.save_profile(&profile).unwrap();
        let context = store.get_plan_review_context("local-user").unwrap().unwrap();
        assert_eq!(context["profileChanges"].as_array().unwrap().len(), 1);
        assert_eq!(context["profileChanges"][0]["field"], "preference");
        assert_eq!(context["profileChanges"][0]["before"], "");
        assert_eq!(context["profileChanges"][0]["after"], "More running");
    }

    #[test]
    fn rejecting_an_old_database_does_not_invent_review_context() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.sqlite3");
        let profile = json!({"ownerId":"a", "preference":"Old preference"});
        {
            let store = SqliteStore::open(&path).unwrap();
            store.save_profile(&profile).unwrap();
            store.sqlite().execute_batch("DROP TABLE plan_review_context; UPDATE athria_migrations SET version=31;").unwrap();
        }
        assert_eq!(SqliteStore::open(&path).unwrap_err().code(), AthriaErrorCode::SchemaVersionUnsupported);
        let connection = rusqlite::Connection::open(&path).unwrap();
        let raw: String = connection.query_row("SELECT data FROM profiles WHERE owner_id='a'", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), profile);
        assert_eq!(connection.query_row("SELECT MAX(version) FROM athria_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 31);
        assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_master WHERE name='plan_review_context'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
}
