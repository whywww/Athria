//! `AthriaApplication`: the validated use cases every shell calls.
//!
//! Ported from `packages/application/src/index.ts`. Each method mirrors its
//! TypeScript counterpart: the same schema parse of raw input, the same
//! optimistic-concurrency checks, the same store calls in the same order, and
//! the same response documents.
//!
//! The schema normalizers in `athria_core::schema` reproduce the Zod *parse
//! output* — defaults applied, fields in schema declaration order, unknown keys
//! rejected, value types checked. Zod range refinements (`min`/`max` bounds,
//! the birth-date "not in the future" check) are transport-level validation and
//! land with the Tauri/CLI/MCP input schemas in Phase 7.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use athria_core::schema::{
    parse_personal_information, parse_profile, parse_profile_update, parse_session_template_create, parse_session_template_update, parse_wellness_record,
    merge_profile, template_variables, PersonalInformationWrite,
};
use athria_core::vocab::{DOMAIN_IDS, FACT_SOURCES, equipment_categories, equipment_type_ids, muscle_taxonomy, movement_pattern_taxonomy};
use athria_core::{AI_HARD_CONFIDENCE, AthriaError, AthriaErrorCode, Clock, DEFAULT_OWNER_ID, Result, SystemClock, TAXONOMY_VERSION, stable_hash, tz};
use serde_json::{Map, Value, json};

use crate::catalog::{builtin_session_templates, builtin_template};
use crate::store::AthriaStore;
use crate::{PLAN_SCHEMA_VERSION, TEMPLATE_CATALOG_VERSION};

/// A schema-guaranteed string field; missing fields are programming errors,
/// matching the TypeScript `undefined` dereference.
fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("expected `{key}` to be a string"))
}

/// `new AthriaError(code, message, status)`.
fn failure(code: AthriaErrorCode, message: &str, status: u16) -> AthriaError {
    AthriaError::new(code, message).with_status(status)
}

/// The `TEMPLATE_NOT_FOUND` / `REVISION_CONFLICT` store failures as the
/// application responses, re-throwing anything else untouched.
fn template_write_error(error: AthriaError) -> AthriaError {
    match error.code() {
        AthriaErrorCode::RevisionConflict => failure(AthriaErrorCode::RevisionConflict, "The template changed. Refresh and try again.", 409),
        AthriaErrorCode::TemplateNotFound => failure(AthriaErrorCode::TemplateNotFound, "The session template was not found.", 404),
        _ => error,
    }
}

/// The ids of every session in `plan` that references the user template `id`.
fn template_references(plan: &Value, id: &str) -> Vec<Value> {
    let mut references = Vec::new();
    for week in plan["mesocycle"]["weeks"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        for session in week["sessions"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            if session["templateRef"]["source"] == json!("user") && session["templateRef"]["id"] == json!(id) {
                references.push(session["id"].clone());
            }
        }
    }
    references
}

pub struct AthriaApplication<S: AthriaStore> {
    store: S,
    owner_id: String,
    clock: Rc<dyn Clock>,
}

impl<S: AthriaStore> AthriaApplication<S> {
    /// `new AthriaApplication(store)`: the local owner and the system clock.
    pub fn new(store: S) -> Self {
        Self::with_clock(store, DEFAULT_OWNER_ID, Rc::new(SystemClock))
    }

