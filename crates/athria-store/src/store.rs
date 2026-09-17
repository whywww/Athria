//! rusqlite-backed store for Athria SQLite databases.
//!
//! Semantics mirror `packages/data/src/index.ts`: identical tables, identical
//! upsert targets, optimistic revision checks and `BEGIN IMMEDIATE` write
//! transactions. The training-session reconciliation engine and planned-session
//! projection live in [`crate::sessions`] and [`crate::planned`]; schema
//! validation, snapshot hashing and vault/crypto stay TypeScript-only until
//! later phases.

use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;

use athria_core::{AthriaError, AthriaErrorCode, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::clock::{Clock, SystemClock};
use crate::sessions::js_number_value;

/// Owner id used by the single-user desktop application.
pub const DEFAULT_OWNER_ID: &str = "local-user";

/// Latest schema version this store opens and creates.
pub const SUPPORTED_SCHEMA_VERSION: i64 = 24;

/// Canonical v24 DDL captured from a fresh TypeScript-created database via
/// `bun run scripts/store-compat.ts --dump-schema`. Regenerate whenever the
/// TypeScript schema changes and review the diff.
const SCHEMA_V24_SQL: &str = include_str!("schema/schema-v24.sql");

pub(crate) fn database_error(error: rusqlite::Error) -> AthriaError {
    if let rusqlite::Error::SqliteFailure(inner, _) = &error {
        if matches!(inner.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) {
            return AthriaError::new(AthriaErrorCode::WriteBusy, "WRITE_BUSY");
        }
    }
    AthriaError::new(AthriaErrorCode::InvalidData, error.to_string())
}

fn json_error(error: serde_json::Error) -> AthriaError {
    AthriaError::new(AthriaErrorCode::InvalidData, error.to_string())
}

fn missing_field(field: &str) -> AthriaError {
    AthriaError::new(AthriaErrorCode::InvalidData, format!("record is missing required field `{field}`"))
}

fn owner_of(value: &Value) -> &str {
    value.get("ownerId").and_then(Value::as_str).unwrap_or(DEFAULT_OWNER_ID)
}

pub(crate) fn parse_json_column(data: &str) -> Result<Value> {
    serde_json::from_str(data).map_err(json_error)
}

/// Template row `data` column: the template object without its `id`.
fn template_data(template: &Value) -> Result<Value> {
    let Value::Object(fields) = template.clone() else {
        return Err(AthriaError::new(AthriaErrorCode::InvalidData, "template is not a JSON object"));
    };
    Ok(Value::Object(fields.into_iter().filter(|(key, _)| key != "id").collect()))
}

/// Stored template view: `{ id, ...data, origin: "user", revision }`, matching
/// `storedTemplate()` in the TypeScript store.
fn stored_template(id: &str, data: &Value, revision: i64) -> Result<Value> {
    let Value::Object(fields) = data.clone() else {
        return Err(AthriaError::new(AthriaErrorCode::InvalidData, "template data is not a JSON object"));
    };
    let mut stored = Map::new();
    stored.insert("id".to_string(), Value::String(id.to_string()));
    for (key, value) in fields {
        stored.insert(key, value);
    }
    stored.insert("origin".to_string(), Value::String("user".to_string()));
    stored.insert("revision".to_string(), Value::Number(revision.into()));
    Ok(Value::Object(stored))
}

/// Wellness import input, the Rust port of `recordImportBatch`'s argument.
#[derive(Debug, Clone)]
pub struct RecordImportBatchInput<'a> {
    pub owner_id: &'a str,
    pub source: &'a str,
    pub content_hash: &'a str,
    pub file_name: &'a str,
    pub parser_version: &'a str,
    pub status: &'a str,
    pub data: &'a Value,
}

/// JavaScript `String(value)` for the JSON scalars wellness payloads carry.
/// Structured values stringify to something that fails the day regex in both
/// implementations, so they collapse to the empty string here.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

/// JavaScript `Number(value)` for the JSON scalars wellness payloads carry;
/// `None` encodes `NaN`/`Infinity`, which `Number.isFinite` rejects.
fn js_number(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(value) => value.as_f64()?,
        Value::Bool(value) => if *value { 1.0 } else { 0.0 },
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() { 0.0 } else { trimmed.parse::<f64>().ok()? }
        }
        _ => return None,
    };
    number.is_finite().then_some(number)
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..].iter().all(u8::is_ascii_digit)
}

type ImportBatchColumns = (String, String, String, String, String, String, String, String, String);

