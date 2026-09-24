//! `AthriaApplication`: the validated use cases every shell calls.
//!
//! Each method implements an application API operation over the store.
//! TypeScript counterpart: the same schema parse of raw input, the same
//! optimistic-concurrency checks, the same store calls in the same order, and
//! the same response documents.
//!
//! The schema normalizers in `athria_core::schema` reproduce the Zod *parse
//! output* — defaults applied, fields in schema declaration order, unknown keys
//! rejected, value types checked. Zod range refinements on *document* schemas
//! (`min`/`max` bounds, the birth-date "not in the future" check) are
//! transport-level validation and land with the Tauri/CLI/MCP input schemas in
//! Phase 7.
//!
//! Action schemas validate inputs at the application boundary — the
//! `confirmed` literals, `expectedRevision`, the `dateSchema` transport
//! strings, the manual-update duration range and "at least one field" check —
//! are ported here; a violation raises `INVALID_DATA`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::RangeInclusive;
use std::sync::Arc;

use athria_core::date::{add_days, day_difference, monday_weekday};
use athria_core::schema::{
    PersonalInformationWrite, merge_profile, parse_current_plan, parse_current_plan_write,
    parse_next_training_day_write, parse_personal_information, parse_plan_week,
    parse_planned_session, parse_planned_session_action, parse_profile, parse_profile_update,
    parse_session_template_create, parse_session_template_update, parse_training_session,
    parse_wellness_patch, parse_wellness_record, template_variables,
};
use athria_core::vocab::{
    DOMAIN_IDS, FACT_SOURCES, equipment_categories, equipment_type_ids, movement_pattern_taxonomy,
    muscle_taxonomy,
};
use athria_core::{
    AI_HARD_CONFIDENCE, AthriaError, AthriaErrorCode, Clock, DEFAULT_OWNER_ID, PlanValidation,
    Result, SystemClock, TAXONOMY_VERSION, calculate_training_metrics, js_locale_compare,
    stable_hash, tz, validate_plan,
};
use athria_integrations::{
    HEVY_PARSER_VERSION, XUNJI_PARSER_VERSION, normalize_intervals_activity,
    normalize_xunji_training, parse_hevy_csv,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::catalog::{builtin_session_templates, builtin_template};
use crate::store::{
    AthriaStore, RecordImportBatchInput, ReplaceSourceSessionsInput,
    SaveCurrentPlannedSessionsInput, UpdateCurrentPlannedSessionsInput,
};
use crate::{PLAN_SCHEMA_VERSION, TEMPLATE_CATALOG_VERSION};

/// A schema-guaranteed string field; missing fields are programming errors,
/// matching the TypeScript `undefined` dereference.
fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected `{key}` to be a string"))
}

/// `new AthriaError(code, message, status)`.
fn failure(code: AthriaErrorCode, message: &str, status: u16) -> AthriaError {
    AthriaError::new(code, message).with_status(status)
}

/// The `TEMPLATE_NOT_FOUND` / `REVISION_CONFLICT` store failures as the
/// application responses, re-throwing anything else untouched.
fn template_write_error(error: AthriaError) -> AthriaError {
    match error.code() {
        AthriaErrorCode::RevisionConflict => failure(
            AthriaErrorCode::RevisionConflict,
            "The template changed. Refresh and try again.",
            409,
        ),
        AthriaErrorCode::TemplateNotFound => failure(
            AthriaErrorCode::TemplateNotFound,
            "The session template was not found.",
            404,
        ),
        _ => error,
    }
}

/// An action-schema violation; the transports own the user-facing ZodError text.
fn invalid_input(message: &str) -> AthriaError {
    AthriaError::new(AthriaErrorCode::InvalidData, message.to_owned())
}

/// The `z.object(...).strict().parse(value)` object input.
fn object_input<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid_input(&format!("{path}: expected an object")))
}

/// `confirmed: z.literal(true)`.
fn require_confirmed(value: &Value, path: &str) -> Result<()> {
    if value.get("confirmed") == Some(&Value::Bool(true)) {
        Ok(())
    } else {
        Err(invalid_input(&format!("{path}.confirmed: expected true")))
    }
}

/// `z.string().min(1).optional()`: absence parses as `None`, `null` is rejected.
fn optional_text(value: &Value, key: &str, path: &str) -> Result<Option<String>> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
        _ => Err(invalid_input(&format!(
            "{path}.{key}: expected a non-empty string"
        ))),
    }
}

/// `z.string().min(1).nullable()`: `null` parses as `None`, absence is rejected.
fn nullable_text(value: &Value, key: &str, path: &str) -> Result<Option<String>> {
    match value.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
        _ => Err(invalid_input(&format!(
            "{path}.{key}: expected a non-empty string or null"
        ))),
    }
}

/// `z.number().int()` within an inclusive range; like `Number.isInteger`, an
/// integral float such as `4.0` is accepted.
fn input_int(value: &Value, key: &str, path: &str, range: RangeInclusive<i64>) -> Result<i64> {
    let parsed = value.get(key).and_then(|entry| {
        entry.as_i64().or_else(|| {
            entry
                .as_f64()
                .filter(|number| number.fract() == 0.0)
                .map(|number| number as i64)
        })
    });
    match parsed.filter(|number| range.contains(number)) {
        Some(number) => Ok(number),
        None => Err(invalid_input(&format!(
            "{path}.{key}: expected an integer in {}..={}",
            range.start(),
            range.end()
        ))),
    }
}

/// `dateSchema.parse(value)` on a transport string.
fn parse_date_input(value: &str, path: &str) -> Result<String> {
    if athria_core::date::is_iso_date(value) {
        Ok(value.to_owned())
    } else {
        Err(invalid_input(&format!(
            "{path}: expected a YYYY-MM-DD date"
        )))
    }
}

/// `sessionDomains`: the stored domains, or the ones implied by the payload.
fn session_domains(session: &Value) -> Vec<Value> {
    let domains = session
        .get("domains")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !domains.is_empty() {
        return domains;
    }
    let mut derived = Vec::new();
    if session
        .get("strengthSets")
        .and_then(Value::as_array)
        .is_some_and(|sets| !sets.is_empty())
    {
        derived.push(Value::String("strength".into()));
    }
    if session
        .get("endurance")
        .is_some_and(|endurance| !endurance.is_null())
    {
        derived.push(Value::String("endurance".into()));
    }
    derived
}

/// `listSessions` mapping: fill in the derived domains and, when nothing could
/// be derived, record `domains` as a missing field.
fn with_session_domains(session: &Value) -> Value {
    let mut updated = session.as_object().cloned().unwrap_or_default();
    let domains = session_domains(session);
    let empty = domains.is_empty();
    updated.insert("domains".into(), Value::Array(domains));
    if empty {
        let mut missing = updated
            .get("missingFields")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !missing.iter().any(|field| field == "domains") {
            missing.push(Value::String("domains".into()));
        }
        updated.insert("missingFields".into(), Value::Array(missing));
    }
    Value::Object(updated)
}

/// `localDate(new Date(session.startAt), session.timezone ?? profile.timezone)`.
fn session_local_day(session: &Value, profile_timezone: &str) -> Result<String> {
    let timezone = session
        .get("timezone")
        .and_then(Value::as_str)
        .unwrap_or(profile_timezone);
    tz::local_date(string_field(session, "startAt"), timezone)
}

/// The ids of every session in `plan` that references the user template `id`.
fn template_references(plan: &Value, id: &str) -> Vec<Value> {
    let mut references = Vec::new();
    for week in plan["mesocycle"]["weeks"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        for session in week["sessions"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            if session["templateRef"]["source"] == json!("user")
                && session["templateRef"]["id"] == json!(id)
            {
                references.push(session["id"].clone());
            }
        }
    }
    references
}

/// The `{ mesocycle, effectiveStartDate }` document `validatePlan` receives.
fn plan_validation_draft(plan: &Value) -> Value {
    json!({ "mesocycle": plan["mesocycle"], "effectiveStartDate": plan["effectiveStartDate"] })
}

/// `phaseRefsForSession`: one reference per distinct resolved component domain,
/// resolved through the plan's domain progressions and the week's phase.
fn phase_refs_for_session(plan: &Value, week_number: i64, components: &Value) -> Result<Value> {
    let mut domains: Vec<&str> = Vec::new();
    for component in components.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(domain) = component["domain"]["value"].as_str() {
            if !domains.contains(&domain) {
                domains.push(domain);
            }
        }
    }
    let progressions = plan["mesocycle"]["domainProgressions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut refs = Vec::with_capacity(domains.len());
    for domain in domains {
        let progression = progressions
            .iter()
            .find(|item| item["domain"].as_str() == Some(domain))
            .ok_or_else(|| {
                AthriaError::new(
                    AthriaErrorCode::InvalidData,
                    format!("plan is missing the `{domain}` domain progression"),
                )
            })?;
        let phase = progression["phases"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .find(|phase| {
                week_number >= phase["startWeek"].as_i64().unwrap_or(0)
                    && week_number <= phase["endWeek"].as_i64().unwrap_or(0)
            })
            .ok_or_else(|| {
                AthriaError::new(
                    AthriaErrorCode::InvalidData,
                    format!("plan is missing a `{domain}` phase covering week {week_number}"),
                )
            })?;
        refs.push(json!({ "domain": domain, "phaseId": phase["id"] }));
    }
    Ok(Value::Array(refs))
}

/// `plannedDatesFollowProfile`: whether a proposed set of occurrences still
/// satisfies the Profile training rhythm.
fn planned_dates_follow_profile(profile: &Value, plan: &Value, sessions: &[Value]) -> bool {
    let mut dates: Vec<&str> = sessions
        .iter()
        .filter_map(|session| session["scheduledDate"].as_str())
        .collect();
    dates.sort_unstable();
    dates.dedup();
    let rhythm = &profile["trainingRhythm"];
    let duration_weeks = plan["mesocycle"]["durationWeeks"].as_i64().unwrap_or(0);
    let week_dates = |week_number: i64| -> Vec<&str> {
        let mut found: Vec<&str> = sessions
            .iter()
            .filter(|session| session["weekNumber"].as_i64() == Some(week_number))
            .filter_map(|session| session["scheduledDate"].as_str())
            .collect();
        found.sort_unstable();
        found.dedup();
        found
    };
    match rhythm["kind"].as_str().unwrap_or("") {
        "fixed_week" => {
            let mut days: Vec<u32> = rhythm["days"]
                .as_array()
                .map(|days| {
                    days.iter()
                        .filter_map(Value::as_u64)
                        .map(|day| day as u32)
                        .collect()
                })
                .unwrap_or_default();
            days.sort_unstable();
            let expected = days
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",");
            (1..=duration_weeks).all(|week_number| {
                let mut weekdays: Vec<u32> = week_dates(week_number)
                    .iter()
                    .map(|date| monday_weekday(date))
                    .collect();
                weekdays.sort_unstable();
                weekdays.dedup();
                weekdays
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
                    == expected
            })
        }
        "flexible_week" => {
            let min_days = rhythm["minDaysPerWeek"].as_i64().unwrap_or(0);
            let max_days = rhythm["maxDaysPerWeek"].as_i64().unwrap_or(0);
            (1..=duration_weeks).all(|week_number| {
                let count = week_dates(week_number).len() as i64;
                count >= min_days && count <= max_days
            })
        }
        _ => {
            let interval_days = rhythm["intervalDays"].as_i64().unwrap_or(0);
            dates.first().copied() == plan["effectiveStartDate"].as_str()
                && dates.iter().enumerate().all(|(index, date)| {
                    index == 0 || day_difference(dates[index - 1], date) == interval_days
                })
        }
    }
}

