//! [`AthriaStore`] over [`SqliteStore`].
//!
//! Every trait method delegates to the rusqlite implementation in
//! [`crate::store`], [`crate::sessions`] and [`crate::planned`]; this file is
//! the only place where the application port and the SQLite implementation
//! meet. Store failures surface with the stable codes documented on the trait.

use athria_application::{
    AthriaStore, RecordImportBatchInput, ReplaceSourceSessionsInput,
    SaveCurrentPlannedSessionsInput, UpdateCurrentPlannedSessionsInput, WriteCounts,
};
use athria_core::Result;
use athria_core::vocab::default_profile;
use serde_json::Value;

use crate::store::SqliteStore;

impl AthriaStore for SqliteStore {
    fn transaction<T>(&self, work: &mut dyn FnMut() -> Result<T>) -> Result<T> {
        SqliteStore::transaction(self, work)
    }

    /// `AthriaRepository.getProfile`, which returns `defaultProfile()` when the
    /// owner has no stored profile yet.
    fn get_profile(&self, owner_id: &str) -> Result<Value> {
        Ok(SqliteStore::get_profile(self, owner_id)?.unwrap_or_else(default_profile))
    }

    fn save_profile(&self, profile: &Value) -> Result<Value> {
        SqliteStore::save_profile(self, profile)?;
        Ok(profile.clone())
    }

    fn list_sessions(&self, owner_id: &str, since: Option<&str>) -> Result<Vec<Value>> {
        SqliteStore::list_sessions(self, owner_id, since)
    }

    fn list_sessions_by_source(
        &self,
        source: &str,
        owner_id: &str,
        since: Option<&str>,
    ) -> Result<Vec<Value>> {
        SqliteStore::list_sessions_by_source(self, source, owner_id, since)
    }

    fn upsert_sessions(&self, sessions: &[Value]) -> Result<WriteCounts> {
        SqliteStore::upsert_sessions(self, sessions)
    }

    fn replace_source_sessions(
        &self,
        input: &ReplaceSourceSessionsInput<'_>,
    ) -> Result<WriteCounts> {
        SqliteStore::replace_source_sessions(self, input)
    }

    fn set_training_session_plan_match(
        &self,
        owner_id: &str,
        training_session_id: &str,
        planned_session_id: Option<&str>,
        expected_revision: i64,
    ) -> Result<Value> {
        SqliteStore::set_training_session_plan_match(
            self,
            owner_id,
            training_session_id,
            planned_session_id,
            expected_revision,
        )
    }

    fn clear_training_session_plan_exclusion(
        &self,
        owner_id: &str,
        training_session_id: &str,
    ) -> Result<Value> {
        SqliteStore::clear_training_session_plan_exclusion(self, owner_id, training_session_id)
    }

    fn set_training_session_type_override(
        &self,
        owner_id: &str,
        training_session_id: &str,
        domain: &str,
    ) -> Result<Value> {
        SqliteStore::set_training_session_type_override(self, owner_id, training_session_id, domain)
    }

    fn update_manual_training_session(
        &self,
        owner_id: &str,
        training_session_id: &str,
        start_at: Option<&str>,
        duration_minutes: Option<i64>,
    ) -> Result<Value> {
        SqliteStore::update_manual_training_session(
            self,
            owner_id,
            training_session_id,
            start_at,
            duration_minutes,
        )
    }

    fn delete_manual_training_session(
        &self,
        owner_id: &str,
        training_session_id: &str,
    ) -> Result<Option<Value>> {
        SqliteStore::delete_manual_training_session(self, owner_id, training_session_id)
    }

    fn delete_training_session(&self, owner_id: &str, training_session_id: &str) -> Result<()> {
        SqliteStore::delete_training_session(self, owner_id, training_session_id)
    }

    fn get_wellness(&self, owner_id: &str, day: &str) -> Result<Option<Value>> {
        SqliteStore::get_wellness(self, owner_id, day)
    }