    /// The TypeScript constructor with an explicit `ownerId` and `now`.
    pub fn with_clock(store: S, owner_id: impl Into<String>, clock: Rc<dyn Clock>) -> Self {
        Self { store, owner_id: owner_id.into(), clock }
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
            return Err(failure(AthriaErrorCode::InputSnapshotChanged, "The athlete profile changed. Refresh before applying the confirmed update.", 409));
        }
        let merged = merge_profile(&self.get_profile()?, &update.patch, &self.owner_id)?;
        self.store.save_profile(&merged)
    }

    pub fn get_personal_information(&self) -> Result<Value> {
        let profile = self.get_profile()?;
        let today = tz::local_date(&self.now_iso(), string_field(&profile, "timezone"))?;
        let wellness = self.store.list_wellness(&self.owner_id, None)?;
        let latest_weight = wellness.iter().find(|record| !record["fields"]["weightKg"]["value"].is_null());
        let weight = match latest_weight {
            Some(record) => json!({ "weightKg": record["fields"]["weightKg"]["value"], "weightDate": record["day"] }),
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
        self.store.transaction(&mut || self.save_personal_information_inner(&input))
    }

    fn save_personal_information_inner(&self, input: &PersonalInformationWrite) -> Result<Value> {
        let current = self.get_personal_information()?;
        if Value::String(input.expected_snapshot_hash.clone()) != current["snapshotHash"] {
            return Err(failure(AthriaErrorCode::InputSnapshotChanged, "Personal information changed. Refresh before saving.", 409));
        }
        let profile = self.get_profile()?;
        let timezone = string_field(&profile, "timezone").to_owned();
        let mut patch = Map::new();
        patch.insert("preferredName".into(), Value::String(input.preferred_name.clone()));
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
            let mut fields = stored.as_ref().and_then(|record| record.get("fields")).and_then(Value::as_object).cloned().unwrap_or_default();
            if weight_kg.is_null() {
                fields.shift_remove("weightKg");
            } else {
                fields.insert("weightKg".into(), json!({ "value": weight_kg, "source": "user", "updatedAt": self.now_iso() }));
            }
            let record = parse_wellness_record(&json!({ "ownerId": self.owner_id, "day": day, "fields": Value::Object(fields), "updatedAt": self.now_iso() }))?;
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
        let dismissed: HashSet<String> = self.store.list_dismissed_template_ids(&self.owner_id)?.into_iter().collect();
        let user_by_id: HashMap<&str, &Value> = user.iter().filter_map(|row| row["id"].as_str().map(|id| (id, row))).collect();
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
        let builtin_ids: HashSet<&str> = builtins.iter().map(|item| string_field(item, "id")).collect();
        merged.extend(user.iter().filter(|row| !builtin_ids.contains(string_field(row, "id"))).cloned());
        Ok(merged)
    }

    pub fn get_template(&self, id: &str) -> Result<Value> {
        self.store
            .get_template(id, &self.owner_id)?
            .or_else(|| builtin_template(id))
            .ok_or_else(|| failure(AthriaErrorCode::TemplateNotFound, "The session template was not found.", 404))
    }

    pub fn create_template(&self, value: &Value) -> Result<Value> {
        let (template, _client_request_id) = parse_session_template_create(value)?;
        self.store.create_template(&template, &self.owner_id).map_err(|error| {
            if error.code() == AthriaErrorCode::TemplateAlreadyExists {
                failure(AthriaErrorCode::TemplateAlreadyExists, "A template with this ID already exists.", 409)
            } else {
                error
            }
        })
    }

    pub fn update_template(&self, value: &Value) -> Result<Value> {
        let (template, expected_revision) = parse_session_template_update(value)?;
        let template = self.store.update_template(&template, expected_revision, &self.owner_id).map_err(template_write_error)?;
        Ok(json!({ "template": template, "impact": { "affectedCount": 0, "updatedCount": 0 } }))
    }

    pub fn delete_template(&self, id: &str, expected_revision: Option<i64>) -> Result<Value> {
        // Deleting a built-in that has no derived row only hides it; the code-defined original
        // remains and existing plan references keep resolving against the catalog.
        if self.store.get_template(id, &self.owner_id)?.is_none() && builtin_template(id).is_some() {
            self.store.dismiss_template(id, &self.owner_id)?;
            return Ok(json!({ "deleted": true, "id": id }));
        }
        let references = self.store.get_current_plan(&self.owner_id)?.map(|plan| template_references(&plan, id)).unwrap_or_default();
        if !references.is_empty() {
            return Err(failure(AthriaErrorCode::TemplateInUse, "Remove this template reference from the current plan before deleting it.", 409));
        }
        let Some(expected_revision) = expected_revision else {
            return Err(failure(AthriaErrorCode::RevisionRequired, "expectedRevision is required to delete a stored template.", 400));
        };
        self.store.delete_template(id, expected_revision, &self.owner_id).map_err(template_write_error)?;
        // Removing the derived replacement of a built-in keeps that built-in hidden.
        if builtin_template(id).is_some() {
            self.store.dismiss_template(id, &self.owner_id)?;
        }
        Ok(json!({ "deleted": true, "id": id }))
    }
}