fn import_batch_columns(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportBatchColumns> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

/// Drizzle row shape of `import_batches`, including the JSON-mode `data` column.
fn import_batch_value(columns: ImportBatchColumns) -> Result<Value> {
    let (id, owner_id, source, content_hash, file_name, parser_version, status, data, created_at) = columns;
    Ok(json!({
        "id": id,
        "ownerId": owner_id,
        "source": source,
        "contentHash": content_hash,
        "fileName": file_name,
        "parserVersion": parser_version,
        "status": status,
        "data": parse_json_column(&data)?,
        "createdAt": created_at,
    }))
}

/// `(field, accepted intervals.icu names)` in the order of
/// `AthriaRepository.upsertWellness`'s alias map.
const WELLNESS_ALIASES: [(&str, &[&str]); 23] = [
    ("restingHeartRateBpm", &["restingHR", "restingHeartRate"]),
    ("hrvRmssdMs", &["hrv", "hrvRmssd"]),
    ("hrvSdnnMs", &["hrvSDNN", "hrvSdnn"]),
    ("sleepSeconds", &["sleepSecs", "sleepSeconds"]),
    ("sleepScore", &["sleepScore"]),
    ("sleepQuality", &["sleepQuality"]),
    ("avgSleepingHeartRateBpm", &["avgSleepingHR"]),
    ("weightKg", &["weight"]),
    ("bodyFatPercent", &["bodyFat"]),
    ("vo2maxMlKgMin", &["vo2max"]),
    ("spo2Percent", &["spO2"]),
    ("stepsCount", &["steps"]),
    ("respirationRpm", &["respiration"]),
    ("fatigue", &["fatigue"]),
    ("soreness", &["soreness"]),
    ("stress", &["stress"]),
    ("mood", &["mood"]),
    ("motivation", &["motivation"]),
    ("readiness", &["readiness"]),
    ("injuryScore", &["injury"]),
    ("eftpWatts", &["eftpWatts"]),
    ("wPrimeJoules", &["wPrimeJoules"]),
    ("pMaxWatts", &["pMaxWatts"]),
];

/// Key order of `wellnessRecordSchema.fields`; stored records follow it
/// regardless of merge order, matching Zod's parse output.
const WELLNESS_FIELD_ORDER: [&str; 24] = [
    "restingHeartRateBpm",
    "hrvRmssdMs",
    "hrvSdnnMs",
    "sleepSeconds",
    "sleepScore",
    "sleepQuality",
    "avgSleepingHeartRateBpm",
    "weightKg",
    "bodyFatPercent",
    "vo2maxMlKgMin",
    "spo2Percent",
    "stepsCount",
    "respirationRpm",
    "fatigue",
    "soreness",
    "stress",
    "mood",
    "motivation",
    "readiness",
    "injuryScore",
    "notes",
    "eftpWatts",
    "wPrimeJoules",
    "pMaxWatts",
];

/// Store implementation over a single SQLite connection.
///
/// The connection is closed when the store is dropped; callers that hand the
/// database file to another process should drop the store (or call
/// [`SqliteStore::close`]) first.
#[derive(Debug)]
pub struct SqliteStore {
    connection: Connection,
    clock: Rc<dyn Clock>,
    /// Nested-transaction depth; SQLite does not allow nested `BEGIN`, so
    /// nested calls use savepoints like the `bun:sqlite` transactions the
    /// TypeScript store relies on.
    depth: Cell<u32>,
}

impl SqliteStore {
    /// Opens an Athria database, creating and bootstrapping it when the file
    /// has no tables yet. Databases from any other schema version fail with
    /// `SCHEMA_VERSION_UNSUPPORTED` instead of being migrated or modified.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_clock(path, Rc::new(SystemClock))
    }

    /// In-memory store used by unit tests; bootstraps a fresh v24 database.
    pub fn open_in_memory() -> Result<Self> {
        Self::open_in_memory_with_clock(Rc::new(SystemClock))
    }

    /// Opens a database with an injected clock, for fixtures and tests.
    pub fn open_with_clock(path: impl AsRef<Path>, clock: Rc<dyn Clock>) -> Result<Self> {
        let connection = Connection::open(path).map_err(database_error)?;
        Self::from_connection(connection, clock)
    }

    /// In-memory store with an injected clock, for fixtures and tests.
    pub fn open_in_memory_with_clock(clock: Rc<dyn Clock>) -> Result<Self> {
        let connection = Connection::open_in_memory().map_err(database_error)?;
        Self::from_connection(connection, clock)
    }

    fn from_connection(connection: Connection, clock: Rc<dyn Clock>) -> Result<Self> {
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;").map_err(database_error)?;
        connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0)).map_err(database_error)?;
        let store = Self { connection, clock, depth: Cell::new(0) };
        store.require_supported_schema()?;
        Ok(store)
    }

    /// Drops the connection so Windows releases the file immediately.
    pub fn close(self) {}

    /// `this.now().toISOString()` equivalent.
    pub fn now(&self) -> String {
        self.clock.now_iso()
    }

    /// Immediate (BEGIN IMMEDIATE) write transaction with savepoint nesting,
    /// the port of `AthriaRepository.transaction`. Nested calls inside an
    /// open transaction use `SAVEPOINT`, matching `bun:sqlite` semantics.
    pub fn transaction<T>(&self, work: &mut dyn FnMut() -> Result<T>) -> Result<T> {
        if self.depth.get() == 0 {
            self.connection.execute_batch("BEGIN IMMEDIATE").map_err(database_error)?;
            self.depth.set(1);
            match work() {
                Ok(value) => {
                    self.depth.set(0);
                    self.connection.execute_batch("COMMIT").map_err(database_error)?;
                    Ok(value)
                }
                Err(error) => {
                    self.depth.set(0);
                    let _ = self.connection.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        } else {
            let name = format!("athria_sp_{}", self.depth.get());
            self.connection.execute_batch(&format!("SAVEPOINT {name}")).map_err(database_error)?;
            self.depth.set(self.depth.get() + 1);
            match work() {
                Ok(value) => {
                    self.depth.set(self.depth.get() - 1);
                    self.connection.execute_batch(&format!("RELEASE {name}")).map_err(database_error)?;
                    Ok(value)
                }
                Err(error) => {
                    self.depth.set(self.depth.get() - 1);
                    let _ = self.connection.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
                    Err(error)
                }
            }
        }
    }

    pub(crate) fn require_supported_schema(&self) -> Result<()> {
        let tables: i64 = self
            .connection
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0))
            .map_err(database_error)?;
        if tables == 0 {
            return self.bootstrap_fresh_schema();
        }
        if !self.table_exists("athria_migrations")? {
            return Err(AthriaError::new(
                AthriaErrorCode::SchemaVersionUnsupported,
                "This file is not an Athria database: it has no athria_migrations table.",
            ));
        }
        match self.schema_version()? {
            SUPPORTED_SCHEMA_VERSION => Ok(()),
            version if version < SUPPORTED_SCHEMA_VERSION => Err(AthriaError::new(
                AthriaErrorCode::SchemaVersionUnsupported,
                format!("Database schema version {version} is older than the supported version {SUPPORTED_SCHEMA_VERSION}. Open it once with the current Athria app to migrate it, then retry."),
            )),
            version => Err(AthriaError::new(
                AthriaErrorCode::SchemaVersionUnsupported,
                format!("Database schema version {version} is newer than the supported version {SUPPORTED_SCHEMA_VERSION}. Upgrade Athria to open this database."),
            )),
        }
    }

    pub(crate) fn table_exists(&self, name: &str) -> Result<bool> {
        let count: i64 = self
            .connection
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", params![name], |row| row.get(0))
            .map_err(database_error)?;
        Ok(count > 0)
    }

    /// Raw connection access for the sibling `sessions` and `planned` modules;
    /// both are part of this crate and keep the same error mapping.
    pub(crate) fn sqlite(&self) -> &Connection {
        &self.connection
    }

    fn bootstrap_fresh_schema(&self) -> Result<()> {
        let mut sql = String::from("BEGIN IMMEDIATE;\n");
        sql.push_str(SCHEMA_V24_SQL);
        // Mirror the TypeScript migration rows 1..=24 so both implementations
        // agree on the applied-migration set of a fresh database.
        for version in 1..=SUPPORTED_SCHEMA_VERSION {
            sql.push_str(&format!("INSERT INTO athria_migrations(version, applied_at) VALUES ({version}, CURRENT_TIMESTAMP);\n"));
        }
        sql.push_str(&format!(
            "INSERT INTO vault_meta(id, database_uuid, format_version, updated_at) VALUES (1, '{}', 1, CURRENT_TIMESTAMP);\n",
            Uuid::new_v4()
        ));
        sql.push_str("COMMIT;\n");
        self.connection.execute_batch(&sql).map_err(database_error)
    }

    /// Highest applied migration version; fresh or migrated databases created
    /// by the TypeScript store report 24.
    pub fn schema_version(&self) -> Result<i64> {
        self.connection
            .query_row("SELECT COALESCE(MAX(version), 0) FROM athria_migrations", [], |row| row.get(0))
            .map_err(database_error)
    }

    /// Flushes the WAL into the main database file (backup/restore parity with
    /// `AthriaRepository.checkpoint`).
    pub fn checkpoint(&self) -> Result<()> {
        self.connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(database_error)
    }

    pub fn get_profile(&self, owner_id: &str) -> Result<Option<Value>> {
        let data: Option<String> = self
            .connection
            .query_row("SELECT data FROM profiles WHERE owner_id = ?1", params![owner_id], |row| row.get(0))
            .optional()
            .map_err(database_error)?;
        data.map(|value| parse_json_column(&value)).transpose()
    }

    pub fn save_profile(&self, profile: &Value) -> Result<()> {
        self.connection
            .execute(
                "INSERT INTO profiles(owner_id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                params![owner_of(profile), profile.to_string(), self.now()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn get_wellness(&self, owner_id: &str, day: &str) -> Result<Option<Value>> {
        let data: Option<String> = self
            .connection
            .query_row("SELECT data FROM wellness WHERE owner_id = ?1 AND day = ?2", params![owner_id, day], |row| row.get(0))
            .optional()
            .map_err(database_error)?;
        data.map(|value| parse_json_column(&value)).transpose()
    }

    pub fn list_wellness(&self, owner_id: &str, since: Option<&str>) -> Result<Vec<Value>> {
        let mut statement = self.connection.prepare("SELECT day, data FROM wellness WHERE owner_id = ?1 ORDER BY day DESC").map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(database_error)?;
        let mut records = Vec::new();
        for row in rows {
            let (day, data) = row.map_err(database_error)?;
            if since.is_some_and(|since| day.as_str() < since) {
                continue;
            }
            records.push(parse_json_column(&data)?);
        }
        Ok(records)
    }

    pub fn save_wellness(&self, record: &Value) -> Result<()> {
        let day = record.get("day").and_then(Value::as_str).ok_or_else(|| missing_field("day"))?;
        let updated_at = record.get("updatedAt").and_then(Value::as_str).ok_or_else(|| missing_field("updatedAt"))?;
        self.connection
            .execute(
                "INSERT INTO wellness(owner_id, day, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner_id, day) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                params![owner_of(record), day, record.to_string(), updated_at],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// Upserts wellness records from intervals.icu payloads, mirroring
    /// `AthriaRepository.upsertWellness`: today's aliases, the "Ride" power
    /// extraction, the field merge that keeps non-intervals sources and the
    /// `fields` key order of `wellnessRecordSchema`. Returns the stored count.
    pub fn upsert_wellness(&self, owner_id: &str, records: &[Value]) -> Result<i64> {
        let mut stored = 0;
        self.transaction(&mut || {
            for payload in records {
                let Some(value) = payload.as_object() else { continue };
                let day = ["id", "day", "date"]
                    .iter()
                    .find_map(|key| value.get(*key).filter(|item| !item.is_null()))
                    .map(js_string)
                    .unwrap_or_default();
                let day: String = day.chars().take(10).collect();
                if !is_iso_date(&day) {
                    continue;
                }
                let existing = self.get_wellness(owner_id, &day)?;
                let updated_at = self.now();
                let sport_info: Vec<&Value> = value
                    .get("sportInfo")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter(|item| item.is_object()).collect())
                    .unwrap_or_default();
                let power = sport_info
                    .iter()
                    .find(|item| item.get("type").and_then(Value::as_str) == Some("Ride"))
                    .or_else(|| {
                        sport_info
                            .iter()
                            .find(|item| ["eftp", "wPrime", "pMax"].iter().any(|key| item.get(*key).is_some_and(|value| !value.is_null())))
                    })
                    .copied();
                let mut extended = Map::new();
                extended.extend(value.clone());
                if let Some(power) = power {
                    for (field, name) in [("eftpWatts", "eftp"), ("wPrimeJoules", "wPrime"), ("pMaxWatts", "pMax")] {
                        extended.insert(field.to_string(), power.get(name).cloned().unwrap_or(Value::Null));
                    }
                }
                let mut fields: Map<String, Value> = existing
                    .as_ref()
                    .and_then(|record| record.get("fields"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                for (field, names) in WELLNESS_ALIASES {
                    let prior = fields.get(field);
                    if prior.is_some_and(|prior| prior.get("source").and_then(Value::as_str) != Some("intervals_icu")) {
                        continue;
                    }
                    let raw = names
                        .iter()
                        .find_map(|name| extended.get(*name).filter(|item| !item.is_null() && **item != Value::String(String::new())));
                    let Some(raw) = raw else { continue };
                    let Some(number) = js_number(raw) else { continue };
                    fields.insert(field.to_string(), json!({ "value": js_number_value(number), "source": "intervals_icu", "updatedAt": updated_at }));
                }
                let mut ordered = Map::new();
                for field in WELLNESS_FIELD_ORDER {
                    if let Some(field_value) = fields.get(field) {
                        ordered.insert(field.to_string(), field_value.clone());
                    }
                }
                let record = json!({ "ownerId": owner_id, "day": day, "fields": Value::Object(ordered), "updatedAt": updated_at });
                self.save_wellness(&record)?;
                stored += 1;
            }
            Ok(())
        })?;
        Ok(stored)
    }


    /// Canonical training sessions, ordered most recent first like
    /// `AthriaRepository.listSessions`. Returns the stored JSON as-is; source
    /// summaries and plan matches stay TypeScript-only until Phase 5.
    pub fn list_training_sessions(&self, owner_id: &str) -> Result<Vec<Value>> {
        let mut statement = self.connection.prepare("SELECT data FROM training_sessions WHERE owner_id = ?1 ORDER BY start_at DESC").map_err(database_error)?;
        let rows = statement.query_map(params![owner_id], |row| row.get::<_, String>(0)).map_err(database_error)?;
        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(parse_json_column(&row.map_err(database_error)?)?);
        }
        Ok(sessions)
    }

    pub fn list_training_session_sources(&self, owner_id: &str) -> Result<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare("SELECT training_session_id, source, external_id, local_date FROM training_session_sources WHERE owner_id = ?1 ORDER BY source, external_id")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| {
                Ok(json!({
                    "trainingSessionId": row.get::<_, String>(0)?,
                    "source": row.get::<_, String>(1)?,
                    "externalId": row.get::<_, String>(2)?,
                    "localDate": row.get::<_, String>(3)?,
                }))
            })
            .map_err(database_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(database_error)
    }

    pub fn list_templates(&self, owner_id: &str) -> Result<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, data, revision FROM session_templates WHERE owner_id = ?1 ORDER BY updated_at DESC")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
            .map_err(database_error)?;
        let mut templates = Vec::new();
        for row in rows {
            let (id, data, revision) = row.map_err(database_error)?;
            templates.push(stored_template(&id, &parse_json_column(&data)?, revision)?);
        }
        Ok(templates)
    }

    pub fn get_template(&self, id: &str, owner_id: &str) -> Result<Option<Value>> {
        let row = self
            .connection
            .query_row("SELECT data, revision FROM session_templates WHERE id = ?1 AND owner_id = ?2", params![id, owner_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()
            .map_err(database_error)?;
        row.map(|(data, revision)| stored_template(id, &parse_json_column(&data)?, revision)).transpose()
    }

    pub fn create_template(&self, template: &Value, owner_id: &str) -> Result<Value> {
        let id = template.get("id").and_then(Value::as_str).ok_or_else(|| missing_field("id"))?;
        if self.get_template(id, owner_id)?.is_some() {
            return Err(AthriaError::new(AthriaErrorCode::TemplateAlreadyExists, "TEMPLATE_ALREADY_EXISTS"));
        }
        let data = template_data(template)?;
        let now = self.now();
        self.connection
            .execute(
                "INSERT INTO session_templates(id, owner_id, data, revision, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                params![id, owner_id, data.to_string(), now],
            )
            .map_err(database_error)?;
        stored_template(id, &data, 1)
    }

    pub fn update_template(&self, template: &Value, expected_revision: i64, owner_id: &str) -> Result<Value> {
        let id = template.get("id").and_then(Value::as_str).ok_or_else(|| missing_field("id"))?.to_string();
        self.transaction(&mut || {
            let current = self
                .get_template(&id, owner_id)?
                .ok_or_else(|| AthriaError::new(AthriaErrorCode::TemplateNotFound, "TEMPLATE_NOT_FOUND"))?;
            let revision = current.get("revision").and_then(Value::as_i64).unwrap_or(0);
            if revision != expected_revision {
                return Err(AthriaError::new(AthriaErrorCode::RevisionConflict, "REVISION_CONFLICT"));
            }
            let data = template_data(template)?;
            self.connection
                .execute(
                    "UPDATE session_templates SET data = ?1, revision = ?2, updated_at = ?3 WHERE id = ?4 AND owner_id = ?5",
                    params![data.to_string(), revision + 1, self.now(), id, owner_id],
                )
                .map_err(database_error)?;
            stored_template(&id, &data, revision + 1)
        })
    }

    /// Deletes a user template after the same optimistic revision check as
    /// `AthriaRepository.deleteTemplate`.
    pub fn delete_template(&self, id: &str, expected_revision: i64, owner_id: &str) -> Result<()> {
        let current = self
            .get_template(id, owner_id)?
            .ok_or_else(|| AthriaError::new(AthriaErrorCode::TemplateNotFound, "TEMPLATE_NOT_FOUND"))?;
        if current.get("revision").and_then(Value::as_i64).unwrap_or(0) != expected_revision {
            return Err(AthriaError::new(AthriaErrorCode::RevisionConflict, "REVISION_CONFLICT"));
        }
        self.connection
            .execute("DELETE FROM session_templates WHERE id = ?1 AND owner_id = ?2", params![id, owner_id])
            .map_err(database_error)?;
        Ok(())
    }

    /// `SELECT template_id FROM template_dismissals WHERE owner_id = ?`, in
    /// insertion order like `AthriaRepository.listDismissedTemplateIds`.
    pub fn list_dismissed_template_ids(&self, owner_id: &str) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT template_id FROM template_dismissals WHERE owner_id = ?1")
            .map_err(database_error)?;
        let rows = statement.query_map(params![owner_id], |row| row.get::<_, String>(0)).map_err(database_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(database_error)
    }

    pub fn dismiss_template(&self, id: &str, owner_id: &str) -> Result<()> {
        self.connection
            .execute(
                "INSERT INTO template_dismissals(owner_id, template_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
                params![owner_id, id, self.now()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn get_current_plan(&self, owner_id: &str) -> Result<Option<Value>> {
        let data: Option<String> = self
            .connection
            .query_row("SELECT data FROM current_mesocycles WHERE owner_id = ?1", params![owner_id], |row| row.get(0))
            .optional()
            .map_err(database_error)?;
        data.map(|value| parse_json_column(&value)).transpose()
    }

    /// Upserts the plan after an optimistic revision check, mirroring
    /// `AthriaRepository.saveCurrentPlan`. The stored `revision` column and
    /// `updated_at` are taken from the plan JSON, not from `expected_revision`.
    /// Plan matches are reconciled after the write commits, like TypeScript.
    pub fn save_current_plan(&self, plan: &Value, expected_revision: i64) -> Result<Value> {
        let owner_id = owner_of(plan);
        let saved = self.transaction(&mut || {
            let current_revision = self
                .get_current_plan(owner_id)?
                .as_ref()
                .and_then(|current| current.get("revision"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if current_revision != expected_revision {
                return Err(AthriaError::new(AthriaErrorCode::RevisionConflict, "REVISION_CONFLICT"));
            }
            let revision = plan.get("revision").and_then(Value::as_i64).ok_or_else(|| missing_field("revision"))?;
            let updated_at = plan.get("updatedAt").and_then(Value::as_str).ok_or_else(|| missing_field("updatedAt"))?;
            self.connection
                .execute(
                    "INSERT INTO current_mesocycles(owner_id, data, revision, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, revision = excluded.revision, updated_at = excluded.updated_at",
                    params![owner_id, plan.to_string(), revision, updated_at],
                )
                .map_err(database_error)?;
            Ok(plan.clone())
        })?;
        self.reconcile_plan_matches(owner_id)?;
        Ok(saved)
    }

    pub fn get_connection_sync_state(&self, source: &str, owner_id: &str) -> Result<Option<Value>> {
        let row = self
            .connection
            .query_row(
                "SELECT owner_id, source, last_attempt_at, last_success_at, range_start, range_end, status, data FROM connection_sync_state WHERE owner_id = ?1 AND source = ?2",
                params![owner_id, source],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        row.map(|(owner_id, source, last_attempt_at, last_success_at, range_start, range_end, status, data)| {
            Ok(json!({
                "ownerId": owner_id,
                "source": source,
                "lastAttemptAt": last_attempt_at,
                "lastSuccessAt": last_success_at,
                "rangeStart": range_start,
                "rangeEnd": range_end,
                "status": status,
                "data": parse_json_column(&data)?,
            }))
        })
        .transpose()
    }

    pub fn save_connection_sync_state(&self, state: &Value) -> Result<Value> {
        let source = state.get("source").and_then(Value::as_str).ok_or_else(|| missing_field("source"))?;
        let owner_id = owner_of(state);
        let last_attempt_at = state.get("lastAttemptAt").and_then(Value::as_str).ok_or_else(|| missing_field("lastAttemptAt"))?;
        let last_success_at = state.get("lastSuccessAt").and_then(Value::as_str);
        let range_start = state.get("rangeStart").and_then(Value::as_str).ok_or_else(|| missing_field("rangeStart"))?;
        let range_end = state.get("rangeEnd").and_then(Value::as_str).ok_or_else(|| missing_field("rangeEnd"))?;
        let status = state.get("status").and_then(Value::as_str).ok_or_else(|| missing_field("status"))?;
        let data = state.get("data").cloned().unwrap_or_else(|| json!({}));
        self.connection
            .execute(
                "INSERT INTO connection_sync_state(owner_id, source, last_attempt_at, last_success_at, range_start, range_end, status, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(owner_id, source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, range_start = excluded.range_start, range_end = excluded.range_end, status = excluded.status, data = excluded.data",
                params![owner_id, source, last_attempt_at, last_success_at, range_start, range_end, status, data.to_string()],
            )
            .map_err(database_error)?;
        self.get_connection_sync_state(source, owner_id)?.ok_or_else(|| AthriaError::new(AthriaErrorCode::InvalidData, "sync state row missing after write"))
    }

    /// Idempotent import batch insert keyed by
    /// `(owner, source, contentHash)`, mirroring
    /// `AthriaRepository.recordImportBatch`.
    pub fn record_import_batch(&self, input: &RecordImportBatchInput<'_>) -> Result<Value> {
        if let Some(existing) = self.find_import_batch(input.owner_id, input.source, input.content_hash)? {
            return Ok(existing);
        }
        let id = Uuid::new_v4().to_string();
        let created_at = self.now();
        self.connection
            .execute(
                "INSERT INTO import_batches(id, owner_id, source, content_hash, file_name, parser_version, status, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, input.owner_id, input.source, input.content_hash, input.file_name, input.parser_version, input.status, input.data.to_string(), created_at],
            )
            .map_err(database_error)?;
        Ok(json!({
            "id": id,
            "ownerId": input.owner_id,
            "source": input.source,
            "contentHash": input.content_hash,
            "fileName": input.file_name,
            "parserVersion": input.parser_version,
            "status": input.status,
            "data": input.data,
            "createdAt": created_at,
        }))
    }

    fn find_import_batch(&self, owner_id: &str, source: &str, content_hash: &str) -> Result<Option<Value>> {
        let row = self
            .connection
            .query_row(
                "SELECT id, owner_id, source, content_hash, file_name, parser_version, status, data, created_at FROM import_batches WHERE owner_id = ?1 AND source = ?2 AND content_hash = ?3",
                params![owner_id, source, content_hash],
                import_batch_columns,
            )
            .optional()
            .map_err(database_error)?;
        row.map(import_batch_value).transpose()
    }

    pub fn latest_import_batch(&self, owner_id: &str, source: &str) -> Result<Option<Value>> {
        let row = self
            .connection
            .query_row(
                "SELECT id, owner_id, source, content_hash, file_name, parser_version, status, data, created_at FROM import_batches WHERE owner_id = ?1 AND source = ?2 ORDER BY created_at DESC LIMIT 1",
                params![owner_id, source],
                import_batch_columns,
            )
            .optional()
            .map_err(database_error)?;
        row.map(import_batch_value).transpose()
    }

    /// Row counts for `AthriaRepository.counts()`; also used by the CLI and
    /// service doctor endpoints.
    pub fn counts(&self) -> Result<Value> {
        const NAMES: [&str; 13] = [
            "profiles",
            "training_sessions",
            "training_session_sources",
            "training_session_type_overrides",
            "plan_workout_matches",
            "workout_plan_exclusions",
            "planned_session_events",
            "wellness",
            "import_batches",
            "connection_sync_state",
            "session_templates",
            "template_dismissals",
            "current_mesocycles",
        ];
        let mut counts = Map::new();
        for name in NAMES {
            let count: i64 = self
                .connection
                .query_row(&format!("SELECT COUNT(*) AS count FROM {name}"), [], |row| row.get(0))
                .map_err(database_error)?;
            counts.insert(name.to_string(), Value::Number(count.into()));
        }
        Ok(Value::Object(counts))
    }

    /// Read-only vault metadata. Never touches key material: the envelope is
    /// only reported as present or absent and secrets are only counted.
    pub fn vault_metadata(&self) -> Result<Value> {
        let row = self
            .connection
            .query_row(
                "SELECT database_uuid, format_version, (wrapped_master_key IS NOT NULL), (SELECT COUNT(*) FROM connection_secrets) FROM vault_meta WHERE id = 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, bool>(2)?, row.get::<_, i64>(3)?)),
            )
            .optional()
            .map_err(database_error)?;
        let (database_uuid, format_version, envelope_present, secret_count) = row
            .ok_or_else(|| AthriaError::new(AthriaErrorCode::InvalidData, "vault_meta row is missing"))?;
        Ok(json!({
            "databaseUuid": database_uuid,
            "formatVersion": format_version,
            "envelopePresent": envelope_present,
            "secretCount": secret_count,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Advances one minute per `now()` call so `ORDER BY created_at DESC`
    /// tie-breaks never depend on row insertion order.
    #[derive(Debug)]
    struct TickingClock {
        current: Cell<i64>,
    }

    impl TickingClock {
        fn new(anchor_millis: i64) -> Self {
            Self { current: Cell::new(anchor_millis) }
        }
    }

    impl Clock for TickingClock {
        fn now_iso(&self) -> String {
            let value = crate::tz::iso_from_millis(self.current.get());
            self.current.set(self.current.get() + 60_000);
            value
        }
    }

    #[test]
    fn bootstraps_a_fresh_database_at_the_supported_schema_version() {
        let store = SqliteStore::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), SUPPORTED_SCHEMA_VERSION);
        assert!(store.get_profile(DEFAULT_OWNER_ID).unwrap().is_none());
        assert!(store.get_current_plan(DEFAULT_OWNER_ID).unwrap().is_none());
        assert!(store.list_templates(DEFAULT_OWNER_ID).unwrap().is_empty());
        assert!(store.list_training_sessions(DEFAULT_OWNER_ID).unwrap().is_empty());
        let vault = store.vault_metadata().unwrap();
        assert_eq!(vault["formatVersion"], json!(1));
        assert_eq!(vault["envelopePresent"], json!(false));
        assert_eq!(vault["secretCount"], json!(0));
        assert!(vault["databaseUuid"].as_str().is_some_and(|uuid| !uuid.is_empty()));
    }

    #[test]
    fn reopens_an_existing_database_without_migrating_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("athria.sqlite3");
        let uuid = {
            let store = SqliteStore::open(&path).unwrap();
            store.vault_metadata().unwrap()["databaseUuid"].clone()
        };
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SUPPORTED_SCHEMA_VERSION);
        assert_eq!(store.vault_metadata().unwrap()["databaseUuid"], uuid);
        let migrations: i64 = store.connection.query_row("SELECT COUNT(*) FROM athria_migrations", [], |row| row.get(0)).unwrap();
        assert_eq!(migrations, SUPPORTED_SCHEMA_VERSION);
    }

    #[test]
    fn rejects_databases_from_unsupported_schema_versions() {
        let directory = tempfile::tempdir().unwrap();

        let older = directory.path().join("older.sqlite3");
        {
            let store = SqliteStore::open(&older).unwrap();
            store.connection.execute("DELETE FROM athria_migrations WHERE version >= 24", []).unwrap();
        }
        assert_eq!(SqliteStore::open(&older).unwrap_err().code(), AthriaErrorCode::SchemaVersionUnsupported);

        let newer = directory.path().join("newer.sqlite3");
        {
            let store = SqliteStore::open(&newer).unwrap();
            store.connection.execute("INSERT INTO athria_migrations(version, applied_at) VALUES (25, CURRENT_TIMESTAMP)", []).unwrap();
        }
        assert_eq!(SqliteStore::open(&newer).unwrap_err().code(), AthriaErrorCode::SchemaVersionUnsupported);

        let foreign = directory.path().join("foreign.sqlite3");
        {
            let connection = Connection::open(&foreign).unwrap();
            connection.execute_batch("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);").unwrap();
        }
        assert_eq!(SqliteStore::open(&foreign).unwrap_err().code(), AthriaErrorCode::SchemaVersionUnsupported);
    }

    #[test]
    fn template_writes_follow_the_typescript_revision_rules() {
        let store = SqliteStore::open_in_memory().unwrap();
        let template = json!({ "id": "t1", "name": "Tempo Run", "intent": "Aerobic base", "domain": "endurance", "nodes": [] });
        let created = store.create_template(&template, DEFAULT_OWNER_ID).unwrap();
        assert_eq!(created["id"], json!("t1"));
        assert_eq!(created["origin"], json!("user"));
        assert_eq!(created["revision"], json!(1));
        assert_eq!(created["name"], json!("Tempo Run"));

        let stored: String = store.connection.query_row("SELECT data FROM session_templates WHERE id = 't1'", [], |row| row.get(0)).unwrap();
        assert!(parse_json_column(&stored).unwrap().get("id").is_none(), "stored template data must not repeat the id column");

        assert_eq!(store.create_template(&template, DEFAULT_OWNER_ID).unwrap_err().code(), AthriaErrorCode::TemplateAlreadyExists);

        let mut renamed = template.clone();
        renamed["name"] = json!("Tempo Run v2");
        let updated = store.update_template(&renamed, 1, DEFAULT_OWNER_ID).unwrap();
        assert_eq!(updated["name"], json!("Tempo Run v2"));
        assert_eq!(updated["revision"], json!(2));
        assert_eq!(store.get_template("t1", DEFAULT_OWNER_ID).unwrap().unwrap()["revision"], json!(2));

        assert_eq!(store.update_template(&renamed, 1, DEFAULT_OWNER_ID).unwrap_err().code(), AthriaErrorCode::RevisionConflict);
        assert_eq!(store.update_template(&renamed, 2, "other-owner").unwrap_err().code(), AthriaErrorCode::TemplateNotFound);
    }

    #[test]
    fn plan_writes_follow_the_typescript_optimistic_revision_rules() {
        let store = SqliteStore::open_in_memory().unwrap();
        let plan = json!({ "ownerId": DEFAULT_OWNER_ID, "revision": 1, "updatedAt": "2026-09-02T00:00:00Z", "mesocycle": { "weeks": [] } });
        store.save_current_plan(&plan, 0).unwrap();
        assert_eq!(store.get_current_plan(DEFAULT_OWNER_ID).unwrap().unwrap()["revision"], json!(1));

        let mut next = plan.clone();
        next["revision"] = json!(2);
        next["updatedAt"] = json!("2026-09-03T00:00:00Z");
        store.save_current_plan(&next, 1).unwrap();
        let stored = store.get_current_plan(DEFAULT_OWNER_ID).unwrap().unwrap();
        assert_eq!(stored["revision"], json!(2));
        assert_eq!(stored["updatedAt"], json!("2026-09-03T00:00:00Z"));
        assert_eq!(store.save_current_plan(&next, 1).unwrap_err().code(), AthriaErrorCode::RevisionConflict);
    }

    #[test]
    fn wellness_and_profile_round_trip_through_the_typescript_shapes() {
        let store = SqliteStore::open_in_memory().unwrap();
        let profile = json!({ "ownerId": DEFAULT_OWNER_ID, "preferredName": "Athlete", "heightCm": 178.5 });
        store.save_profile(&profile).unwrap();
        assert_eq!(store.get_profile(DEFAULT_OWNER_ID).unwrap().unwrap()["heightCm"], json!(178.5));

        let record = json!({
            "ownerId": DEFAULT_OWNER_ID, "day": "2026-09-10",
            "fields": { "restingHeartRateBpm": { "value": 52, "source": "user", "updatedAt": "2026-09-10T06:00:00Z" } },
            "updatedAt": "2026-09-10T06:00:00Z",
        });
        store.save_wellness(&record).unwrap();
        assert_eq!(store.get_wellness(DEFAULT_OWNER_ID, "2026-09-10").unwrap().unwrap()["fields"]["restingHeartRateBpm"]["value"], json!(52));
        assert_eq!(store.list_wellness(DEFAULT_OWNER_ID, Some("2026-09-11")).unwrap().len(), 0);
        assert_eq!(store.list_wellness(DEFAULT_OWNER_ID, Some("2026-09-10")).unwrap().len(), 1);
        assert_eq!(store.list_wellness(DEFAULT_OWNER_ID, None).unwrap().len(), 1);

        let state = json!({
            "ownerId": DEFAULT_OWNER_ID, "source": "intervals_icu", "lastAttemptAt": "2026-09-15T06:00:00Z", "lastSuccessAt": null,
            "rangeStart": "2026-08-01", "rangeEnd": "2026-09-15", "status": "success", "data": { "workouts": 12 },
        });
        let saved = store.save_connection_sync_state(&state).unwrap();
        assert_eq!(saved["lastSuccessAt"], json!(null));
        assert_eq!(saved["data"], json!({ "workouts": 12 }));
        let updated = json!({ "ownerId": DEFAULT_OWNER_ID, "source": "intervals_icu", "lastAttemptAt": "2026-09-16T06:00:00Z", "lastSuccessAt": "2026-09-15T06:00:00Z", "rangeStart": "2026-08-01", "rangeEnd": "2026-09-16", "status": "partial", "data": { "workouts": 13 } });
        store.save_connection_sync_state(&updated).unwrap();
        assert_eq!(store.get_connection_sync_state("intervals_icu", DEFAULT_OWNER_ID).unwrap().unwrap()["status"], json!("partial"));
    }

    #[test]
    fn wellness_imports_map_intervals_fields_and_keep_other_sources() {
        let store = SqliteStore::open_in_memory_with_clock(Rc::new(crate::clock::FixedClock::new("2026-09-17T04:00:00.000Z"))).unwrap();
        let stored = store
            .upsert_wellness(
                DEFAULT_OWNER_ID,
                &[json!({
                    "id": "2026-09-10",
                    "restingHR": 52, "hrv": 64.2, "sleepSecs": 28800, "weight": 78.5, "steps": 8000,
                    "sportInfo": [{ "type": "Ride", "eftp": 250, "wPrime": 20000, "pMax": 900 }],
                })],
            )
            .unwrap();
        assert_eq!(stored, 1);

        let record = store.get_wellness(DEFAULT_OWNER_ID, "2026-09-10").unwrap().unwrap();
        assert_eq!(record["ownerId"], json!(DEFAULT_OWNER_ID));
        assert_eq!(record["day"], json!("2026-09-10"));
        assert_eq!(record["updatedAt"], json!("2026-09-17T04:00:00.000Z"));
        let fields: Vec<&String> = record["fields"].as_object().unwrap().keys().collect();
        assert_eq!(
            fields,
            ["restingHeartRateBpm", "hrvRmssdMs", "sleepSeconds", "weightKg", "stepsCount", "eftpWatts", "wPrimeJoules", "pMaxWatts"]
        );
        assert_eq!(record["fields"]["restingHeartRateBpm"], json!({ "value": 52, "source": "intervals_icu", "updatedAt": "2026-09-17T04:00:00.000Z" }));
        assert_eq!(record["fields"]["weightKg"]["value"], json!(78.5));
        assert_eq!(record["fields"]["stepsCount"]["value"], json!(8000));
        assert_eq!(record["fields"]["eftpWatts"]["value"], json!(250));
        assert_eq!(record["fields"]["pMaxWatts"]["value"], json!(900));

        store
            .save_wellness(&json!({
                "ownerId": DEFAULT_OWNER_ID, "day": "2026-09-10",
                "fields": { "weightKg": { "value": 80, "source": "user", "updatedAt": "2026-09-10T06:00:00.000Z" } },
                "updatedAt": "2026-09-10T06:00:00.000Z",
            }))
            .unwrap();
        assert_eq!(store.upsert_wellness(DEFAULT_OWNER_ID, &[json!({ "date": "2026-09-10", "weight": 78.5, "restingHR": 50 })]).unwrap(), 1);
        let record = store.get_wellness(DEFAULT_OWNER_ID, "2026-09-10").unwrap().unwrap();
        assert_eq!(record["fields"]["weightKg"], json!({ "value": 80, "source": "user", "updatedAt": "2026-09-10T06:00:00.000Z" }));
        assert_eq!(record["fields"]["restingHeartRateBpm"]["value"], json!(50));

        assert_eq!(store.upsert_wellness(DEFAULT_OWNER_ID, &[json!({ "date": "2026/09/11", "restingHR": 50 }), json!("nope")]).unwrap(), 0);
    }

    #[test]
    fn import_batches_are_idempotent_per_content_hash() {
        // 2026-09-17T04:00:00.000Z, ticking forward one minute per call.
        let store = SqliteStore::open_in_memory_with_clock(Rc::new(TickingClock::new(1_789_617_600_000))).unwrap();
        let data = json!({ "workouts": 3 });
        let mut input = RecordImportBatchInput {
            owner_id: DEFAULT_OWNER_ID,
            source: "hevy",
            content_hash: "hash-1",
            file_name: "hevy.csv",
            parser_version: "1.0.0",
            status: "completed",
            data: &data,
        };
        let first = store.record_import_batch(&input).unwrap();
        assert_eq!(first["createdAt"], json!("2026-09-17T04:00:00.000Z"));
        assert_eq!(first["data"], json!({ "workouts": 3 }));
        assert!(first["id"].as_str().is_some_and(|id| Uuid::parse_str(id).is_ok()));
        assert_eq!(store.record_import_batch(&input).unwrap(), first);

        input.content_hash = "hash-2";
        store.record_import_batch(&input).unwrap();
        assert_eq!(store.latest_import_batch(DEFAULT_OWNER_ID, "hevy").unwrap().unwrap()["contentHash"], json!("hash-2"));
        assert!(store.latest_import_batch(DEFAULT_OWNER_ID, "intervals_icu").unwrap().is_none());
        assert_eq!(store.counts().unwrap()["import_batches"], json!(2));
    }

    #[test]
    fn template_dismissals_and_delete_follow_the_typescript_rules() {
        let store = SqliteStore::open_in_memory().unwrap();
        let template = json!({ "id": "t1", "name": "Tempo Run", "intent": "Aerobic base", "domain": "endurance", "nodes": [] });
        store.create_template(&template, DEFAULT_OWNER_ID).unwrap();
        assert_eq!(store.list_dismissed_template_ids(DEFAULT_OWNER_ID).unwrap(), Vec::<String>::new());
        store.dismiss_template("t1", DEFAULT_OWNER_ID).unwrap();
        store.dismiss_template("t1", DEFAULT_OWNER_ID).unwrap();
        assert_eq!(store.list_dismissed_template_ids(DEFAULT_OWNER_ID).unwrap(), vec!["t1".to_string()]);

        let mut second = template.clone();
        second["id"] = json!("t2");
        store.create_template(&second, DEFAULT_OWNER_ID).unwrap();
        assert_eq!(store.delete_template("t2", 0, DEFAULT_OWNER_ID).unwrap_err().code(), AthriaErrorCode::RevisionConflict);

        store.delete_template("t1", 1, DEFAULT_OWNER_ID).unwrap();
        assert!(store.get_template("t1", DEFAULT_OWNER_ID).unwrap().is_none());
        assert_eq!(store.delete_template("t1", 1, DEFAULT_OWNER_ID).unwrap_err().code(), AthriaErrorCode::TemplateNotFound);

        let counts = store.counts().unwrap();
        assert_eq!(counts["session_templates"], json!(1));
        assert_eq!(counts["template_dismissals"], json!(1));
        assert_eq!(counts["training_sessions"], json!(0));
    }
}