/// `blockerFailureMessage(validation)`: the plan-save error summary.
fn blocker_failure_message(validation: &PlanValidation) -> String {
    let failed: Vec<&Value> = validation
        .results
        .iter()
        .filter(|item| {
            item["enforcement"] == json!("blocker")
                && matches!(item["status"].as_str(), Some("fail" | "unknown"))
        })
        .collect();
    let mut reasons: Vec<String> = Vec::new();
    for item in &failed {
        let reason = format!(
            "{}:{}",
            item["reasonCode"].as_str().unwrap_or(""),
            item["status"].as_str().unwrap_or("")
        );
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
    }
    reasons.truncate(5);
    let suffix = if reasons.is_empty() {
        String::new()
    } else {
        format!(" ({})", reasons.join(", "))
    };
    format!(
        "Plan has {} blocking issue(s){suffix}. Validate the complete plan draft for the full report.",
        failed.len()
    )
}

fn blocker_summary(validation: &PlanValidation) -> Value {
    json!({
        "valid": validation.valid,
        "blockers": validation.results.iter().filter(|item| item["enforcement"] == "blocker" && matches!(item["status"].as_str(), Some("fail" | "unknown"))).count(),
        "advisories": validation.results.iter().filter(|item| item["enforcement"] == "advisory").count(),
        "blockingDataGaps": validation.data_gaps.iter().filter(|item| item["blocking"] == true).count(),
    })
}

/// `{ ...session, status, updatedAt }` for the skip/restore occurrences.
fn session_with_status(session: &Value, status: &str, updated_at: &str) -> Value {
    let mut updated = session.as_object().cloned().unwrap_or_default();
    updated.insert("status".into(), Value::String(status.to_owned()));
    updated.insert("updatedAt".into(), Value::String(updated_at.to_owned()));
    Value::Object(updated)
}

pub struct AthriaApplication<S: AthriaStore> {
    store: S,
    owner_id: String,
    clock: Arc<dyn Clock>,
    integration_previews: RefCell<HashMap<String, Value>>,
}

impl<S: AthriaStore> AthriaApplication<S> {
    /// `new AthriaApplication(store)`: the local owner and the system clock.
    pub fn new(store: S) -> Self {
        Self::with_clock(store, DEFAULT_OWNER_ID, Arc::new(SystemClock))
    }

    /// The TypeScript constructor with an explicit `ownerId` and `now`.
    pub fn with_clock(store: S, owner_id: impl Into<String>, clock: Arc<dyn Clock>) -> Self {
        Self {
            store,
            owner_id: owner_id.into(),
            clock,
            integration_previews: RefCell::new(HashMap::new()),
        }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }

    fn now_iso(&self) -> String {
        self.clock.now_iso()
    }

    pub fn get_profile(&self) -> Result<Value> {
        self.store.get_profile(&self.owner_id)
    }

    pub fn save_profile(&self, value: &Value) -> Result<Value> {
        let profile = parse_profile(value)?;
        self.store.save_profile(&profile)
    }

    pub fn profile_hash(&self) -> Result<String> {
        self.get_profile().map(|profile| stable_hash(&profile))
    }

    pub fn update_profile(&self, value: &Value) -> Result<Value> {
        let update = parse_profile_update(value)?;
        if update.expected_profile_hash != self.profile_hash()? {
            return Err(failure(
                AthriaErrorCode::InputSnapshotChanged,
                "The athlete profile changed. Refresh before applying the confirmed update.",
                409,
            ));
        }
        let merged = merge_profile(&self.get_profile()?, &update.patch, &self.owner_id)?;
        self.store.save_profile(&merged)
    }

    pub fn get_personal_information(&self) -> Result<Value> {
        let profile = self.get_profile()?;
        let today = tz::local_date(&self.now_iso(), string_field(&profile, "timezone"))?;
        let wellness = self.store.list_wellness(&self.owner_id, None)?;
        let latest_weight = wellness
            .iter()
            .find(|record| !record["fields"]["weightKg"]["value"].is_null());
        let weight = match latest_weight {
            Some(record) => {
                json!({ "weightKg": record["fields"]["weightKg"]["value"], "weightDate": record["day"] })
            }
            None => json!({ "weightKg": null, "weightDate": null }),
        };
        let today_wellness = self.store.get_wellness(&self.owner_id, &today)?;
        let state = json!({ "profile": profile.clone(), "latestWeight": weight, "todayWellness": today_wellness });
        let mut information = Map::new();
        information.insert("preferredName".into(), profile["preferredName"].clone());
        information.insert("gender".into(), profile["gender"].clone());
        information.insert("heightCm".into(), profile["heightCm"].clone());
        information.insert("birthDate".into(), profile["birthDate"].clone());
        information.insert("unitSystem".into(), profile["unitSystem"].clone());
        information.insert("weightKg".into(), weight["weightKg"].clone());
        information.insert("weightDate".into(), weight["weightDate"].clone());
        information.insert("snapshotHash".into(), Value::String(stable_hash(&state)));
        Ok(Value::Object(information))
    }

    pub fn save_personal_information(&self, value: &Value) -> Result<Value> {
        let input = parse_personal_information(value)?;
        self.store
            .transaction(&mut || self.save_personal_information_inner(&input))
    }

