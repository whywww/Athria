//! Persistence port for [`crate::AthriaApplication`].
//!
//! Implemented by the
//! Rust `SqliteStore` and, in tests, by in-memory fakes. The application layer
//! depends only on this interface: it never opens a database connection and
//! never issues SQL.
//!
//! Implementations throw **store errors**: an [`athria_core::AthriaError`]
//! whose code is the stable identifier (`TEMPLATE_ALREADY_EXISTS`,
//! `REVISION_CONFLICT`, ...) that the application maps to a transport response
//! with a user-facing message. The Rust port keeps the same contract but
//! carries the code in [`athria_core::AthriaError::code`], so the application
//! matches on codes instead of parsing messages.

use serde_json::{Map, Value};

use athria_core::Result;

/// `{ added, updated }` write counts from `upsertSessions` and
/// `replaceSourceSessions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteCounts {
    pub added: i64,
    pub updated: i64,
}

impl WriteCounts {
    pub fn to_json(self) -> Value {
        serde_json::json!({ "added": self.added, "updated": self.updated })
    }
}

/// `replaceSourceSessions` input.
#[derive(Debug)]
pub struct ReplaceSourceSessionsInput<'a> {
    pub owner_id: &'a str,
    pub source: &'a str,
    pub sessions: &'a [Value],
    /// Replace only these local dates (`dates` in TypeScript).
    pub dates: Option<&'a [String]>,
    /// Per-`externalId` local dates supplied by the importer.
    pub local_dates: Option<&'a Map<String, Value>>,
    pub range_start: Option<&'a str>,
    pub range_end: Option<&'a str>,
}

/// `updateCurrentPlannedSessions` input.
#[derive(Debug)]
pub struct UpdateCurrentPlannedSessionsInput<'a> {
    pub owner_id: &'a str,
    pub expected_revision: i64,
    /// Occurrence action recorded on `planned_session_events` (`complete`,
    /// `skip`, `restore`, `move_occurrence`, ...).
    pub mode: &'a str,
    pub sessions: &'a [Value],
    pub reason_code: Option<&'a str>,
    pub reason_note: Option<&'a str>,
}

/// `saveCurrentPlannedSessions` input. `client_request_id` is accepted for
/// interface parity; the store has no replay-cache table, so the response
/// always reports `idempotentReplay: false`, like TypeScript.
#[derive(Debug)]
pub struct SaveCurrentPlannedSessionsInput<'a> {
    pub owner_id: &'a str,
    pub client_request_id: &'a str,
    pub scheduled_date: &'a str,
    pub expected_revision: i64,
    pub mode: &'a str,
    pub sessions: &'a [Value],
}

/// `recordImportBatch` input.
#[derive(Debug)]
pub struct RecordImportBatchInput<'a> {
    pub owner_id: &'a str,
    pub source: &'a str,
    pub content_hash: &'a str,
    pub file_name: &'a str,
    pub parser_version: &'a str,
    pub status: &'a str,
    pub data: &'a Value,
}

/// The persistence port [`crate::AthriaApplication`] depends on.
///
/// Every method returns [`Result`] with [`AthriaError`]; the store raises the
/// stable application error codes.
pub trait AthriaStore {
    /// Runs `work` inside one immediate (write) transaction and returns its
    /// result. Nested calls become savepoints, matching the TypeScript
    /// `sqlite.transaction(...)` behavior.
    fn transaction<T>(&self, work: &mut dyn FnMut() -> Result<T>) -> Result<T>;

    fn get_profile(&self, owner_id: &str) -> Result<Value>;
    fn save_profile(&self, profile: &Value) -> Result<Value>;

    fn list_sessions(&self, owner_id: &str, since: Option<&str>) -> Result<Vec<Value>>;
    fn list_sessions_by_source(
        &self,
        source: &str,
        owner_id: &str,
        since: Option<&str>,
    ) -> Result<Vec<Value>>;
    fn upsert_sessions(&self, sessions: &[Value]) -> Result<WriteCounts>;
    fn replace_source_sessions(
        &self,
        input: &ReplaceSourceSessionsInput<'_>,
    ) -> Result<WriteCounts>;
    fn set_training_session_plan_match(
        &self,
        owner_id: &str,
        training_session_id: &str,
        planned_session_id: Option<&str>,
        expected_revision: i64,
    ) -> Result<Value>;
    fn clear_training_session_plan_exclusion(
        &self,
        owner_id: &str,
        training_session_id: &str,
    ) -> Result<Value>;
    fn set_training_session_type_override(
        &self,
        owner_id: &str,
        training_session_id: &str,
        domain: &str,
    ) -> Result<Value>;
    fn update_manual_training_session(
        &self,
        owner_id: &str,
        training_session_id: &str,
        start_at: Option<&str>,
        duration_minutes: Option<i64>,
    ) -> Result<Value>;
    fn delete_manual_training_session(
        &self,
        owner_id: &str,
        training_session_id: &str,
    ) -> Result<Option<Value>>;
    fn delete_training_session(&self, owner_id: &str, training_session_id: &str) -> Result<()>;

    fn get_wellness(&self, owner_id: &str, day: &str) -> Result<Option<Value>>;
    fn list_wellness(&self, owner_id: &str, since: Option<&str>) -> Result<Vec<Value>>;
    fn save_wellness(&self, record: &Value) -> Result<Value>;
    fn upsert_wellness(&self, owner_id: &str, records: &[Value]) -> Result<i64>;

    fn list_templates(&self, owner_id: &str) -> Result<Vec<Value>>;
    fn get_template(&self, id: &str, owner_id: &str) -> Result<Option<Value>>;
    fn create_template(&self, template: &Value, owner_id: &str) -> Result<Value>;
    fn update_template(
        &self,
        template: &Value,
        expected_revision: i64,
        owner_id: &str,
    ) -> Result<Value>;
    fn delete_template(&self, id: &str, expected_revision: i64, owner_id: &str) -> Result<()>;
    fn list_dismissed_template_ids(&self, owner_id: &str) -> Result<Vec<String>>;
    fn dismiss_template(&self, id: &str, owner_id: &str) -> Result<()>;

    fn get_current_plan(&self, owner_id: &str) -> Result<Option<Value>>;
    fn save_current_plan(
        &self,
        plan: &Value,
        expected_revision: i64,
        deleted_session_ids: &[String],
        updated_sessions: &[Value],
    ) -> Result<Value>;
    fn list_current_planned_sessions(
        &self,
        owner_id: &str,
        scheduled_date: Option<&str>,
    ) -> Result<Vec<Value>>;
    fn schedule_revision(&self, owner_id: &str) -> Result<i64>;
    fn update_current_planned_sessions(
        &self,
        input: &UpdateCurrentPlannedSessionsInput<'_>,
    ) -> Result<Value>;
    fn save_current_planned_sessions(
        &self,
        input: &SaveCurrentPlannedSessionsInput<'_>,
    ) -> Result<Value>;

    fn record_import_batch(&self, input: &RecordImportBatchInput<'_>) -> Result<Value>;
    fn latest_import_batch(&self, owner_id: &str, source: &str) -> Result<Option<Value>>;
    fn get_connection_sync_state(&self, source: &str, owner_id: &str) -> Result<Option<Value>>;
    fn save_connection_sync_state(&self, state: &Value) -> Result<Value>;
}