    fn list_wellness(&self, owner_id: &str, since: Option<&str>) -> Result<Vec<Value>> {
        SqliteStore::list_wellness(self, owner_id, since)
    }

    fn save_wellness(&self, record: &Value) -> Result<Value> {
        SqliteStore::save_wellness(self, record)?;
        Ok(record.clone())
    }

    fn upsert_wellness(&self, owner_id: &str, records: &[Value]) -> Result<i64> {
        SqliteStore::upsert_wellness(self, owner_id, records)
    }

    fn list_templates(&self, owner_id: &str) -> Result<Vec<Value>> {
        SqliteStore::list_templates(self, owner_id)
    }

    fn get_template(&self, id: &str, owner_id: &str) -> Result<Option<Value>> {
        SqliteStore::get_template(self, id, owner_id)
    }

    fn create_template(&self, template: &Value, owner_id: &str) -> Result<Value> {
        SqliteStore::create_template(self, template, owner_id)
    }

    fn update_template(
        &self,
        template: &Value,
        expected_revision: i64,
        owner_id: &str,
    ) -> Result<Value> {
        SqliteStore::update_template(self, template, expected_revision, owner_id)
    }

    fn delete_template(&self, id: &str, expected_revision: i64, owner_id: &str) -> Result<()> {
        SqliteStore::delete_template(self, id, expected_revision, owner_id)
    }

    fn list_dismissed_template_ids(&self, owner_id: &str) -> Result<Vec<String>> {
        SqliteStore::list_dismissed_template_ids(self, owner_id)
    }

    fn dismiss_template(&self, id: &str, owner_id: &str) -> Result<()> {
        SqliteStore::dismiss_template(self, id, owner_id)
    }

    fn get_current_plan(&self, owner_id: &str) -> Result<Option<Value>> {
        SqliteStore::get_current_plan(self, owner_id)
    }

    /// The `deletedSessionIds` / `updatedSessions` arguments are ignored, like
    /// `AthriaRepository.saveCurrentPlan`: the plan document is the only input
    /// the stored rows are derived from.
    fn save_current_plan(
        &self,
        plan: &Value,
        expected_revision: i64,
        _deleted_session_ids: &[String],
        _updated_sessions: &[Value],
    ) -> Result<Value> {
        SqliteStore::save_current_plan(self, plan, expected_revision)
    }

    fn list_current_planned_sessions(
        &self,
        owner_id: &str,
        scheduled_date: Option<&str>,
    ) -> Result<Vec<Value>> {
        SqliteStore::list_current_planned_sessions(self, owner_id, scheduled_date)
    }

    fn schedule_revision(&self, owner_id: &str) -> Result<i64> {
        SqliteStore::schedule_revision(self, owner_id)
    }

    fn update_current_planned_sessions(
        &self,
        input: &UpdateCurrentPlannedSessionsInput<'_>,
    ) -> Result<Value> {
        SqliteStore::update_current_planned_sessions(self, input)
    }

    fn save_current_planned_sessions(
        &self,
        input: &SaveCurrentPlannedSessionsInput<'_>,
    ) -> Result<Value> {
        SqliteStore::save_current_planned_sessions(self, input)
    }

    fn record_import_batch(&self, input: &RecordImportBatchInput<'_>) -> Result<Value> {
        SqliteStore::record_import_batch(self, input)
    }

    fn latest_import_batch(&self, owner_id: &str, source: &str) -> Result<Option<Value>> {
        SqliteStore::latest_import_batch(self, owner_id, source)
    }

    fn get_connection_sync_state(&self, source: &str, owner_id: &str) -> Result<Option<Value>> {
        SqliteStore::get_connection_sync_state(self, source, owner_id)
    }

    fn save_connection_sync_state(&self, state: &Value) -> Result<Value> {
        SqliteStore::save_connection_sync_state(self, state)
    }
}