    fn save_personal_information_inner(&self, input: &PersonalInformationWrite) -> Result<Value> {
        let current = self.get_personal_information()?;
        if Value::String(input.expected_snapshot_hash.clone()) != current["snapshotHash"] {
            return Err(failure(
                AthriaErrorCode::InputSnapshotChanged,
                "Personal information changed. Refresh before saving.",
                409,
            ));
        }
        let profile = self.get_profile()?;
        let timezone = string_field(&profile, "timezone").to_owned();
        let mut patch = Map::new();
        patch.insert(
            "preferredName".into(),
            Value::String(input.preferred_name.clone()),
        );
        patch.insert("gender".into(), input.gender.clone());
        patch.insert("heightCm".into(), input.height_cm.clone());
        patch.insert("birthDate".into(), input.birth_date.clone());
        if let Some(unit_system) = &input.unit_system {
            patch.insert("unitSystem".into(), Value::String(unit_system.clone()));
        }
        let profile = merge_profile(&profile, &Value::Object(patch), &self.owner_id)?;
        self.store.save_profile(&profile)?;
        if let Some(weight_kg) = &input.weight_kg {
            let day = tz::local_date(&self.now_iso(), &timezone)?;
            let stored = self.store.get_wellness(&self.owner_id, &day)?;
            let mut fields = stored
                .as_ref()
                .and_then(|record| record.get("fields"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if weight_kg.is_null() {
                fields.shift_remove("weightKg");
            } else {
                fields.insert(
                    "weightKg".into(),
                    json!({ "value": weight_kg, "source": "user", "updatedAt": self.now_iso() }),
                );
            }
            let record = parse_wellness_record(
                &json!({ "ownerId": self.owner_id, "day": day, "fields": Value::Object(fields), "updatedAt": self.now_iso() }),
            )?;
            self.store.save_wellness(&record)?;
        }
        self.get_personal_information()
    }

    pub fn get_training_taxonomy(&self) -> Value {
        json!({
            "planSchemaVersion": PLAN_SCHEMA_VERSION,
            "taxonomyVersion": TAXONOMY_VERSION,
            "templateCatalogVersion": TEMPLATE_CATALOG_VERSION,
            "domains": DOMAIN_IDS,
            "equipmentCategories": equipment_categories(),
            "strength": {
                "movementPatterns": movement_pattern_taxonomy(),
                "muscleGroups": muscle_taxonomy(),
                "equipment": equipment_type_ids(),
            },
            "templateVariables": template_variables(),
            "factSources": FACT_SOURCES,
            "aiHardConfidence": AI_HARD_CONFIDENCE,
        })
    }

    pub fn list_templates(&self) -> Result<Vec<Value>> {
        let user = self.store.list_templates(&self.owner_id)?;
        let dismissed: HashSet<String> = self
            .store
            .list_dismissed_template_ids(&self.owner_id)?
            .into_iter()
            .collect();
        let user_by_id: HashMap<&str, &Value> = user
            .iter()
            .filter_map(|row| row["id"].as_str().map(|id| (id, row)))
            .collect();
        let builtins = builtin_session_templates();
        let mut merged = Vec::new();
        // A user row with a built-in ID is the derived replacement of that built-in: it keeps the
        // built-in's catalog slot instead of being appended. Dismissals hide removed built-ins.
        for item in &builtins {
            let id = string_field(item, "id");
            match user_by_id.get(id) {
                Some(replacement) => merged.push((*replacement).clone()),
                None if dismissed.contains(id) => {}
                None => merged.push(item.clone()),
            }
        }
        let builtin_ids: HashSet<&str> = builtins
            .iter()
            .map(|item| string_field(item, "id"))
            .collect();
        merged.extend(
            user.iter()
                .filter(|row| !builtin_ids.contains(string_field(row, "id")))
                .cloned(),
        );
        Ok(merged)
    }

    pub fn get_template(&self, id: &str) -> Result<Value> {
        self.store
            .get_template(id, &self.owner_id)?
            .or_else(|| builtin_template(id))
            .ok_or_else(|| {
                failure(
                    AthriaErrorCode::TemplateNotFound,
                    "The session template was not found.",
                    404,
                )
            })
    }

    pub fn create_template(&self, value: &Value) -> Result<Value> {
        let (template, _client_request_id) = parse_session_template_create(value)?;
        self.store
            .create_template(&template, &self.owner_id)
            .map_err(|error| {
                if error.code() == AthriaErrorCode::TemplateAlreadyExists {
                    failure(
                        AthriaErrorCode::TemplateAlreadyExists,
                        "A template with this ID already exists.",
                        409,
                    )
                } else {
                    error
                }
            })
    }

    pub fn update_template(&self, value: &Value) -> Result<Value> {
        let (template, expected_revision) = parse_session_template_update(value)?;
        let template = self
            .store
            .update_template(&template, expected_revision, &self.owner_id)
            .map_err(template_write_error)?;
        Ok(json!({ "template": template, "impact": { "affectedCount": 0, "updatedCount": 0 } }))
    }

    pub fn delete_template(&self, id: &str, expected_revision: Option<i64>) -> Result<Value> {
        // Deleting a built-in that has no derived row only hides it; the code-defined original
        // remains and existing plan references keep resolving against the catalog.
        if self.store.get_template(id, &self.owner_id)?.is_none() && builtin_template(id).is_some()
        {
            self.store.dismiss_template(id, &self.owner_id)?;
            return Ok(json!({ "deleted": true, "id": id }));
        }
        let references = self
            .store
            .get_current_plan(&self.owner_id)?
            .map(|plan| template_references(&plan, id))
            .unwrap_or_default();
        if !references.is_empty() {
            return Err(failure(
                AthriaErrorCode::TemplateInUse,
                "Remove this template reference from the current plan before deleting it.",
                409,
            ));
        }
        let Some(expected_revision) = expected_revision else {
            return Err(failure(
                AthriaErrorCode::RevisionRequired,
                "expectedRevision is required to delete a stored template.",
                400,
            ));
        };
        self.store
            .delete_template(id, expected_revision, &self.owner_id)
            .map_err(template_write_error)?;
        // Removing the derived replacement of a built-in keeps that built-in hidden.
        if builtin_template(id).is_some() {
            self.store.dismiss_template(id, &self.owner_id)?;
        }
        Ok(json!({ "deleted": true, "id": id }))
    }

    /// `listSessions(days = 90)`, with the derived domains filled in.
    pub fn list_sessions(&self, days: i64) -> Result<Vec<Value>> {
        let since = tz::iso_minus_days(&self.now_iso(), days)?;
        Ok(self
            .store
            .list_sessions(&self.owner_id, Some(&since))?
            .iter()
            .map(with_session_domains)
            .collect())
    }

    /// `snapshotHash()`: the hash the plan/personal-information writes compare against.
    pub fn snapshot_hash(&self) -> Result<String> {
        Ok(stable_hash(&json!({
            "profile": self.get_profile()?,
            "sessions": self.list_sessions(90)?,
            "wellness": self.list_wellness(42)?,
        })))
    }

    pub fn get_training_state(&self) -> Result<Value> {
        let sessions = self.list_sessions(90)?;
        let metrics =
            serde_json::to_value(calculate_training_metrics(&sessions)).map_err(|error| {
                failure(
                    AthriaErrorCode::InvalidData,
                    &format!("training metrics did not serialize: {error}"),
                    500,
                )
            })?;
        Ok(json!({
            "asOf": self.now_iso(),
            "inputSnapshotHash": self.snapshot_hash()?,
            "personalInformation": self.get_personal_information()?,
            "metrics": metrics,
            "wellness": self.list_wellness(42)?,
            "dataGaps": [],
        }))
    }

    /// `getTrainingSummary(days = 7, from?, to?)`: domain-separated metrics over
    /// the sessions whose local day falls inside the requested window.
    pub fn get_training_summary(
        &self,
        days: i64,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<Value> {
        let start = from
            .map(|value| parse_date_input(value, "from"))
            .transpose()?;
        let end = to.map(|value| parse_date_input(value, "to")).transpose()?;
        if let (Some(start), Some(end)) = (&start, &end) {
            if start > end {
                return Err(AthriaError::new(
                    AthriaErrorCode::InvalidSummaryWindow,
                    "The summary start date must not be after the end date.",
                ));
            }
        }
        let profile = self.get_profile()?;
        let profile_timezone = string_field(&profile, "timezone");
        let lookback_days = match &start {
            Some(start) => days.max(
                day_difference(start, &tz::local_date(&self.now_iso(), profile_timezone)?) + 2,
            ),
            None => days,
        };
        let mut sessions = Vec::new();
        for session in self.list_sessions(lookback_days)? {
            let day = session_local_day(&session, profile_timezone)?;
            if start.as_ref().is_some_and(|start| &day < start)
                || end.as_ref().is_some_and(|end| &day > end)
            {
                continue;
            }
            sessions.push(session);
        }
        let mut by_domain = Map::new();
        let mut duration_minutes_by_domain = Map::new();
        for domain in DOMAIN_IDS {
            let matching: Vec<&Value> = sessions
                .iter()
                .filter(|session| {
                    session
                        .get("domains")
                        .and_then(Value::as_array)
                        .is_some_and(|domains| domains.iter().any(|item| item == domain))
                })
                .collect();
            by_domain.insert(domain.into(), Value::from(matching.len() as i64));
            duration_minutes_by_domain.insert(
                domain.into(),
                Value::from(
                    matching
                        .iter()
                        .map(|session| session["durationMinutes"].as_i64().unwrap_or(0))
                        .sum::<i64>(),
                ),
            );
        }
        let mut sports: Vec<(String, i64, i64)> = Vec::new();
        for session in &sessions {
            if !session
                .get("domains")
                .and_then(Value::as_array)
                .is_some_and(|domains| domains.iter().any(|item| item == "sport_skill"))
            {
                continue;
            }
            let Some(name) = session
                .get("sport")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            let duration = session["durationMinutes"].as_i64().unwrap_or(0);
            match sports.iter_mut().find(|(existing, _, _)| existing == name) {
                Some((_, session_count, duration_minutes)) => {
                    *session_count += 1;
                    *duration_minutes += duration;
                }
                None => sports.push((name.to_owned(), 1, duration)),
            }
        }
        sports.sort_by(
            |(left_name, _, left_duration), (right_name, _, right_duration)| {
                right_duration
                    .cmp(left_duration)
                    .then_with(|| js_locale_compare(left_name, right_name))
            },
        );
        let sports = Value::Array(sports.into_iter().map(|(name, session_count, duration_minutes)| json!({ "name": name, "sessionCount": session_count, "durationMinutes": duration_minutes })).collect());
        let total_duration_minutes: i64 = sessions
            .iter()
            .map(|session| session["durationMinutes"].as_i64().unwrap_or(0))
            .sum();
        let metrics =
            serde_json::to_value(calculate_training_metrics(&sessions)).map_err(|error| {
                failure(
                    AthriaErrorCode::InvalidData,
                    &format!("training metrics did not serialize: {error}"),
                    500,
                )
            })?;
        Ok(json!({
            "periodDays": days,
            "sessionCount": sessions.len(),
            "totalDurationMinutes": total_duration_minutes,
            "byDomain": Value::Object(by_domain),
            "durationMinutesByDomain": Value::Object(duration_minutes_by_domain),
            "sports": sports,
            "metrics": metrics,
        }))
    }

    /// `recordTrainingSession(value)`: the manual write path, always stored as a
    /// completed `manual` observation.
    pub fn record_training_session(&self, value: &Value) -> Result<Value> {
        object_input(value, "session")?;
        let id = match optional_text(value, "id", "session")? {
            Some(id) => id,
            None => Uuid::new_v4().to_string(),
        };
        let external_id = match optional_text(value, "externalId", "session")? {
            Some(external_id) => external_id,
            None => id.clone(),
        };
        let mut candidate = value.as_object().cloned().unwrap_or_default();
        candidate.insert("id".into(), Value::String(id));
        candidate.insert("externalId".into(), Value::String(external_id));
        candidate.insert("ownerId".into(), Value::String(self.owner_id.clone()));
        candidate.insert("source".into(), Value::String("manual".into()));
        candidate.insert("status".into(), Value::String("completed".into()));
        candidate.entry("plannedSessionId").or_insert(Value::Null);
        let session = parse_training_session(&Value::Object(candidate))?;
        self.store.upsert_sessions(std::slice::from_ref(&session))?;
        Ok(session)
    }

    pub fn set_training_session_plan_match(&self, id: &str, value: &Value) -> Result<Value> {
        object_input(value, "match")?;
        require_confirmed(value, "match")?;
        let planned_session_id = nullable_text(value, "plannedSessionId", "match")?;
        let expected_revision = input_int(value, "expectedRevision", "match", 0..=i64::MAX)?;
        self.store
            .set_training_session_plan_match(
                &self.owner_id,
                id,
                planned_session_id.as_deref(),
                expected_revision,
            )
            .map_err(|error| {
                let code = error.code();
                let message = match code {
                    AthriaErrorCode::NoCurrentPlan => "There is no current plan.",
                    AthriaErrorCode::PlannedSessionRevisionConflict => {
                        "The plan changed. Refresh and try again."
                    }
                    AthriaErrorCode::TrainingSessionNotFound => "The workout was not found.",
                    AthriaErrorCode::PlannedSessionNotFound => "The planned session was not found.",
                    AthriaErrorCode::PlannedSessionSkipped => {
                        "Restore the skipped session before linking it."
                    }
                    AthriaErrorCode::PlanWorkoutDateMismatch => {
                        "The workout and planned session must be on the same local date."
                    }
                    _ => "The workout-to-plan match could not be updated.",
                };
                failure(
                    code,
                    message,
                    if code.as_str().ends_with("NOT_FOUND") {
                        404
                    } else {
                        409
                    },
                )
            })
    }

    pub fn clear_training_session_plan_exclusion(&self, id: &str, value: &Value) -> Result<Value> {
        object_input(value, "match")?;
        require_confirmed(value, "match")?;
        self.store
            .clear_training_session_plan_exclusion(&self.owner_id, id)
            .map_err(|error| {
                failure(
                    error.code(),
                    "The workout could not be returned to automatic matching.",
                    404,
                )
            })
    }

    pub fn update_training_session_type(&self, id: &str, value: &Value) -> Result<Value> {
        object_input(value, "type")?;
        require_confirmed(value, "type")?;
        let domain = value
            .get("domain")
            .and_then(Value::as_str)
            .filter(|domain| DOMAIN_IDS.contains(domain))
            .ok_or_else(|| invalid_input("type.domain: expected a training domain"))?;
        self.store
            .set_training_session_type_override(&self.owner_id, id, domain)
            .map_err(|error| {
                let code = error.code();
                failure(
                    code,
                    if code == AthriaErrorCode::TrainingSessionNotFound {
                        "The workout was not found."
                    } else {
                        "The workout type could not be updated."
                    },
                    if code == AthriaErrorCode::TrainingSessionNotFound {
                        404
                    } else {
                        409
                    },
                )
            })
    }

    pub fn update_manual_training_session(&self, id: &str, value: &Value) -> Result<Value> {
        object_input(value, "session")?;
        require_confirmed(value, "session")?;
        let start_at = optional_text(value, "startAt", "session")?;
        let duration_minutes = match value.get("durationMinutes") {
            Some(_) => Some(input_int(value, "durationMinutes", "session", 1..=1440)?),
            None => None,
        };
        if start_at.is_none() && duration_minutes.is_none() {
            return Err(invalid_input("session: provide a start time or duration"));
        }
        self.store
            .update_manual_training_session(
                &self.owner_id,
                id,
                start_at.as_deref(),
                duration_minutes,
            )
            .map_err(|error| {
                let code = error.code();
                let message = if code == AthriaErrorCode::ManualDateChangeRequiresPlanMove {
                    "Move or unlink the planned session before changing the workout date."
                } else {
                    "The manual workout details could not be updated."
                };
                failure(
                    code,
                    message,
                    if code == AthriaErrorCode::ManualSourceNotFound {
                        404
                    } else {
                        409
                    },
                )
            })
    }

    pub fn delete_manual_training_session(&self, id: &str, value: &Value) -> Result<Value> {
        object_input(value, "session")?;
        require_confirmed(value, "session")?;
        let session = self
            .store
            .delete_manual_training_session(&self.owner_id, id)
            .map_err(|error| {
                failure(
                    error.code(),
                    "The manual workout record could not be removed.",
                    404,
                )
            })?;
        Ok(session.unwrap_or(Value::Null))
    }

    pub fn delete_training_session(&self, id: &str, value: &Value) -> Result<Value> {
        object_input(value, "session")?;
        require_confirmed(value, "session")?;
        self.store
            .delete_training_session(&self.owner_id, id)
            .map_err(|error| {
                let code = error.code();
                failure(
                    code,
                    if code == AthriaErrorCode::TrainingSessionNotFound {
                        "The workout was not found."
                    } else {
                        "The workout could not be deleted."
                    },
                    if code == AthriaErrorCode::TrainingSessionNotFound {
                        404
                    } else {
                        409
                    },
                )
            })?;
        Ok(json!({ "deleted": true }))
    }

    /// `listWellness(days = 42)`: stored records plus their snapshot hashes.
    pub fn list_wellness(&self, days: i64) -> Result<Vec<Value>> {
        let since = tz::iso_minus_days(&self.now_iso(), days)?;
        let since = &since[..10];
        let records = self.store.list_wellness(&self.owner_id, Some(since))?;
        Ok(records
            .into_iter()
            .map(|record| {
                let hash = stable_hash(&record);
                let mut value = record.as_object().cloned().unwrap_or_default();
                value.insert("snapshotHash".into(), Value::String(hash));
                Value::Object(value)
            })
            .collect())
    }

    /// `getWellnessDay(day)`: a missing day reports the hash `"new"` and omits
    /// `record`, which `JSON.stringify` drops in TypeScript.
    pub fn get_wellness_day(&self, day: &str) -> Result<Value> {
        let day = parse_date_input(day, "day")?;
        let record = self.store.get_wellness(&self.owner_id, &day)?;
        let mut response = Map::new();
        let snapshot_hash = match &record {
            Some(record) => {
                response.insert("record".into(), record.clone());
                stable_hash(record)
            }
            None => "new".to_owned(),
        };
        response.insert("snapshotHash".into(), Value::String(snapshot_hash));
        Ok(Value::Object(response))
    }

    /// `updateWellness(day, value)`: hash-checked field merge into one day.
    pub fn update_wellness(&self, day: &str, value: &Value) -> Result<Value> {
        let input = parse_wellness_patch(value)?;
        let day = parse_date_input(day, "day")?;
        let current = self.store.get_wellness(&self.owner_id, &day)?;
        let current_hash = match &current {
            Some(record) => stable_hash(record),
            None => "new".to_owned(),
        };
        if current_hash != input.expected_snapshot_hash {
            return Err(failure(
                AthriaErrorCode::InputSnapshotChanged,
                "Wellness changed. Refresh before applying the confirmed update.",
                409,
            ));
        }
        let updated_at = self.now_iso();
        let mut fields = current
            .as_ref()
            .and_then(|record| record.get("fields"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, field_value) in &input.fields {
            if field_value.is_null() {
                fields.shift_remove(key);
            } else {
                fields.insert(key.clone(), json!({ "value": field_value, "source": &input.source, "updatedAt": &updated_at }));
            }
        }
        let record = parse_wellness_record(
            &json!({ "ownerId": self.owner_id, "day": day, "fields": Value::Object(fields), "updatedAt": updated_at }),
        )?;
        self.store.save_wellness(&record)
    }

    pub fn preview_hevy(&self, content: &[u8], file_name: &str) -> Result<Value> {
        let preview = parse_hevy_csv(content, file_name)?.value;
        let token = string_field(&preview, "contentHash").to_owned();
        self.integration_previews
            .borrow_mut()
            .insert(token.clone(), preview.clone());
        Ok(
            json!({ "previewToken": token, "fileName": file_name, "counts": preview["counts"], "errors": preview["errors"], "unknownColumns": preview["unknownColumns"] }),
        )
    }

    pub fn commit_hevy(&self, preview_token: &str) -> Result<Value> {
        let preview = self
            .integration_previews
            .borrow()
            .get(preview_token)
            .cloned()
            .ok_or_else(|| {
                failure(
                    AthriaErrorCode::ImportPreviewNotFound,
                    "The import preview was not found.",
                    404,
                )
            })?;
        let sessions = preview["sessions"].as_array().cloned().unwrap_or_default();
        let counts = self.store.upsert_sessions(&sessions)?;
        let status = if preview["errors"].as_array().is_some_and(Vec::is_empty) {
            "committed"
        } else {
            "partial"
        };
        let data = json!({ "counts": preview["counts"], "errors": preview["errors"], "unknownColumns": preview["unknownColumns"] });
        self.store.record_import_batch(&RecordImportBatchInput {
            owner_id: &self.owner_id,
            source: "hevy",
            content_hash: string_field(&preview, "contentHash"),
            file_name: string_field(&preview, "fileName"),
            parser_version: HEVY_PARSER_VERSION,
            status,
            data: &data,
        })?;
        self.integration_previews.borrow_mut().remove(preview_token);
        Ok(counts.to_json())
    }

    pub fn get_hevy_import_status(&self) -> Result<Option<Value>> {
        Ok(self.store.latest_import_batch(&self.owner_id, "hevy")?.map(|batch| json!({
            "fileName": batch["fileName"], "importedAt": batch["createdAt"], "status": batch["status"], "counts": batch["data"]["counts"]
        })))
    }

    pub fn get_intervals_sync_status(&self) -> Result<Option<Value>> {
        self.store
            .get_connection_sync_state("intervals", &self.owner_id)
    }

    pub fn commit_intervals(&self, payload: &Value, context: &Value) -> Result<Value> {
        let activities = payload.get("activities").and_then(Value::as_array);
        let mut sessions = Vec::new();
        if let Some(items) = activities {
            for item in items {
                let Some(session) = normalize_intervals_activity(item, "activities")? else {
                    return Err(failure(
                        AthriaErrorCode::IntervalsNormalizationFailed,
                        "Intervals returned an activity without a valid start time; existing training data was left unchanged.",
                        502,
                    ));
                };
                sessions.push(session);
            }
        }
        let attempted_at = context
            .get("attemptedAt")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| self.now_iso());
        let range_start = context
            .get("rangeStart")
            .and_then(Value::as_str)
            .unwrap_or(&attempted_at[..10]);
        let range_end = context
            .get("rangeEnd")
            .and_then(Value::as_str)
            .unwrap_or(&attempted_at[..10]);
        let counts = if activities.is_some() {
            self.store
                .replace_source_sessions(&ReplaceSourceSessionsInput {
                    owner_id: &self.owner_id,
                    source: "intervals",
                    sessions: &sessions,
                    dates: None,
                    local_dates: None,
                    range_start: Some(range_start),
                    range_end: Some(range_end),
                })?
        } else {
            crate::store::WriteCounts {
                added: 0,
                updated: 0,
            }
        };
        let wellness_count = match payload.get("wellness").and_then(Value::as_array) {
            Some(records) => self.store.upsert_wellness(&self.owner_id, records)?,
            None => 0,
        };
        let mut errors = Map::new();
        for name in ["activities", "events", "wellness"] {
            if let Some(Value::String(message)) = payload.get(name) {
                errors.insert(name.into(), json!(message));
            }
        }
        let activities_ok = activities.is_some();
        let wellness_ok = payload.get("wellness").is_some_and(Value::is_array);
        let status = if activities_ok && wellness_ok {
            "success"
        } else if activities_ok || wellness_ok {
            "partial"
        } else {
            "failed"
        };
        let previous = self.get_intervals_sync_status()?;
        let last_success = if status == "success" {
            json!(attempted_at)
        } else {
            previous
                .as_ref()
                .map(|value| value["lastSuccessAt"].clone())
                .unwrap_or(Value::Null)
        };
        let state = self.store.save_connection_sync_state(&json!({ "ownerId": self.owner_id, "source": "intervals", "lastAttemptAt": attempted_at,
            "lastSuccessAt": last_success, "rangeStart": range_start, "rangeEnd": range_end, "status": status,
            "data": { "activities": counts.to_json(), "wellnessCount": wellness_count, "errors": errors } }))?;
        Ok(
            json!({ "added": counts.added, "updated": counts.updated, "wellnessCount": wellness_count, "errors": errors, "sync": state }),
        )
    }

    pub fn get_xunji_sync_status(&self) -> Result<Option<Value>> {
        self.store
            .get_connection_sync_state("xunji", &self.owner_id)
    }

    pub fn list_xunji_sessions(&self, days: i64) -> Result<Value> {
        let since = tz::iso_minus_days(&self.now_iso(), days)?;
        Ok(
            json!({ "source": "xunji", "sync": self.get_xunji_sync_status()?, "sessions": self.store.list_sessions_by_source("xunji", &self.owner_id, Some(&since))? }),
        )
    }

    pub fn record_xunji_failure(&self, input: &Value) -> Result<Value> {
        let previous = self.get_xunji_sync_status()?;
        let message: String = input["message"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(500)
            .collect();
        self.store.save_connection_sync_state(&json!({ "ownerId": self.owner_id, "source": "xunji", "lastAttemptAt": input["attemptedAt"],
            "lastSuccessAt": previous.as_ref().map(|value| value["lastSuccessAt"].clone()).unwrap_or(Value::Null), "rangeStart": input["rangeStart"], "rangeEnd": input["rangeEnd"],
            "status": "failed", "data": { "successfulDays": 0, "failedDays": 1, "errors": [{ "code": input["code"], "message": message }] } }))
    }

    pub fn commit_xunji(&self, result: &Value, attempted_at: &str) -> Result<Value> {
        let mut normalized = Vec::new();
        let mut normalization_errors = Vec::new();
        let mut failed_dates = HashSet::new();
        for record in result["records"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            match normalize_xunji_training(record) {
                Ok(session) => {
                    normalized.push((record["datestr"].as_str().unwrap_or("").to_owned(), session))
                }
                Err(error) => {
                    if record["datestr"]
                        .as_str()
                        .is_some_and(athria_core::date::is_iso_date)
                    {
                        failed_dates.insert(record["datestr"].as_str().unwrap().to_owned());
                    }
                    normalization_errors.push(json!({ "code": "normalization_failed", "message": error.message().chars().take(500).collect::<String>() }));
                }
            }
        }
        let replace_dates: Vec<String> = result["successfulDates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|date| !failed_dates.contains(*date))
            .map(str::to_owned)
            .collect();
        let replacement: Vec<Value> = normalized
            .iter()
            .filter(|(date, _)| replace_dates.contains(date))
            .map(|(_, session)| session.clone())
            .collect();
        let local_dates = Map::from_iter(
            normalized
                .iter()
                .filter(|(date, _)| replace_dates.contains(date))
                .map(|(date, session)| {
                    (string_field(session, "externalId").to_owned(), json!(date))
                }),
        );
        let counts = if replace_dates.is_empty() {
            crate::store::WriteCounts {
                added: 0,
                updated: 0,
            }
        } else {
            self.store
                .replace_source_sessions(&ReplaceSourceSessionsInput {
                    owner_id: &self.owner_id,
                    source: "xunji",
                    sessions: &replacement,
                    dates: Some(&replace_dates),
                    local_dates: Some(&local_dates),
                    range_start: None,
                    range_end: None,
                })?
        };
        let mut errors = result["errors"].as_array().cloned().unwrap_or_default();
        errors.extend(normalization_errors.clone());
        let successful_days = result["successfulDates"].as_array().map_or(0, Vec::len);
        let failed_days = result["errors"].as_array().map_or(0, Vec::len);
        let status = if errors.is_empty() {
            "success"
        } else if successful_days > 0 {
            "partial"
        } else {
            "failed"
        };
        let previous = self.get_xunji_sync_status()?;
        let state = self.store.save_connection_sync_state(&json!({ "ownerId": self.owner_id, "source": "xunji", "lastAttemptAt": attempted_at,
            "lastSuccessAt": if successful_days > 0 { json!(attempted_at) } else { previous.as_ref().map(|value| value["lastSuccessAt"].clone()).unwrap_or(Value::Null) },
            "rangeStart": result["rangeStart"], "rangeEnd": result["rangeEnd"], "status": status,
            "data": { "successfulDays": successful_days, "failedDays": failed_days, "records": result["records"].as_array().map_or(0, Vec::len), "normalizationFailures": normalization_errors.len(), "errors": errors } }))?;
        let content_hash = stable_hash(
            &json!({ "rangeStart": result["rangeStart"], "rangeEnd": result["records"].as_array().into_iter().flatten().map(|record| record.get("localid").or_else(|| record.get("start")).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>() }),
        );
        let data = json!({ "added": counts.added, "updated": counts.updated, "sync": state });
        self.store.record_import_batch(&RecordImportBatchInput {
            owner_id: &self.owner_id,
            source: "xunji",
            content_hash: &content_hash,
            file_name: "Xunji Open API",
            parser_version: XUNJI_PARSER_VERSION,
            status,
            data: &data,
        })?;
        Ok(json!({ "added": counts.added, "updated": counts.updated, "sync": state }))
    }

    /// `getCurrentPlan()`.
    pub fn get_current_plan(&self) -> Result<Option<Value>> {
        self.store.get_current_plan(&self.owner_id)
    }

    /// Starts a persisted plan draft. `current_plan` clones the editable plan
    /// so an agent only needs to replace the weeks it changes.
    pub fn create_plan_draft(&self, value: &Value) -> Result<Value> {
        let mode = value
            .get("mode")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_input("planDraft.mode is required"))?;
        let mut data = match mode {
            "new" => value
                .get("plan")
                .cloned()
                .ok_or_else(|| invalid_input("planDraft.plan is required"))?,
            "current_plan" => self.get_current_plan()?.ok_or_else(|| {
                failure(
                    AthriaErrorCode::NoCurrentPlan,
                    "There is no current plan.",
                    409,
                )
            })?,
            _ => return Err(invalid_input("planDraft.mode must be new or current_plan")),
        };
        let base_revision = self
            .get_current_plan()?
            .and_then(|plan| plan["revision"].as_i64())
            .unwrap_or(0);
        let object = data
            .as_object_mut()
            .ok_or_else(|| invalid_input("planDraft.plan must be an object"))?;
        object.remove("revision");
        object.remove("updatedAt");
        object.remove("expectedRevision");
        let weeks = object
            .get_mut("mesocycle")
            .and_then(Value::as_object_mut)
            .and_then(|mesocycle| mesocycle.remove("weeks"))
            .unwrap_or_else(|| Value::Array(Vec::new()));
        if mode == "new" && !weeks.as_array().is_some_and(Vec::is_empty) {
            return Err(invalid_input("new plan drafts must not include weeks"));
        }
        let timestamp = self.now_iso();
        let draft = json!({"id":Uuid::new_v4().to_string(),"ownerId":self.owner_id,"data":data,"basePlanRevision":base_revision,"inputSnapshotHash":self.snapshot_hash()?,"draftRevision":0,"status":"open","createdAt":timestamp,"updatedAt":timestamp});
        let created = self.store.create_plan_draft(&draft)?;
        for week in weeks.as_array().into_iter().flatten() {
            self.store.save_plan_draft_week(
                created["id"].as_str().unwrap(),
                &self.owner_id,
                self.store
                    .get_plan_draft(created["id"].as_str().unwrap(), &self.owner_id)?
                    .unwrap()["draftRevision"]
                    .as_i64()
                    .unwrap(),
                week,
            )?;
        }
        self.plan_draft_summary(created["id"].as_str().unwrap())
    }

    fn plan_draft_summary(&self, draft_id: &str) -> Result<Value> {
        let draft = self
            .store
            .get_plan_draft(draft_id, &self.owner_id)?
            .ok_or_else(|| {
                failure(
                    AthriaErrorCode::DraftNotFound,
                    "The plan draft was not found.",
                    404,
                )
            })?;
        let duration = draft["data"]["mesocycle"]["durationWeeks"]
            .as_i64()
            .unwrap_or(0);
        let existing: Vec<i64> = self
            .store
            .list_plan_draft_weeks(draft_id)?
            .iter()
            .filter_map(|week| week["weekNumber"].as_i64())
            .collect();
        let missing: Vec<i64> = (1..=duration)
            .filter(|week| !existing.contains(week))
            .collect();
        Ok(
            json!({"draftId":draft["id"],"draftRevision":draft["draftRevision"],"basePlanRevision":draft["basePlanRevision"],"inputSnapshotHash":draft["inputSnapshotHash"],"status":draft["status"],"existingWeekNumbers":existing,"missingWeekNumbers":missing,"createdAt":draft["createdAt"],"updatedAt":draft["updatedAt"]}),
        )
    }

    pub fn list_plan_drafts(&self) -> Result<Vec<Value>> {
        self.store
            .list_plan_drafts(&self.owner_id)?
            .into_iter()
            .map(|draft| self.plan_draft_summary(draft["id"].as_str().unwrap()))
            .collect()
    }

    pub fn get_plan_draft(&self, draft_id: &str, week_number: Option<i64>) -> Result<Value> {
        let summary = self.plan_draft_summary(draft_id)?;
        if let Some(number) = week_number {
            let week = self
                .store
                .list_plan_draft_weeks(draft_id)?
                .into_iter()
                .find(|week| week["weekNumber"].as_i64() == Some(number))
                .ok_or_else(|| {
                    failure(
                        AthriaErrorCode::PlanWeekNotFound,
                        "The draft week was not found.",
                        404,
                    )
                })?;
            Ok(json!({"summary":summary,"week":week}))
        } else {
            Ok(summary)
        }
    }

    pub fn upsert_plan_draft_week(
        &self,
        draft_id: &str,
        expected_revision: i64,
        week: &Value,
    ) -> Result<Value> {
        let draft = self
            .store
            .get_plan_draft(draft_id, &self.owner_id)?
            .ok_or_else(|| {
                failure(
                    AthriaErrorCode::DraftNotFound,
                    "The plan draft was not found.",
                    404,
                )
            })?;
        if draft["status"] != "open" {
            return Err(failure(
                AthriaErrorCode::DraftNotFound,
                "The plan draft is no longer editable.",
                404,
            ));
        }
        let week = parse_plan_week(week)?;
        let duration = draft["data"]["mesocycle"]["durationWeeks"]
            .as_i64()
            .unwrap_or(0);
        let week_number = week["weekNumber"].as_i64().unwrap_or(0);
        if !(1..=duration).contains(&week_number) {
            return Err(invalid_input(
                "week.weekNumber is outside the draft mesocycle",
            ));
        }
        let start = draft["data"]["effectiveStartDate"]
            .as_str()
            .unwrap_or_default();
        for session in week["sessions"].as_array().into_iter().flatten() {
            let date = session["scheduledDate"].as_str().unwrap_or_default();
            let elapsed = day_difference(start, date);
            if elapsed < 0 || elapsed / 7 + 1 != week_number {
                return Err(invalid_input(
                    "session date must fall inside its draft week",
                ));
            }
        }
        self.store
            .save_plan_draft_week(draft_id, &self.owner_id, expected_revision, &week)?;
        self.plan_draft_summary(draft_id)
    }

    fn assembled_plan_draft(
        &self,
        draft_id: &str,
        expected_revision: i64,
        snapshot_hash: &str,
    ) -> Result<Value> {
        let draft = self
            .store
            .get_plan_draft(draft_id, &self.owner_id)?
            .ok_or_else(|| {
                failure(
                    AthriaErrorCode::DraftNotFound,
                    "The plan draft was not found.",
                    404,
                )
            })?;
        let mut plan = draft["data"].clone();
        plan["mesocycle"]["weeks"] = Value::Array(self.store.list_plan_draft_weeks(draft_id)?);
        plan["expectedRevision"] = Value::from(expected_revision);
        plan["inputSnapshotHash"] = Value::String(snapshot_hash.to_owned());
        Ok(plan)
    }

    pub fn validate_plan_draft(&self, draft_id: &str) -> Result<PlanValidation> {
        let draft = self
            .store
            .get_plan_draft(draft_id, &self.owner_id)?
            .ok_or_else(|| {
                failure(
                    AthriaErrorCode::DraftNotFound,
                    "The plan draft was not found.",
                    404,
                )
            })?;
        let plan = self.assembled_plan_draft(
            draft_id,
            draft["basePlanRevision"].as_i64().unwrap_or(0),
            draft["inputSnapshotHash"].as_str().unwrap_or(""),
        )?;
        let duration = plan["mesocycle"]["durationWeeks"].as_i64().unwrap_or(0);
        let numbers: HashSet<i64> = self
            .store
            .list_plan_draft_weeks(draft_id)?
            .iter()
            .filter_map(|week| week["weekNumber"].as_i64())
            .collect();
        if !(1..=duration).all(|number| numbers.contains(&number)) {
            return Err(failure(
                AthriaErrorCode::DraftIncomplete,
                "The plan draft is missing one or more weeks.",
                409,
            ));
        }
        self.validate_current_plan(&plan)
    }

    pub fn commit_plan_draft(
        &self,
        draft_id: &str,
        expected_draft_revision: i64,
        expected_plan_revision: i64,
        input_snapshot_hash: &str,
        confirmed: bool,
    ) -> Result<Value> {
        if !confirmed {
            return Err(invalid_input("commitPlanDraft.confirmed: expected true"));
        }
        let draft = self
            .store
            .get_plan_draft(draft_id, &self.owner_id)?
            .ok_or_else(|| {
                failure(
                    AthriaErrorCode::DraftNotFound,
                    "The plan draft was not found.",
                    404,
                )
            })?;
        if draft["status"] == "committed" {
            let mut replay = draft["data"].clone();
            replay["idempotentReplay"] = Value::Bool(true);
            return Ok(replay);
        }
        if draft["draftRevision"].as_i64() != Some(expected_draft_revision) {
            return Err(failure(
                AthriaErrorCode::DraftRevisionConflict,
                "The plan draft changed. Refresh and try again.",
                409,
            ));
        }
        if draft["basePlanRevision"].as_i64() != Some(expected_plan_revision) {
            return Err(failure(
                AthriaErrorCode::PlanRevisionConflict,
                "The current plan changed since this draft was created. Create a fresh draft and rebase the changes.",
                409,
            ));
        }
        let validation = self.validate_plan_draft(draft_id)?;
        let summary = blocker_summary(&validation);
        let plan =
            self.assembled_plan_draft(draft_id, expected_plan_revision, input_snapshot_hash)?;
        let mut commit_result = None;
        self.store.transaction(&mut || {
            let saved = self
                .save_current_plan(&plan)
                .map_err(|error| match error.code() {
                    AthriaErrorCode::RevisionConflict => failure(
                        AthriaErrorCode::PlanRevisionConflict,
                        "The current plan changed. Refresh and rebase the draft.",
                        409,
                    ),
                    _ => error,
                })?;
            let result = json!({"revision":saved["plan"]["revision"],"impact":saved["impact"],"blockerSummary":summary,"idempotentReplay":false});
            self.store.set_plan_draft_status(
                draft_id,
                &self.owner_id,
                expected_draft_revision,
                "committed",
                saved["plan"]["revision"].as_i64(),
                Some(&result),
            )?;
            commit_result = Some(result);
            Ok(())
        })?;
        Ok(commit_result.expect("commit transaction sets result"))
    }

    pub fn discard_plan_draft(&self, draft_id: &str, expected_revision: i64) -> Result<Value> {
        self.store
            .set_plan_draft_status(
                draft_id,
                &self.owner_id,
                expected_revision,
                "discarded",
                None,
                None,
            )
            .map(|_| json!({"draftId":draft_id,"discarded":true}))
    }

    /// `assertTemplateReferences`: every referenced session template must
    /// resolve to the requested version at write time.
    fn assert_template_references(&self, mesocycle: &Value) -> Result<()> {
        let user = self.store.list_templates(&self.owner_id)?;
        let builtins = builtin_session_templates();
        for week in mesocycle["weeks"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            for session in week["sessions"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let reference = &session["templateRef"];
                if reference.is_null() {
                    continue;
                }
                let id = reference["id"].as_str().unwrap_or("");
                let valid = if reference["source"].as_str() == Some("builtin") {
                    builtins
                        .iter()
                        .find(|item| item["id"].as_str() == Some(id))
                        .is_some_and(|item| item["catalogVersion"] == reference["catalogVersion"])
                } else {
                    user.iter()
                        .find(|item| item["id"].as_str() == Some(id))
                        .is_some_and(|item| item["revision"] == reference["revision"])
                };
                if !valid {
                    return Err(failure(
                        AthriaErrorCode::TemplateNotFound,
                        &format!(
                            "Template reference {id} does not resolve to the requested version."
                        ),
                        409,
                    ));
                }
            }
        }
        Ok(())
    }

    /// `validateCurrentPlan(value)`: the template-resolution check and core
    /// validation a plan save would run, without writing anything.
    pub fn validate_current_plan(&self, value: &Value) -> Result<PlanValidation> {
        let input = parse_current_plan_write(value)?;
        self.assert_template_references(&input["mesocycle"])?;
        Ok(validate_plan(
            &self.get_profile()?,
            &plan_validation_draft(&input),
            &self.now_iso(),
        ))
    }

    /// `sessionsForPlan(plan, onOrAfterDate)`: every scheduled occurrence with
    /// one shared occurrence id per scheduled date.
    fn sessions_for_plan(&self, plan: &Value, on_or_after_date: &str) -> Result<Vec<Value>> {
        let timestamp = self.now_iso();
        let mut weeks: Vec<&Value> = plan["mesocycle"]["weeks"]
            .as_array()
            .map(|weeks| weeks.iter().collect())
            .unwrap_or_default();
        weeks.sort_by_key(|week| week["weekNumber"].as_i64().unwrap_or(0));
        let mut occurrence_by_date: HashMap<String, String> = HashMap::new();
        let mut sessions = Vec::new();
        for week in weeks {
            let week_number = week["weekNumber"].as_i64().unwrap_or(0);
            let mut week_sessions: Vec<&Value> = week["sessions"]
                .as_array()
                .map(|sessions| sessions.iter().collect())
                .unwrap_or_default();
            week_sessions.sort_by(|left, right| {
                js_locale_compare(
                    string_field(left, "scheduledDate"),
                    string_field(right, "scheduledDate"),
                )
                .then_with(|| {
                    left["order"]
                        .as_i64()
                        .unwrap_or(0)
                        .cmp(&right["order"].as_i64().unwrap_or(0))
                })
            });
            for session in week_sessions {
                let scheduled_date = string_field(session, "scheduledDate");
                if scheduled_date < on_or_after_date {
                    continue;
                }
                let occurrence_id = occurrence_by_date
                    .entry(scheduled_date.to_owned())
                    .or_insert_with(|| Uuid::new_v4().to_string())
                    .clone();
                let mut candidate = session.as_object().cloned().unwrap_or_default();
                candidate.insert("occurrenceId".into(), Value::String(occurrence_id));
                candidate.insert("ownerId".into(), Value::String(self.owner_id.clone()));
                candidate.insert("planRevision".into(), plan["revision"].clone());
                candidate.insert("weekNumber".into(), Value::from(week_number));
                candidate.insert(
                    "phaseRefs".into(),
                    phase_refs_for_session(plan, week_number, &session["components"])?,
                );
                candidate.insert("exerciseOverrides".into(), Value::Array(Vec::new()));
                candidate.insert("notes".into(), Value::String(String::new()));
                candidate.insert("overrideReason".into(), Value::Null);
                candidate.insert("completedTrainingSessionId".into(), Value::Null);
                candidate.insert("completedAt".into(), Value::Null);
                candidate.insert("completionSource".into(), Value::Null);
                candidate.insert("createdAt".into(), Value::String(timestamp.clone()));
                candidate.insert("updatedAt".into(), Value::String(timestamp.clone()));
                sessions.push(parse_planned_session(&Value::Object(candidate))?);
            }
        }
        Ok(sessions)
    }

    /// `saveCurrentPlan(value)`: validate, re-parse the stored document, diff
    /// the planned occurrences and write through the store.
    pub fn save_current_plan(&self, value: &Value) -> Result<Value> {
        let input = parse_current_plan_write(value)?;
        if input["ownerId"].as_str() != Some(self.owner_id.as_str()) {
            return Err(failure(
                AthriaErrorCode::OwnerMismatch,
                "The plan owner does not match the local athlete.",
                403,
            ));
        }
        // `input.inputSnapshotHash && ...`: an empty hash is falsy in JavaScript.
        if let Some(hash) = input["inputSnapshotHash"]
            .as_str()
            .filter(|hash| !hash.is_empty())
        {
            if hash != self.snapshot_hash()? {
                return Err(failure(
                    AthriaErrorCode::InputSnapshotChanged,
                    "Training state changed. Refresh and revise the plan.",
                    409,
                ));
            }
        }
        self.assert_template_references(&input["mesocycle"])?;
        let validation = validate_plan(
            &self.get_profile()?,
            &plan_validation_draft(&input),
            &self.now_iso(),
        );
        if !validation.valid {
            return Err(failure(
                AthriaErrorCode::PlanHasBlockers,
                &blocker_failure_message(&validation),
                409,
            ));
        }
        let expected_revision = input["expectedRevision"].as_i64().unwrap_or(0);
        let mut candidate = input.as_object().cloned().unwrap_or_default();
        candidate.shift_remove("expectedRevision");
        candidate.insert("revision".into(), Value::from(expected_revision + 1));
        candidate.insert("updatedAt".into(), Value::String(self.now_iso()));
        let plan = parse_current_plan(&Value::Object(candidate))?;
        let existing = self
            .store
            .list_current_planned_sessions(&self.owner_id, None)?;
        let terminal_ids: HashSet<&str> = existing
            .iter()
            .filter(|session| session["status"].as_str() != Some("planned"))
            .filter_map(|session| session["id"].as_str())
            .collect();
        let desired: Vec<Value> = self
            .sessions_for_plan(&plan, string_field(&plan, "effectiveStartDate"))?
            .into_iter()
            .filter(|session| !terminal_ids.contains(string_field(session, "id")))
            .collect();
        let desired_ids: HashSet<&str> = desired
            .iter()
            .map(|session| string_field(session, "id"))
            .collect();
        let deleted: Vec<String> = existing
            .iter()
            .filter(|session| {
                session["status"].as_str() == Some("planned")
                    && !desired_ids.contains(string_field(session, "id"))
            })
            .map(|session| string_field(session, "id").to_owned())
            .collect();
        let plan = self
            .store
            .save_current_plan(&plan, expected_revision, &deleted, &desired)
            .map_err(|error| match error.code() {
                AthriaErrorCode::RevisionConflict => failure(
                    AthriaErrorCode::RevisionConflict,
                    "The current plan changed. Refresh and try again.",
                    409,
                ),
                AthriaErrorCode::WriteBusy => failure(
                    AthriaErrorCode::WriteBusy,
                    "The database is busy. Retry the save.",
                    503,
                ),
                _ => error,
            })?;
        let validation = serde_json::to_value(&validation).map_err(|error| {
            failure(
                AthriaErrorCode::InvalidData,
                &format!("plan validation did not serialize: {error}"),
                500,
            )
        })?;
        Ok(json!({
            "plan": plan,
            "validation": validation,
            "impact": {
                "affectedCount": existing.len(),
                "updatedCount": desired.len(),
                "deletedCount": deleted.len(),
                "legacySkippedCount": 0,
            },
        }))
    }

    /// `getNextTrainingDay({ onOrAfterDate? })`.
    pub fn get_next_training_day(&self, on_or_after_date: Option<&str>) -> Result<Value> {
        let Some(plan) = self.store.get_current_plan(&self.owner_id)? else {
            return Ok(json!({ "nextTrainingDay": Value::Null, "reasonCode": "NO_CURRENT_PLAN" }));
        };
        let start = match on_or_after_date {
            Some(date) => parse_date_input(date, "onOrAfterDate")?,
            None => string_field(&plan, "effectiveStartDate").to_owned(),
        };
        let all: Vec<Value> = self
            .store
            .list_current_planned_sessions(&self.owner_id, None)?
            .into_iter()
            .filter(|session| {
                session["scheduledDate"]
                    .as_str()
                    .is_some_and(|date| date >= start.as_str())
            })
            .collect();
        let Some(next) = all
            .iter()
            .find(|session| session["status"].as_str() == Some("planned"))
        else {
            return Ok(json!({ "nextTrainingDay": Value::Null, "reasonCode": "PLAN_ENDED" }));
        };
        let occurrence_id = string_field(next, "occurrenceId");
        let existing: Vec<&Value> = all
            .iter()
            .filter(|session| session["occurrenceId"].as_str() == Some(occurrence_id))
            .collect();
        let mut refs: Vec<(&str, &str)> = Vec::new();
        for session in &existing {
            for reference in session["phaseRefs"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let ref_key = (
                    reference["domain"].as_str().unwrap_or(""),
                    reference["phaseId"].as_str().unwrap_or(""),
                );
                if !refs.contains(&ref_key) {
                    refs.push(ref_key);
                }
            }
        }
        let progressions = plan["mesocycle"]["domainProgressions"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut domain_phases = Vec::with_capacity(refs.len());
        for (domain, phase_id) in refs {
            let phase = progressions
                .iter()
                .find(|progression| progression["domain"].as_str() == Some(domain))
                .and_then(|progression| {
                    progression["phases"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
                        .iter()
                        .find(|phase| phase["id"].as_str() == Some(phase_id))
                });
            let Some(phase) = phase else {
                return Err(AthriaError::new(
                    AthriaErrorCode::InvalidData,
                    format!("plan is missing the `{domain}` phase `{phase_id}`"),
                ));
            };
            domain_phases.push(json!({ "domain": domain, "phaseId": phase_id, "phaseType": phase["phaseType"], "name": phase["name"] }));
        }
        let revision = self.store.schedule_revision(&self.owner_id)?;
        let profile = self.get_profile()?;
        Ok(json!({
            "nextTrainingDay": {
                "occurrenceId": next["occurrenceId"],
                "scheduledDate": next["scheduledDate"],
                "dayOfWeek": monday_weekday(string_field(next, "scheduledDate")),
                "weekNumber": next["weekNumber"],
                "domainPhases": Value::Array(domain_phases),
                "existingSessions": existing,
                "revision": revision,
                "timezone": string_field(&profile, "timezone"),
            },
            "reasonCode": Value::Null,
        }))
    }

    /// `getCalendar({ from?, to? })`: the display projection of every planned
    /// occurrence inside the window.
    pub fn get_calendar(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<Value>> {
        let from = from
            .map(|value| parse_date_input(value, "from"))
            .transpose()?;
        let to = to.map(|value| parse_date_input(value, "to")).transpose()?;
        if let (Some(from), Some(to)) = (&from, &to) {
            if from > to {
                return Err(AthriaError::new(
                    AthriaErrorCode::InvalidCalendarWindow,
                    "The calendar start date must not be after the end date.",
                ));
            }
        }
        let revision = self.store.schedule_revision(&self.owner_id)?;
        let profile = self.get_profile()?;
        let today = tz::local_date(&self.now_iso(), string_field(&profile, "timezone"))?;
        let mut sessions: Vec<Value> = self
            .store
            .list_current_planned_sessions(&self.owner_id, None)?
            .into_iter()
            .filter(|session| {
                let date = string_field(session, "scheduledDate");
                from.as_deref().map_or(true, |from| date >= from)
                    && to.as_deref().map_or(true, |to| date <= to)
            })
            .collect();
        sessions.sort_by(|left, right| {
            js_locale_compare(
                string_field(left, "scheduledDate"),
                string_field(right, "scheduledDate"),
            )
            .then_with(|| {
                left["order"]
                    .as_i64()
                    .unwrap_or(0)
                    .cmp(&right["order"].as_i64().unwrap_or(0))
            })
        });
        Ok(sessions
            .into_iter()
            .map(|session| {
                let status = session["status"].as_str().unwrap_or("planned");
                let display_state = if status == "completed" {
                    "completed"
                } else if status == "skipped" {
                    "skipped"
                } else if string_field(&session, "scheduledDate") < today.as_str() {
                    "unrecorded"
                } else {
                    "scheduled"
                };
                json!({
                    "id": session["id"],
                    "occurrenceId": session["occurrenceId"],
                    "revision": revision,
                    "scheduledDate": session["scheduledDate"],
                    "order": session["order"],
                    "weekNumber": session["weekNumber"],
                    "phaseRefs": session["phaseRefs"],
                    "templateRef": session["templateRef"],
                    "name": session["name"],
                    "intent": session["intent"],
                    "durationMinutes": session["durationMinutes"],
                    "recoveryDemand": session["recoveryDemand"],
                    "keySession": session["keySession"],
                    "progressionNote": session["progressionNote"],
                    "schedulingRationale": session["schedulingRationale"],
                    "status": session["status"],
                    "displayState": display_state,
                    "components": session["components"],
                    "legacySnapshot": session["legacySnapshot"],
                    "overrideReason": session["overrideReason"],
                    "completedTrainingSessionId": session["completedTrainingSessionId"],
                    "completedAt": session["completedAt"],
                    "completionSource": session["completionSource"],
                    "match": session["match"],
                })
            })
            .collect())
    }

    /// `updatePlannedSession(id, value)`: complete, skip, restore or move one
    /// occurrence.
    pub fn update_planned_session(&self, id: &str, value: &Value) -> Result<Value> {
        let input = parse_planned_session_action(value)?;
        let action = string_field(&input, "action").to_owned();
        let expected_revision = input["expectedRevision"].as_i64().unwrap_or(0);
        let Some(plan) = self.store.get_current_plan(&self.owner_id)? else {
            return Err(failure(
                AthriaErrorCode::NoCurrentPlan,
                "There is no current plan.",
                409,
            ));
        };
        let sessions = self
            .store
            .list_current_planned_sessions(&self.owner_id, None)?;
        let Some(current) = sessions
            .iter()
            .find(|session| session["id"].as_str() == Some(id))
        else {
            return Err(failure(
                AthriaErrorCode::PlannedSessionNotFound,
                "The planned session was not found.",
                404,
            ));
        };
        let timestamp = self.now_iso();
        let updates: Vec<Value>;
        if action == "complete" {
            if current["status"].as_str() != Some("planned") {
                return Err(failure(
                    AthriaErrorCode::PlannedSessionAlreadyResolved,
                    "Completed or skipped sessions cannot be added again.",
                    409,
                ));
            }
            let timezone = string_field(&self.get_profile()?, "timezone").to_owned();
            let scheduled_date = string_field(current, "scheduledDate");
            if scheduled_date > tz::local_date(&self.now_iso(), &timezone)?.as_str() {
                return Err(failure(
                    AthriaErrorCode::FutureSessionCannotBeCompleted,
                    "Move this planned session to the date you completed it before adding it as a completed workout.",
                    409,
                ));
            }
            let start_at = tz::local_noon(scheduled_date, &timezone)?;
            let duration_minutes = current["durationMinutes"].as_i64().unwrap_or(0);
            let end_at = tz::iso_from_millis(tz::millis(&start_at)? + duration_minutes * 60_000);
            let components = current["components"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let has_domain = |name: &str| {
                components
                    .iter()
                    .any(|component| component["domain"]["value"].as_str() == Some(name))
            };
            let modality = if has_domain("strength") {
                "strength"
            } else if has_domain("endurance") {
                "endurance"
            } else {
                "recovery"
            };
            let domains: Vec<Value> = components
                .iter()
                .filter_map(|component| {
                    component["domain"]["value"]
                        .as_str()
                        .map(|domain| Value::String(domain.to_owned()))
                })
                .collect();
            let session = self.record_training_session(&json!({
                "name": current["name"],
                "modality": modality,
                "domains": domains,
                "sport": Value::Null,
                "startAt": start_at,
                "endAt": end_at,
                "durationMinutes": duration_minutes,
                "timezone": timezone,
                "plannedSessionId": current["id"],
                "timePrecision": "date_only",
                "strengthSets": [],
                "endurance": Value::Null,
                "missingFields": ["actual start time", "exercise details"],
            }))?;
            let sessions: Vec<Value> = self
                .store
                .list_current_planned_sessions(&self.owner_id, None)?
                .into_iter()
                .filter(|session| session["id"].as_str() == Some(id))
                .collect();
            return Ok(
                json!({ "sessions": sessions, "revision": plan["revision"], "trainingSession": session }),
            );
        } else if action == "skip" {
            if current["status"].as_str() != Some("planned") {
                return Err(failure(
                    AthriaErrorCode::PlannedSessionAlreadyResolved,
                    "Completed or skipped sessions cannot be skipped.",
                    409,
                ));
            }
            updates = vec![session_with_status(current, "skipped", &timestamp)];
        } else if action == "restore" {
            if current["status"].as_str() != Some("skipped") {
                return Err(failure(
                    AthriaErrorCode::PlannedSessionNotSkipped,
                    "Only a skipped planned session can be restored.",
                    409,
                ));
            }
            updates = vec![session_with_status(current, "planned", &timestamp)];
        } else {
            if current["status"].as_str() != Some("planned") {
                return Err(failure(
                    AthriaErrorCode::PlannedSessionAlreadyResolved,
                    "Completed or skipped sessions must be unresolved before they can be moved.",
                    409,
                ));
            }
            let scheduled_date = string_field(&input, "scheduledDate").to_owned();
            if string_field(current, "scheduledDate") == scheduled_date {
                return Err(AthriaError::new(
                    AthriaErrorCode::InvalidMoveDate,
                    "Choose a different date for the planned session.",
                ));
            }
            let occurrence_id = string_field(current, "occurrenceId");
            if plan["mesocycle"]["schedule"]["kind"].as_str() != Some("interval")
                && sessions.iter().any(|session| {
                    session["status"].as_str() == Some("planned")
                        && session["occurrenceId"].as_str() != Some(occurrence_id)
                        && session["scheduledDate"].as_str() == Some(scheduled_date.as_str())
                })
            {
                return Err(failure(
                    AthriaErrorCode::TrainingDayConflict,
                    "Another planned training day already uses that date.",
                    409,
                ));
            }
            let effective_start = string_field(&plan, "effectiveStartDate");
            let plan_end = add_days(
                effective_start,
                plan["mesocycle"]["durationWeeks"].as_i64().unwrap_or(0) * 7 - 1,
            );
            if scheduled_date.as_str() < effective_start || scheduled_date > plan_end {
                return Err(failure(
                    AthriaErrorCode::MoveOutsidePlan,
                    "The moved training day must stay within the current plan.",
                    409,
                ));
            }
            let week_number = day_difference(effective_start, &scheduled_date).div_euclid(7) + 1;
            let mut moved = current.as_object().cloned().unwrap_or_default();
            moved.insert(
                "occurrenceId".into(),
                Value::String(Uuid::new_v4().to_string()),
            );
            moved.insert(
                "scheduledDate".into(),
                Value::String(scheduled_date.clone()),
            );
            moved.insert("weekNumber".into(), Value::from(week_number));
            moved.insert(
                "phaseRefs".into(),
                phase_refs_for_session(&plan, week_number, &current["components"])?,
            );
            moved.insert("updatedAt".into(), Value::String(timestamp.clone()));
            let moved = Value::Object(moved);
            let proposed: Vec<Value> = sessions
                .iter()
                .map(|session| {
                    if session["id"] == moved["id"] {
                        moved.clone()
                    } else {
                        session.clone()
                    }
                })
                .collect();
            if !planned_dates_follow_profile(&self.get_profile()?, &plan, &proposed) {
                return Err(failure(
                    AthriaErrorCode::ProfileTrainingRhythm,
                    "The moved training day would break your Profile training rhythm.",
                    409,
                ));
            }
            if let Some(required) = self.get_profile()?["explicitRecoveryDays"].as_i64() {
                let mut high_dates: Vec<&str> = proposed
                    .iter()
                    .filter(|session| {
                        session["status"].as_str() != Some("skipped")
                            && session["recoveryDemand"].as_str() == Some("high")
                    })
                    .filter_map(|session| session["scheduledDate"].as_str())
                    .collect();
                high_dates.sort_unstable();
                high_dates.dedup();
                for pair in high_dates.windows(2) {
                    if day_difference(pair[0], pair[1]).abs() < required {
                        return Err(failure(
                            AthriaErrorCode::ExplicitRecoveryInterval,
                            "The moved training day is too close to another high-recovery-demand session.",
                            409,
                        ));
                    }
                }
            }
            updates = vec![moved];
        }
        let reason = input
            .get("reason")
            .filter(|_| action == "skip" || action == "move_occurrence");
        let reason_code = reason.and_then(|reason| reason["reasonCode"].as_str());
        let reason_note = reason.and_then(|reason| reason["note"].as_str());
        self.store
            .update_current_planned_sessions(&UpdateCurrentPlannedSessionsInput {
                owner_id: &self.owner_id,
                expected_revision,
                mode: &action,
                sessions: &updates,
                reason_code,
                reason_note,
            })
            .map_err(|error| {
                if error.code() == AthriaErrorCode::PlannedSessionRevisionConflict {
                    failure(
                        AthriaErrorCode::PlannedSessionRevisionConflict,
                        "The planned sessions changed. Refresh and try again.",
                        409,
                    )
                } else {
                    error
                }
            })
    }

    /// `buildNextTrainingDaySessions(raw)`: the parsed write, its normalized
    /// occurrences and the next training day they belong to.
    fn build_next_training_day_sessions(&self, raw: &Value) -> Result<(Value, Vec<Value>, Value)> {
        let input = parse_next_training_day_write(raw)?;
        let next = self.get_next_training_day(None)?;
        let Some(next_day) = next["nextTrainingDay"]
            .as_object()
            .cloned()
            .map(Value::Object)
        else {
            let code = match next["reasonCode"].as_str() {
                Some("NO_CURRENT_PLAN") => AthriaErrorCode::NoCurrentPlan,
                Some("PLAN_ENDED") => AthriaErrorCode::PlanEnded,
                _ => AthriaErrorCode::NoNextTrainingDay,
            };
            return Err(failure(
                code,
                "There is no available next training day.",
                409,
            ));
        };
        let scheduled_date = string_field(&input, "scheduledDate").to_owned();
        if string_field(&next_day, "scheduledDate") != scheduled_date {
            return Err(failure(
                AthriaErrorCode::NextTrainingDayChanged,
                "Refresh the next training day before saving sessions.",
                409,
            ));
        }
        if next_day["revision"].as_i64() != input["expectedRevision"].as_i64() {
            return Err(failure(
                AthriaErrorCode::PlannedSessionRevisionConflict,
                "The planned sessions changed. Refresh and confirm the update again.",
                409,
            ));
        }
        let Some(plan) = self.store.get_current_plan(&self.owner_id)? else {
            return Err(failure(
                AthriaErrorCode::NoCurrentPlan,
                "There is no current plan.",
                409,
            ));
        };
        let timestamp = self.now_iso();
        let week_number = next_day["weekNumber"].as_i64().unwrap_or(0);
        let mut ids: HashSet<&str> = HashSet::new();
        let mut sessions = Vec::new();
        for (order, item) in input["sessions"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .enumerate()
        {
            let session_id = string_field(item, "id");
            if !ids.insert(session_id) {
                return Err(AthriaError::new(
                    AthriaErrorCode::DuplicatePlannedSessionId,
                    "Session IDs must be unique.",
                ));
            }
            let mut candidate = item.as_object().cloned().unwrap_or_default();
            candidate.insert(
                "scheduledDate".into(),
                Value::String(scheduled_date.clone()),
            );
            candidate.insert("order".into(), Value::from(order as i64));
            let mut mesocycle = plan["mesocycle"].clone();
            mesocycle["weeks"] = Value::Array(vec![
                json!({ "weekNumber": week_number, "focus": Value::Null, "sessions": [Value::Object(candidate)] }),
            ]);
            self.assert_template_references(&mesocycle)?;
            let mut candidate = item.as_object().cloned().unwrap_or_default();
            candidate.insert("occurrenceId".into(), next_day["occurrenceId"].clone());
            candidate.insert("ownerId".into(), Value::String(self.owner_id.clone()));
            candidate.insert("planRevision".into(), plan["revision"].clone());
            candidate.insert(
                "scheduledDate".into(),
                Value::String(scheduled_date.clone()),
            );
            candidate.insert("order".into(), Value::from(order as i64));
            candidate.insert("weekNumber".into(), Value::from(week_number));
            candidate.insert(
                "phaseRefs".into(),
                phase_refs_for_session(&plan, week_number, &item["components"])?,
            );
            candidate.insert("exerciseOverrides".into(), Value::Array(Vec::new()));
            candidate.insert("status".into(), Value::String("planned".into()));
            candidate.insert("completedTrainingSessionId".into(), Value::Null);
            candidate.insert("completedAt".into(), Value::Null);
            candidate.insert("completionSource".into(), Value::Null);
            candidate.insert("createdAt".into(), Value::String(timestamp.clone()));
            candidate.insert("updatedAt".into(), Value::String(timestamp.clone()));
            sessions.push(parse_planned_session(&Value::Object(candidate))?);
        }
        let profile = self.get_profile()?;
        if let Some(required) = profile["explicitRecoveryDays"].as_i64() {
            if sessions
                .iter()
                .any(|session| session["recoveryDemand"].as_str() == Some("high"))
            {
                let closest = self
                    .store
                    .list_current_planned_sessions(&self.owner_id, None)?
                    .iter()
                    .filter(|session| {
                        session["recoveryDemand"].as_str() == Some("high")
                            && session["status"].as_str() != Some("skipped")
                            && session["scheduledDate"].as_str() != Some(scheduled_date.as_str())
                    })
                    .filter_map(|session| session["scheduledDate"].as_str())
                    .map(|date| day_difference(date, &scheduled_date).abs())
                    .min();
                if closest.is_some_and(|closest| closest < required) {
                    return Err(failure(
                        AthriaErrorCode::ExplicitRecoveryInterval,
                        "The high-recovery-demand sessions are too close together.",
                        409,
                    ));
                }
            }
        }
        Ok((input, sessions, next_day))
    }

    /// `validateNextTrainingDaySessions(value)`.
    pub fn validate_next_training_day_sessions(&self, value: &Value) -> Result<Value> {
        let (_input, sessions, next_day) = self.build_next_training_day_sessions(value)?;
        Ok(
            json!({ "valid": true, "sessions": sessions, "revision": next_day["revision"], "scheduledDate": next_day["scheduledDate"] }),
        )
    }

    /// `saveNextTrainingDaySessions(value)`.
    pub fn save_next_training_day_sessions(&self, value: &Value) -> Result<Value> {
        let (input, sessions, _next_day) = self.build_next_training_day_sessions(value)?;
        self.store
            .save_current_planned_sessions(&SaveCurrentPlannedSessionsInput {
                owner_id: &self.owner_id,
                client_request_id: string_field(&input, "clientRequestId"),
                scheduled_date: string_field(&input, "scheduledDate"),
                expected_revision: input["expectedRevision"].as_i64().unwrap_or(0),
                mode: string_field(&input, "mode"),
                sessions: &sessions,
            })
            .map_err(|error| match error.code() {
                AthriaErrorCode::PlannedSessionRevisionConflict => failure(
                    AthriaErrorCode::PlannedSessionRevisionConflict,
                    "The planned sessions changed. Refresh and confirm the update again.",
                    409,
                ),
                AthriaErrorCode::CompletedSessionCannotBeReplaced => failure(
                    AthriaErrorCode::CompletedSessionCannotBeReplaced,
                    "Completed or skipped sessions cannot be replaced.",
                    409,
                ),
                _ => error,
            })
    }
}
