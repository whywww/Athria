//! `currentPlanSchema`, `plannedSessionSchema`, and the nested plan shapes.
//!
//! Current-plan schema parsing and normalization, including the
//! application-level action schemas the plan use cases parse. A parsed plan is
//! the 12-key document the store writes into `current_mesocycles.data`; a
//! parsed planned session is the 29-key document the store writes into
//! `current_planned_sessions.data`. Both are rebuilt in schema declaration
//! order — including the `superRefine` hooks the TypeScript schemas run — so
//! stored JSON stays byte-compatible with TypeScript.

use serde_json::{Map, Value, json};

use super::common::*;
use crate::Result;
use crate::vocab::{DOMAIN_IDS, MOVEMENT_PATTERN_IDS, MUSCLE_GROUP_IDS};

/// `PLAN_SCHEMA_VERSION`.
pub const PLAN_SCHEMA_VERSION: &str = "7.0";

/// `factSourceSchema`. The taxonomy response advertises only four of these,
/// but plan facts may also be `catalog` (built-in plans) or `migration`.
const FACT_SOURCES: [&str; 6] = [
    "catalog",
    "structured_source",
    "exact_alias",
    "ai_inferred",
    "user_confirmed",
    "migration",
];
const IMPACTS: [&str; 3] = ["low", "moderate", "high"];
const LATERALITIES: [&str; 3] = ["bilateral", "unilateral", "alternating"];
const RECOVERY_DEMANDS: [&str; 3] = ["low", "normal", "high"];
const PHASE_TYPES: [&str; 6] = [
    "foundation",
    "progression",
    "deload",
    "peak",
    "test",
    "recovery",
];
const WEEKLY_STATUSES: [&str; 2] = ["planned", "skipped"];
const STEP_ROLES: [&str; 5] = ["warm_up", "steady", "work", "recovery", "cool_down"];
const SPORT_BLOCK_ROLES: [&str; 8] = [
    "preparation",
    "technical",
    "tactical",
    "small_sided_game",
    "match",
    "competition",
    "conditioning",
    "cool_down",
];
const SESSION_TYPES: [&str; 3] = ["practice", "match", "competition"];
const PRESCRIPTION_KINDS: [&str; 6] = [
    "strength",
    "endurance",
    "sport_skill",
    "recovery",
    "mind_body",
    "duration_only",
];
const SESSION_STATUSES: [&str; 3] = ["planned", "completed", "skipped"];
const DISPLAY_STATES: [&str; 4] = ["scheduled", "completed", "unrecorded", "skipped"];
const COMPLETION_SOURCES: [&str; 2] = ["manual", "import"];
const ACTION_KINDS: [&str; 4] = ["complete", "skip", "restore", "move_occurrence"];
const ACTION_REASON_CODES: [&str; 7] = [
    "schedule",
    "recovery",
    "health",
    "travel",
    "equipment_weather",
    "preference",
    "other",
];
const WEIGHT_UNITS: [&str; 2] = ["kg", "lb"];

/// `effortTargetShape` keys, in declaration order.
const EFFORT_KEYS: [&str; 9] = [
    "durationSeconds",
    "distanceMeters",
    "pace",
    "heartRateZone",
    "powerWatts",
    "cadence",
    "rpe",
    "talkTest",
    "notes",
];

/// `currentPlanWriteSchema.parse(value)`: the plan a planner sends, without
/// `revision`/`updatedAt` and with the expected revision appended.
pub fn parse_current_plan_write(value: &Value) -> Result<Value> {
    object(value, "plan")?;
    let mut plan = Map::new();
    insert_plan_head(&mut plan, value)?;
    insert_plan_metadata(&mut plan, value);
    insert_plan_target(&mut plan, value)?;
    plan.insert(
        "expectedRevision".into(),
        Value::from(required_int(value, "expectedRevision", "plan")?),
    );
    let plan = Value::Object(plan);
    validate_plan_sessions(&plan)?;
    Ok(plan)
}

/// `currentPlanSchema.parse(value)`: the stored document.
pub fn parse_current_plan(value: &Value) -> Result<Value> {
    object(value, "plan")?;
    let mut plan = Map::new();
    insert_plan_head(&mut plan, value)?;
    plan.insert(
        "revision".into(),
        Value::from(required_int(value, "revision", "plan")?),
    );
    insert_plan_metadata(&mut plan, value);
    plan.insert(
        "updatedAt".into(),
        Value::String(required_text(value, "updatedAt", "plan")?),
    );
    insert_plan_target(&mut plan, value)?;
    let plan = Value::Object(plan);
    validate_plan_sessions(&plan)?;
    Ok(plan)
}

/// `plannedSessionSchema.parse(value)`: the stored occurrence document.
pub fn parse_planned_session(value: &Value) -> Result<Value> {
    object(value, "plannedSession")?;
    let mut session = Map::new();
    session.insert(
        "id".into(),
        Value::String(required_text(value, "id", "plannedSession")?),
    );
    session.insert(
        "occurrenceId".into(),
        Value::String(required_text(value, "occurrenceId", "plannedSession")?),
    );
    session.insert(
        "ownerId".into(),
        Value::String(required_text(value, "ownerId", "plannedSession")?),
    );
    session.insert(
        "planRevision".into(),
        Value::from(required_int(value, "planRevision", "plannedSession")?),
    );
    session.insert(
        "scheduledDate".into(),
        Value::String(required_date(value, "scheduledDate", "plannedSession")?),
    );
    session.insert("order".into(), int_or(value, "order", 0));
    session.insert(
        "weekNumber".into(),
        Value::from(required_int(value, "weekNumber", "plannedSession")?),
    );
    session.insert(
        "phaseRefs".into(),
        parse_phase_refs(value, "plannedSession")?,
    );
    session.insert(
        "templateRef".into(),
        parse_template_ref_or_null(value, "templateRef", "plannedSession")?,
    );
    session.insert(
        "name".into(),
        Value::String(required_text(value, "name", "plannedSession")?),
    );
    session.insert(
        "intent".into(),
        Value::String(required_text(value, "intent", "plannedSession")?),
    );
    session.insert(
        "recoveryDemand".into(),
        Value::String(required_enum(
            value,
            "recoveryDemand",
            &RECOVERY_DEMANDS,
            "plannedSession",
        )?),
    );
    session.insert(
        "durationMinutes".into(),
        Value::from(required_int(value, "durationMinutes", "plannedSession")?),
    );
    session.insert(
        "keySession".into(),
        Value::Bool(
            value
                .get("keySession")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    session.insert(
        "components".into(),
        parse_components(value, "plannedSession")?,
    );
    session.insert(
        "progressionNote".into(),
        text_or_null(value, "progressionNote"),
    );
    session.insert(
        "schedulingRationale".into(),
        text_or_null(value, "schedulingRationale"),
    );
    session.insert(
        "exerciseOverrides".into(),
        parse_exercise_overrides(value, "plannedSession")?,
    );
    session.insert(
        "legacySnapshot".into(),
        Value::Bool(
            value
                .get("legacySnapshot")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    session.insert("notes".into(), Value::String(text_or(value, "notes", "")));
    session.insert(
        "overrideReason".into(),
        text_or_null(value, "overrideReason"),
    );
    session.insert(
        "status".into(),
        Value::String(enum_or(value, "status", &SESSION_STATUSES, "planned")),
    );
    session.insert(
        "displayState".into(),
        Value::String(enum_or(value, "displayState", &DISPLAY_STATES, "scheduled")),
    );
    session.insert(
        "completedTrainingSessionId".into(),
        text_or_null(value, "completedTrainingSessionId"),
    );
    session.insert("completedAt".into(), text_or_null(value, "completedAt"));
    session.insert(
        "completionSource".into(),
        nullable_enum(value, "completionSource", &COMPLETION_SOURCES),
    );
    session.insert("match".into(), match_summary_or_null(value, "match"));
    session.insert(
        "createdAt".into(),
        Value::String(required_text(value, "createdAt", "plannedSession")?),
    );
    session.insert(
        "updatedAt".into(),
        Value::String(required_text(value, "updatedAt", "plannedSession")?),
    );
    let session = Value::Object(session);
    validate_phase_refs(&session)?;
    Ok(session)
}

/// `nextTrainingDayWriteSchema.parse(value)`.
pub fn parse_next_training_day_write(value: &Value) -> Result<Value> {
    object(value, "nextTrainingDay")?;
    let mut write = Map::new();
    write.insert(
        "clientRequestId".into(),
        Value::String(required_text(value, "clientRequestId", "nextTrainingDay")?),
    );
    write.insert(
        "scheduledDate".into(),
        Value::String(required_date(value, "scheduledDate", "nextTrainingDay")?),
    );
    write.insert(
        "expectedRevision".into(),
        Value::from(required_int(value, "expectedRevision", "nextTrainingDay")?),
    );
    write.insert(
        "mode".into(),
        Value::String(required_enum(
            value,
            "mode",
            &["append", "replace"],
            "nextTrainingDay",
        )?),
    );
    let sessions = array(get(value, "sessions"), "nextTrainingDay.sessions")?;
    let mut parsed = Vec::with_capacity(sessions.len());
    for (index, session) in sessions.iter().enumerate() {
        parsed.push(parse_planned_session_input(
            session,
            &format!("nextTrainingDay.sessions.{index}"),
        )?);
    }
    write.insert("sessions".into(), Value::Array(parsed));
    Ok(Value::Object(write))
}

/// `plannedSessionActionSchema.parse(value)`.
pub fn parse_planned_session_action(value: &Value) -> Result<Value> {
    object(value, "action")?;
    let action = required_enum(value, "action", &ACTION_KINDS, "action")?;
    let mut parsed = Map::new();
    parsed.insert("action".into(), Value::String(action.clone()));
    parsed.insert(
        "expectedRevision".into(),
        Value::from(required_int(value, "expectedRevision", "action")?),
    );
    if action == "move_occurrence" {
        parsed.insert(
            "scheduledDate".into(),
            Value::String(required_date(value, "scheduledDate", "action")?),
        );
    }
    if matches!(action.as_str(), "skip" | "move_occurrence") {
        if let Some(reason) = value.get("reason").filter(|item| item.is_object()) {
            parsed.insert(
                "reason".into(),
                parse_action_reason(reason, "action.reason")?,
            );
        }
    }
    Ok(Value::Object(parsed))
}

fn parse_action_reason(value: &Value, path: &str) -> Result<Value> {
    let mut reason = Map::new();
    reason.insert(
        "reasonCode".into(),
        Value::String(required_enum(
            value,
            "reasonCode",
            &ACTION_REASON_CODES,
            path,
        )?),
    );
    if let Some(note) = value.get("note").and_then(Value::as_str) {
        reason.insert("note".into(), Value::String(note.trim().to_owned()));
    }
    Ok(Value::Object(reason))
}

/// The keys shared by both plan schemas, through `mesocycle`.
fn insert_plan_head(plan: &mut Map<String, Value>, value: &Value) -> Result<()> {
    let schema_version = required_text(value, "planSchemaVersion", "plan")?;
    if schema_version != PLAN_SCHEMA_VERSION {
        return Err(invalid(
            "plan.planSchemaVersion",
            "expected the current plan schema version",
        ));
    }
    plan.insert("planSchemaVersion".into(), Value::String(schema_version));
    plan.insert(
        "ownerId".into(),
        Value::String(text_or(value, "ownerId", crate::DEFAULT_OWNER_ID)),
    );
    plan.insert(
        "title".into(),
        Value::String(required_text(value, "title", "plan")?),
    );
    plan.insert(
        "summary".into(),
        Value::String(text_or(value, "summary", "")),
    );
    plan.insert(
        "effectiveStartDate".into(),
        Value::String(required_date(value, "effectiveStartDate", "plan")?),
    );
    plan.insert(
        "mesocycle".into(),
        parse_mesocycle(get(value, "mesocycle"), "plan.mesocycle")?,
    );
    Ok(())
}

fn insert_plan_metadata(plan: &mut Map<String, Value>, value: &Value) {
    plan.insert("sourceAgent".into(), text_or_null(value, "sourceAgent"));
    plan.insert("model".into(), text_or_null(value, "model"));
    plan.insert("skillVersion".into(), text_or_null(value, "skillVersion"));
    plan.insert(
        "inputSnapshotHash".into(),
        text_or_null(value, "inputSnapshotHash"),
    );
}

fn insert_plan_target(plan: &mut Map<String, Value>, value: &Value) -> Result<()> {
    if let Some(target) = value.get("target").filter(|item| item.is_object()) {
        plan.insert("target".into(), parse_plan_target(target, "plan.target")?);
    }
    Ok(())
}

/// `currentPlanSchema`'s `superRefine`: session ids are unique across the
/// mesocycle and every session date falls inside its plan week.
fn validate_plan_sessions(plan: &Value) -> Result<()> {
    let weeks = plan["mesocycle"]["weeks"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ids: Vec<String> = weeks
        .iter()
        .flat_map(|week| week["sessions"].as_array().cloned().unwrap_or_default())
        .filter_map(|session| session.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    if !unique(&ids) {
        return Err(invalid(
            "plan.mesocycle.weeks",
            "session ids must be unique across the mesocycle",
        ));
    }
    let start = plan["effectiveStartDate"].as_str().unwrap_or_default();
    let duration_weeks = plan["mesocycle"]["durationWeeks"].as_i64().unwrap_or(0);
    for week in &weeks {
        let week_number = week["weekNumber"].as_i64().unwrap_or(0);
        for session in week["sessions"].as_array().cloned().unwrap_or_default() {
            let scheduled_date = session["scheduledDate"].as_str().unwrap_or_default();
            let elapsed = crate::date::day_difference(start, scheduled_date);
            if elapsed < 0 || elapsed >= duration_weeks * 7 || elapsed / 7 + 1 != week_number {
                return Err(invalid(
                    &format!("plan.mesocycle.weeks.{}.sessions", week_number - 1),
                    "session date must fall inside its plan week",
                ));
            }
        }
    }
    Ok(())
}

/// `mesocycleSchema.parse(value)`.
pub fn parse_mesocycle(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let duration_weeks = required_int(value, "durationWeeks", path)?;
    let mut mesocycle = Map::new();
    mesocycle.insert("durationWeeks".into(), Value::from(duration_weeks));
    let schedule = value
        .get("schedule")
        .ok_or_else(|| invalid_type(&format!("{path}.schedule"), "an object"))?;
    mesocycle.insert(
        "schedule".into(),
        crate::schema::profile::parse_training_rhythm(Some(schedule))?,
    );
    mesocycle.insert(
        "domainProgressions".into(),
        parse_domain_progressions(value, path)?,
    );
    mesocycle.insert("weeks".into(), parse_weeks(value, path)?);
    mesocycle.insert(
        "adjustmentRules".into(),
        parse_adjustment_rules(value, path)?,
    );
    let mesocycle = Value::Object(mesocycle);
    validate_mesocycle(&mesocycle, duration_weeks, path)?;
    Ok(mesocycle)
}

/// `mesocycleSchema`'s `superRefine`.
fn validate_mesocycle(mesocycle: &Value, duration_weeks: i64, path: &str) -> Result<()> {
    let progressions = mesocycle["domainProgressions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let domains: Vec<String> = progressions
        .iter()
        .filter_map(|item| item["domain"].as_str().map(str::to_owned))
        .collect();
    if !unique(&domains) {
        return Err(invalid(
            &format!("{path}.domainProgressions"),
            "progression domains must be unique",
        ));
    }
    for progression in &progressions {
        let phases = progression["phases"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut sorted: Vec<&Value> = phases.iter().collect();
        sorted.sort_by_key(|phase| phase["startWeek"].as_i64().unwrap_or(0));
        let ids: Vec<&str> = sorted
            .iter()
            .filter_map(|phase| phase["id"].as_str())
            .collect();
        let contiguous = unique(&ids)
            && sorted.first().and_then(|phase| phase["startWeek"].as_i64()) == Some(1)
            && sorted.last().and_then(|phase| phase["endWeek"].as_i64()) == Some(duration_weeks)
            && sorted.iter().enumerate().all(|(index, phase)| {
                let start = phase["startWeek"].as_i64().unwrap_or(0);
                let end = phase["endWeek"].as_i64().unwrap_or(0);
                start <= end
                    && end <= duration_weeks
                    && (index == 0
                        || Some(start)
                            == sorted[index - 1]["endWeek"]
                                .as_i64()
                                .map(|previous| previous + 1))
            });
        if !contiguous {
            return Err(invalid(
                &format!("{path}.domainProgressions"),
                "domain phases must uniquely and contiguously cover the mesocycle",
            ));
        }
    }
    let weeks = mesocycle["weeks"].as_array().cloned().unwrap_or_default();
    let week_numbers: Vec<i64> = weeks
        .iter()
        .filter_map(|week| week["weekNumber"].as_i64())
        .collect();
    if !unique(&week_numbers) {
        return Err(invalid(
            &format!("{path}.weeks"),
            "week numbers must be unique",
        ));
    }
    let mut ordered = week_numbers.clone();
    ordered.sort_unstable();
    if ordered.len() as i64 != duration_weeks
        || ordered
            .iter()
            .enumerate()
            .any(|(index, week)| *week != index as i64 + 1)
    {
        return Err(invalid(
            &format!("{path}.weeks"),
            "weeks must cover the complete mesocycle",
        ));
    }
    let mut session_domains: Vec<String> = Vec::new();
    for week in &weeks {
        for session in week["sessions"].as_array().cloned().unwrap_or_default() {
            for component in session["components"]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                if let Some(domain) = component["domain"]["value"].as_str() {
                    if !session_domains.iter().any(|existing| existing == domain) {
                        session_domains.push(domain.to_owned());
                    }
                }
            }
        }
    }
    if session_domains.len() != domains.len()
        || domains
            .iter()
            .any(|domain| !session_domains.contains(domain))
    {
        return Err(invalid(
            &format!("{path}.domainProgressions"),
            "domain progressions must exactly match resolved session domains",
        ));
    }
    Ok(())
}

/// `planWeekSchema.parse(value)`.
fn parse_week(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut week = Map::new();
    week.insert(
        "weekNumber".into(),
        Value::from(required_int(value, "weekNumber", path)?),
    );
    week.insert("focus".into(), text_or_null(value, "focus"));
    let sessions = array(get(value, "sessions"), &format!("{path}.sessions"))?;
    let mut parsed = Vec::with_capacity(sessions.len());
    for (index, session) in sessions.iter().enumerate() {
        parsed.push(parse_weekly_session(
            session,
            &format!("{path}.sessions.{index}"),
        )?);
    }
    week.insert("sessions".into(), Value::Array(parsed));
    let week = Value::Object(week);
    let sessions = week["sessions"].as_array().cloned().unwrap_or_default();
    let ids: Vec<String> = sessions
        .iter()
        .filter_map(|session| session["id"].as_str().map(str::to_owned))
        .collect();
    if !unique(&ids) {
        return Err(invalid(
            &format!("{path}.sessions"),
            "session ids must be unique within a week",
        ));
    }
    let order_keys: Vec<String> = sessions
        .iter()
        .map(|session| {
            format!(
                "{}:{}",
                session["scheduledDate"].as_str().unwrap_or_default(),
                session["order"].as_i64().unwrap_or(0)
            )
        })
        .collect();
    if !unique(&order_keys) {
        return Err(invalid(
            &format!("{path}.sessions"),
            "session order must be unique within a date",
        ));
    }
    Ok(week)
}

fn parse_weeks(value: &Value, path: &str) -> Result<Value> {
    let weeks = array(get(value, "weeks"), &format!("{path}.weeks"))?;
    let mut parsed = Vec::with_capacity(weeks.len());
    for (index, week) in weeks.iter().enumerate() {
        parsed.push(parse_week(week, &format!("{path}.weeks.{index}"))?);
    }
    Ok(Value::Array(parsed))
}

/// `weeklySessionSchema.parse(value)`.
fn parse_weekly_session(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut session = Map::new();
    session.insert(
        "id".into(),
        Value::String(required_text(value, "id", path)?),
    );
    session.insert(
        "scheduledDate".into(),
        Value::String(required_date(value, "scheduledDate", path)?),
    );
    session.insert(
        "order".into(),
        Value::from(required_int(value, "order", path)?),
    );
    session.insert(
        "status".into(),
        Value::String(enum_or(value, "status", &WEEKLY_STATUSES, "planned")),
    );
    session.insert(
        "templateRef".into(),
        parse_template_ref_or_null(value, "templateRef", path)?,
    );
    session.insert(
        "name".into(),
        Value::String(required_text(value, "name", path)?),
    );
    session.insert(
        "intent".into(),
        Value::String(required_text(value, "intent", path)?),
    );
    session.insert(
        "durationMinutes".into(),
        Value::from(required_int(value, "durationMinutes", path)?),
    );
    session.insert(
        "recoveryDemand".into(),
        Value::String(enum_or(
            value,
            "recoveryDemand",
            &RECOVERY_DEMANDS,
            "normal",
        )),
    );
    session.insert(
        "keySession".into(),
        Value::Bool(
            value
                .get("keySession")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    session.insert("components".into(), parse_components(value, path)?);
    session.insert(
        "progressionNote".into(),
        text_or_null(value, "progressionNote"),
    );
    session.insert(
        "schedulingRationale".into(),
        text_or_null(value, "schedulingRationale"),
    );
    session.insert(
        "legacySnapshot".into(),
        Value::Bool(
            value
                .get("legacySnapshot")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    Ok(Value::Object(session))
}

/// `plannedSessionInputSchema.parse(value)` (a weekly session without
/// `scheduledDate`/`order`, plus the derived-write fields).
fn parse_planned_session_input(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut session = Map::new();
    session.insert(
        "id".into(),
        Value::String(required_text(value, "id", path)?),
    );
    session.insert(
        "status".into(),
        Value::String(enum_or(value, "status", &WEEKLY_STATUSES, "planned")),
    );
    session.insert(
        "templateRef".into(),
        parse_template_ref_or_null(value, "templateRef", path)?,
    );
    session.insert(
        "name".into(),
        Value::String(required_text(value, "name", path)?),
    );
    session.insert(
        "intent".into(),
        Value::String(required_text(value, "intent", path)?),
    );
    session.insert(
        "durationMinutes".into(),
        Value::from(required_int(value, "durationMinutes", path)?),
    );
    session.insert(
        "recoveryDemand".into(),
        Value::String(enum_or(
            value,
            "recoveryDemand",
            &RECOVERY_DEMANDS,
            "normal",
        )),
    );
    session.insert(
        "keySession".into(),
        Value::Bool(
            value
                .get("keySession")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    session.insert("components".into(), parse_components(value, path)?);
    session.insert(
        "progressionNote".into(),
        text_or_null(value, "progressionNote"),
    );
    session.insert(
        "schedulingRationale".into(),
        text_or_null(value, "schedulingRationale"),
    );
    session.insert(
        "legacySnapshot".into(),
        Value::Bool(
            value
                .get("legacySnapshot")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    session.insert("notes".into(), Value::String(text_or(value, "notes", "")));
    if let Some(reason) = value.get("overrideReason").and_then(Value::as_str) {
        session.insert("overrideReason".into(), Value::String(reason.to_owned()));
    }
    Ok(Value::Object(session))
}

/// `trainingComponentSchema.parse(value)`.
fn parse_component(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut component = Map::new();
    component.insert(
        "id".into(),
        Value::String(required_text(value, "id", path)?),
    );
    component.insert(
        "name".into(),
        Value::String(required_text(value, "name", path)?),
    );
    component.insert(
        "domain".into(),
        parse_fact(
            get(value, "domain"),
            &format!("{path}.domain"),
            nullable_domain_value,
        )?,
    );
    let prescription =
        parse_prescription(get(value, "prescription"), &format!("{path}.prescription"))?;
    let kind = prescription["kind"].as_str().unwrap_or_default().to_owned();
    let domain = component["domain"]["value"].as_str();
    let mismatch = match kind.as_str() {
        "strength" => domain != Some("strength"),
        "duration_only" => domain == Some("strength"),
        _ => domain != Some(kind.as_str()),
    };
    if mismatch {
        let message = match kind.as_str() {
            "strength" => "strength prescription requires strength domain".to_owned(),
            "duration_only" => "strength domain requires strength prescription".to_owned(),
            other => format!("{other} prescription requires matching domain"),
        };
        return Err(invalid(&format!("{path}.domain.value"), &message));
    }
    component.insert("prescription".into(), prescription);
    Ok(Value::Object(component))
}

fn parse_components(value: &Value, path: &str) -> Result<Value> {
    let components = array(get(value, "components"), &format!("{path}.components"))?;
    let mut parsed = Vec::with_capacity(components.len());
    for (index, component) in components.iter().enumerate() {
        parsed.push(parse_component(
            component,
            &format!("{path}.components.{index}"),
        )?);
    }
    Ok(Value::Array(parsed))
}

/// `prescription: z.discriminatedUnion("kind", ...)`.
fn parse_prescription(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let kind = required_enum(value, "kind", &PRESCRIPTION_KINDS, path)?;
    let mut prescription = Map::new();
    prescription.insert("kind".into(), Value::String(kind.clone()));
    match kind.as_str() {
        "strength" => {
            let exercises = array(get(value, "exercises"), &format!("{path}.exercises"))?;
            let mut parsed = Vec::with_capacity(exercises.len());
            for (index, exercise) in exercises.iter().enumerate() {
                parsed.push(parse_plan_exercise(
                    exercise,
                    &format!("{path}.exercises.{index}"),
                )?);
            }
            prescription.insert("exercises".into(), Value::Array(parsed));
        }
        "duration_only" => {
            prescription.insert("notes".into(), Value::String(text_or(value, "notes", "")));
        }
        "endurance" => {
            let segments = array(get(value, "segments"), &format!("{path}.segments"))?;
            let mut parsed = Vec::with_capacity(segments.len());
            for (index, segment) in segments.iter().enumerate() {
                parsed.push(parse_segment(segment, &format!("{path}.segments.{index}"))?);
            }
            prescription.insert("segments".into(), Value::Array(parsed));
        }
        "sport_skill" => {
            prescription.insert(
                "sessionType".into(),
                Value::String(required_enum(value, "sessionType", &SESSION_TYPES, path)?),
            );
            prescription.insert(
                "blocks".into(),
                parse_blocks(value, path, parse_sport_block)?,
            );
        }
        _ => {
            prescription.insert(
                "blocks".into(),
                parse_blocks(value, path, parse_recovery_block)?,
            );
        }
    }
    Ok(Value::Object(prescription))
}

/// `planExerciseSchema.parse(value)`.
fn parse_plan_exercise(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut exercise = Map::new();
    exercise.insert(
        "id".into(),
        Value::String(required_text(value, "id", path)?),
    );
    exercise.insert(
        "displayName".into(),
        Value::String(required_text(value, "displayName", path)?),
    );
    exercise.insert("canonicalKey".into(), text_or_null(value, "canonicalKey"));
    exercise.insert(
        "classification".into(),
        parse_classification(
            get(value, "classification"),
            &format!("{path}.classification"),
        )?,
    );
    exercise.insert(
        "sets".into(),
        Value::from(required_int(value, "sets", path)?),
    );
    exercise.insert(
        "repsMin".into(),
        Value::from(required_int(value, "repsMin", path)?),
    );
    exercise.insert(
        "repsMax".into(),
        Value::from(required_int(value, "repsMax", path)?),
    );
    exercise.insert("targetRpe".into(), number_or_null(value, "targetRpe"));
    if let Some(rir) = value.get("targetRir") {
        exercise.insert("targetRir".into(), rir.clone());
    }
    exercise.insert("restSeconds".into(), int_or(value, "restSeconds", 90));
    exercise.insert(
        "referenceLoad".into(),
        number_or_null(value, "referenceLoad"),
    );
    exercise.insert(
        "referenceLoadUnit".into(),
        nullable_enum(value, "referenceLoadUnit", &WEIGHT_UNITS),
    );
    if let Some(tempo) = value.get("tempo") {
        exercise.insert("tempo".into(), tempo.clone());
    }
    if let Some(alternatives) = value.get("alternatives") {
        exercise.insert("alternatives".into(), alternatives.clone());
    }
    exercise.insert("notes".into(), Value::String(text_or(value, "notes", "")));
    let exercise = Value::Object(exercise);
    if exercise["repsMax"].as_i64().unwrap_or(0) < exercise["repsMin"].as_i64().unwrap_or(0) {
        return Err(invalid(
            &format!("{path}.repsMax"),
            "repsMax must be >= repsMin",
        ));
    }
    Ok(exercise)
}

fn parse_classification(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut classification = Map::new();
    classification.insert(
        "primaryMovement".into(),
        parse_fact(
            get(value, "primaryMovement"),
            &format!("{path}.primaryMovement"),
            nullable_movement_value,
        )?,
    );
    classification.insert(
        "primaryMuscles".into(),
        parse_fact(
            get(value, "primaryMuscles"),
            &format!("{path}.primaryMuscles"),
            muscle_list_value,
        )?,
    );
    classification.insert(
        "secondaryMuscles".into(),
        parse_fact(
            get(value, "secondaryMuscles"),
            &format!("{path}.secondaryMuscles"),
            muscle_list_value,
        )?,
    );
    classification.insert(
        "equipment".into(),
        parse_fact(
            get(value, "equipment"),
            &format!("{path}.equipment"),
            equipment_list_value,
        )?,
    );
    classification.insert(
        "impact".into(),
        parse_fact(
            get(value, "impact"),
            &format!("{path}.impact"),
            nullable_impact_value,
        )?,
    );
    classification.insert(
        "laterality".into(),
        parse_fact(
            get(value, "laterality"),
            &format!("{path}.laterality"),
            nullable_laterality_value,
        )?,
    );
    Ok(Value::Object(classification))
}

/// `classifiedFact(value)`: `read_value` parses the `value` field for the
/// fact's type.
fn parse_fact(value: &Value, path: &str, read_value: fn(&Value) -> Value) -> Result<Value> {
    object(value, path)?;
    let mut fact = Map::new();
    fact.insert("value".into(), read_value(value));
    fact.insert(
        "source".into(),
        Value::String(required_enum(value, "source", &FACT_SOURCES, path)?),
    );
    let confidence = value
        .get("confidence")
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid_type(&format!("{path}.confidence"), "a number"))?;
    fact.insert("confidence".into(), crate::js_number(confidence));
    fact.insert(
        "evidence".into(),
        Value::String(required_text(value, "evidence", path)?),
    );
    fact.insert(
        "taxonomyVersion".into(),
        Value::String(crate::TAXONOMY_VERSION.to_owned()),
    );
    if let Some(conflicts) = value.get("conflicts").and_then(Value::as_array) {
        let mut parsed = Vec::with_capacity(conflicts.len());
        for (index, conflict) in conflicts.iter().enumerate() {
            let conflict_path = format!("{path}.conflicts.{index}");
            object(conflict, &conflict_path)?;
            parsed.push(json!({
                "source": required_enum(conflict, "source", &FACT_SOURCES, &conflict_path)?,
                "value": conflict.get("value").cloned().unwrap_or(Value::Null),
                "evidence": required_text(conflict, "evidence", &conflict_path)?,
            }));
        }
        fact.insert("conflicts".into(), Value::Array(parsed));
    }
    Ok(Value::Object(fact))
}

fn nullable_domain_value(fact: &Value) -> Value {
    nullable_enum(fact, "value", &DOMAIN_IDS)
}

fn nullable_movement_value(fact: &Value) -> Value {
    nullable_enum(fact, "value", &MOVEMENT_PATTERN_IDS)
}

fn nullable_impact_value(fact: &Value) -> Value {
    nullable_enum(fact, "value", &IMPACTS)
}

fn nullable_laterality_value(fact: &Value) -> Value {
    nullable_enum(fact, "value", &LATERALITIES)
}

fn muscle_list_value(fact: &Value) -> Value {
    enum_array_or(fact, "value", &MUSCLE_GROUP_IDS, &[])
}

fn equipment_list_value(fact: &Value) -> Value {
    enum_array_or(fact, "value", &crate::vocab::equipment_type_ids(), &[])
}

/// `enduranceStepSchema` / `enduranceRepeatSchema` under a `type` tag.
fn parse_segment(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    match value.get("type").and_then(Value::as_str) {
        Some("step") => parse_step(value, path),
        Some("repeat") => {
            let mut repeat = Map::new();
            repeat.insert("type".into(), Value::String("repeat".into()));
            repeat.insert(
                "name".into(),
                Value::String(required_text(value, "name", path)?),
            );
            repeat.insert(
                "repetitions".into(),
                Value::from(required_int(value, "repetitions", path)?),
            );
            repeat.insert(
                "work".into(),
                parse_step(get(value, "work"), &format!("{path}.work"))?,
            );
            if let Some(recovery) = value.get("recovery").filter(|item| item.is_object()) {
                repeat.insert(
                    "recovery".into(),
                    parse_step(recovery, &format!("{path}.recovery"))?,
                );
            }
            if let Some(notes) = value.get("notes").and_then(Value::as_str) {
                repeat.insert("notes".into(), Value::String(notes.to_owned()));
            }
            Ok(Value::Object(repeat))
        }
        _ => Err(invalid(
            &format!("{path}.type"),
            "expected a step or a repeat",
        )),
    }
}

/// `enduranceStepSchema.parse(value)`: `type`, `name`, `role`, then the
/// optional effort targets that are present.
fn parse_step(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    if value.get("type").and_then(Value::as_str) != Some("step") {
        return Err(invalid(&format!("{path}.type"), "expected a step"));
    }
    let mut step = Map::new();
    step.insert("type".into(), Value::String("step".into()));
    step.insert(
        "name".into(),
        Value::String(required_text(value, "name", path)?),
    );
    step.insert(
        "role".into(),
        Value::String(required_enum(value, "role", &STEP_ROLES, path)?),
    );
    for key in EFFORT_KEYS {
        if let Some(entry) = value.get(key) {
            step.insert(key.into(), entry.clone());
        }
    }
    Ok(Value::Object(step))
}

fn parse_blocks(
    value: &Value,
    path: &str,
    parse_block: fn(&Value, &str) -> Result<Value>,
) -> Result<Value> {
    let blocks = array(get(value, "blocks"), &format!("{path}.blocks"))?;
    let mut parsed = Vec::with_capacity(blocks.len());
    for (index, block) in blocks.iter().enumerate() {
        parsed.push(parse_block(block, &format!("{path}.blocks.{index}"))?);
    }
    Ok(Value::Array(parsed))
}

/// `sportBlockSchema.parse(value)`.
fn parse_sport_block(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut block = Map::new();
    block.insert(
        "name".into(),
        Value::String(required_text(value, "name", path)?),
    );
    block.insert(
        "role".into(),
        Value::String(required_enum(value, "role", &SPORT_BLOCK_ROLES, path)?),
    );
    for key in ["durationMinutes", "intensity", "instructions"] {
        if let Some(entry) = value.get(key) {
            block.insert(key.into(), entry.clone());
        }
    }
    Ok(Value::Object(block))
}

/// `recoveryBlockSchema.parse(value)`.
fn parse_recovery_block(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut block = Map::new();
    block.insert(
        "name".into(),
        Value::String(required_text(value, "name", path)?),
    );
    for key in ["durationMinutes", "instructions"] {
        if let Some(entry) = value.get(key) {
            block.insert(key.into(), entry.clone());
        }
    }
    Ok(Value::Object(block))
}

fn parse_domain_progressions(value: &Value, path: &str) -> Result<Value> {
    let Some(progressions) = value.get("domainProgressions").and_then(Value::as_array) else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut parsed = Vec::with_capacity(progressions.len());
    for (index, progression) in progressions.iter().enumerate() {
        let progression_path = format!("{path}.domainProgressions.{index}");
        object(progression, &progression_path)?;
        let mut entry = Map::new();
        entry.insert(
            "domain".into(),
            Value::String(required_enum(
                progression,
                "domain",
                &DOMAIN_IDS,
                &progression_path,
            )?),
        );
        let phases = array(
            get(progression, "phases"),
            &format!("{progression_path}.phases"),
        )?;
        let mut parsed_phases = Vec::with_capacity(phases.len());
        for (phase_index, phase) in phases.iter().enumerate() {
            parsed_phases.push(parse_domain_phase(
                phase,
                &format!("{progression_path}.phases.{phase_index}"),
            )?);
        }
        entry.insert("phases".into(), Value::Array(parsed_phases));
        parsed.push(Value::Object(entry));
    }
    Ok(Value::Array(parsed))
}

/// `domainPhaseSchema.parse(value)`.
fn parse_domain_phase(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut phase = Map::new();
    phase.insert(
        "id".into(),
        Value::String(required_text(value, "id", path)?),
    );
    phase.insert(
        "phaseType".into(),
        Value::String(required_enum(value, "phaseType", &PHASE_TYPES, path)?),
    );
    phase.insert(
        "name".into(),
        Value::String(required_text(value, "name", path)?),
    );
    phase.insert(
        "startWeek".into(),
        Value::from(required_int(value, "startWeek", path)?),
    );
    phase.insert(
        "endWeek".into(),
        Value::from(required_int(value, "endWeek", path)?),
    );
    phase.insert(
        "focus".into(),
        Value::String(required_text(value, "focus", path)?),
    );
    phase.insert(
        "progression".into(),
        text_array_or(value, "progression", &[]),
    );
    Ok(Value::Object(phase))
}

fn parse_adjustment_rules(value: &Value, path: &str) -> Result<Value> {
    let Some(rules) = value.get("adjustmentRules").and_then(Value::as_array) else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut parsed = Vec::with_capacity(rules.len());
    for (index, rule) in rules.iter().enumerate() {
        let rule_path = format!("{path}.adjustmentRules.{index}");
        object(rule, &rule_path)?;
        parsed.push(json!({
            "trigger": required_text(rule, "trigger", &rule_path)?,
            "action": required_text(rule, "action", &rule_path)?,
            "rationale": required_text(rule, "rationale", &rule_path)?,
        }));
    }
    Ok(Value::Array(parsed))
}

/// `templateRefSchema`, nullable.
fn parse_template_ref_or_null(value: &Value, key: &str, path: &str) -> Result<Value> {
    let Some(reference) = value.get(key).filter(|item| !item.is_null()) else {
        return Ok(Value::Null);
    };
    let reference_path = format!("{path}.{key}");
    object(reference, &reference_path)?;
    let source = required_enum(reference, "source", &["builtin", "user"], &reference_path)?;
    let mut parsed = Map::new();
    parsed.insert("source".into(), Value::String(source.clone()));
    parsed.insert(
        "id".into(),
        Value::String(required_text(reference, "id", &reference_path)?),
    );
    if source == "builtin" {
        parsed.insert(
            "catalogVersion".into(),
            Value::String(required_text(reference, "catalogVersion", &reference_path)?),
        );
    } else {
        parsed.insert(
            "revision".into(),
            Value::from(required_int(reference, "revision", &reference_path)?),
        );
    }
    Ok(Value::Object(parsed))
}

/// `phaseRefSchema` array.
fn parse_phase_refs(value: &Value, path: &str) -> Result<Value> {
    let refs = array(get(value, "phaseRefs"), &format!("{path}.phaseRefs"))?;
    let mut parsed = Vec::with_capacity(refs.len());
    for (index, reference) in refs.iter().enumerate() {
        let ref_path = format!("{path}.phaseRefs.{index}");
        object(reference, &ref_path)?;
        parsed.push(json!({
            "domain": required_enum(reference, "domain", &DOMAIN_IDS, &ref_path)?,
            "phaseId": required_text(reference, "phaseId", &ref_path)?,
        }));
    }
    Ok(Value::Array(parsed))
}

/// `exerciseOverrideSchema` array.
fn parse_exercise_overrides(value: &Value, path: &str) -> Result<Value> {
    let Some(items) = value.get("exerciseOverrides").and_then(Value::as_array) else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut parsed = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let item_path = format!("{path}.exerciseOverrides.{index}");
        object(item, &item_path)?;
        let mut entry = Map::new();
        entry.insert(
            "exerciseId".into(),
            Value::String(required_text(item, "exerciseId", &item_path)?),
        );
        for key in [
            "sets",
            "repsMin",
            "repsMax",
            "targetRpe",
            "restSeconds",
            "referenceLoad",
            "referenceLoadUnit",
        ] {
            if let Some(field) = item.get(key) {
                entry.insert(key.into(), field.clone());
            }
        }
        if let (Some(min), Some(max)) = (
            item.get("repsMin").and_then(Value::as_i64),
            item.get("repsMax").and_then(Value::as_i64),
        ) {
            if max < min {
                return Err(invalid(
                    &format!("{item_path}.repsMax"),
                    "repsMax must be >= repsMin",
                ));
            }
        }
        parsed.push(Value::Object(entry));
    }
    Ok(Value::Array(parsed))
}

/// `planTargetSchema`.
fn parse_plan_target(value: &Value, path: &str) -> Result<Value> {
    object(value, path)?;
    let mut target = Map::new();
    if let Some(goal) = value.get("primaryGoal").filter(|item| item.is_object()) {
        let goal_path = format!("{path}.primaryGoal");
        let mut parsed = Map::new();
        parsed.insert(
            "label".into(),
            Value::String(required_text(goal, "label", &goal_path)?),
        );
        if let Some(baseline) = goal.get("baseline") {
            parsed.insert("baseline".into(), baseline.clone());
        }
        if let Some(test_date) = goal.get("testDate") {
            parsed.insert("testDate".into(), test_date.clone());
        }
        target.insert("primaryGoal".into(), Value::Object(parsed));
    }
    for key in ["supporting", "maintenance"] {
        let Some(items) = value.get(key).and_then(Value::as_array) else {
            continue;
        };
        let mut parsed = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            let item_path = format!("{path}.{key}.{index}");
            object(item, &item_path)?;
            let mut entry = Map::new();
            entry.insert(
                "label".into(),
                Value::String(required_text(item, "label", &item_path)?),
            );
            if let Some(detail) = item.get("detail") {
                entry.insert("detail".into(), detail.clone());
            }
            parsed.push(Value::Object(entry));
        }
        target.insert(key.into(), Value::Array(parsed));
    }
    if let Some(strategy) = value.get("coordinationStrategy") {
        target.insert("coordinationStrategy".into(), strategy.clone());
    }
    Ok(Value::Object(target))
}

/// `plannedSessionSchema`'s `superRefine`: phase references resolve exactly
/// the session's component domains.
fn validate_phase_refs(session: &Value) -> Result<()> {
    let mut component_domains: Vec<String> = Vec::new();
    for component in session["components"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        if let Some(domain) = component["domain"]["value"].as_str() {
            if !component_domains.iter().any(|existing| existing == domain) {
                component_domains.push(domain.to_owned());
            }
        }
    }
    let ref_domains: Vec<String> = session["phaseRefs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|reference| reference["domain"].as_str().map(str::to_owned))
        .collect();
    if !unique(&ref_domains)
        || component_domains.len() != ref_domains.len()
        || ref_domains
            .iter()
            .any(|domain| !component_domains.contains(domain))
    {
        return Err(invalid(
            "plannedSession.phaseRefs",
            "phase references must exactly match resolved component domains",
        ));
    }
    Ok(())
}

fn unique<T: PartialEq>(values: &[T]) -> bool {
    values
        .iter()
        .enumerate()
        .all(|(index, value)| !values[index + 1..].contains(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn domain_fact(domain: &str) -> Value {
        json!({ "value": domain, "source": "catalog", "confidence": 1, "evidence": "built-in", "taxonomyVersion": "strength-2.0" })
    }

    fn endurance_component() -> Value {
        json!({
            "id": "c1",
            "name": "Main set",
            "domain": domain_fact("endurance"),
            "prescription": { "kind": "endurance", "segments": [{ "type": "step", "name": "Steady", "role": "steady", "durationSeconds": 1800 }] },
        })
    }

    fn weekly_session() -> Value {
        json!({
            "id": "s1",
            "scheduledDate": "2026-09-10",
            "order": 0,
            "name": "Easy Run",
            "intent": "Aerobic base",
            "durationMinutes": 45,
            "components": [endurance_component()],
        })
    }

    fn plan_write() -> Value {
        json!({
            "planSchemaVersion": "7.0",
            "title": "Base Block",
            "effectiveStartDate": "2026-09-07",
            "mesocycle": {
                "durationWeeks": 1,
                "schedule": { "kind": "fixed_week", "days": [3, 6] },
                "domainProgressions": [{
                    "domain": "endurance",
                    "phases": [{ "id": "phase-1", "phaseType": "foundation", "name": "Base", "startWeek": 1, "endWeek": 1, "focus": "Aerobic base" }],
                }],
                "weeks": [{ "weekNumber": 1, "sessions": [weekly_session()] }],
            },
            "expectedRevision": 0,
        })
    }

    #[test]
    fn plans_are_rebuilt_in_schema_order_with_defaults() {
        let plan = parse_current_plan_write(&plan_write()).unwrap();
        let keys: Vec<&String> = plan.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "planSchemaVersion",
                "ownerId",
                "title",
                "summary",
                "effectiveStartDate",
                "mesocycle",
                "sourceAgent",
                "model",
                "skillVersion",
                "inputSnapshotHash",
                "expectedRevision"
            ]
        );
        assert_eq!(plan["ownerId"], json!(crate::DEFAULT_OWNER_ID));
        assert_eq!(plan["summary"], json!(""));
        assert_eq!(plan["sourceAgent"], json!(null));
    }

    #[test]
    fn a_plan_target_stays_before_expected_revision() {
        let mut payload = plan_write();
        payload["target"] =
            json!({ "primaryGoal": { "label": "10K PB" }, "coordinationStrategy": "Rotate focus" });
        let plan = parse_current_plan_write(&payload).unwrap();
        let keys: Vec<&String> = plan.as_object().unwrap().keys().collect();
        assert_eq!(keys[keys.len() - 2..], ["target", "expectedRevision"]);
        assert_eq!(
            plan["target"],
            json!({ "primaryGoal": { "label": "10K PB" }, "coordinationStrategy": "Rotate focus" })
        );

        payload["revision"] = json!(3);
        payload["updatedAt"] = json!("2026-09-07T04:00:00.000Z");
        let stored = parse_current_plan(&payload).unwrap();
        let keys: Vec<&String> = stored.as_object().unwrap().keys().collect();
        assert_eq!(
            keys[6..],
            [
                "revision",
                "sourceAgent",
                "model",
                "skillVersion",
                "inputSnapshotHash",
                "updatedAt",
                "target"
            ]
        );
    }

    #[test]
    fn nested_sessions_and_facts_keep_their_defaults() {
        let plan = parse_current_plan_write(&plan_write()).unwrap();
        let session = &plan["mesocycle"]["weeks"][0]["sessions"][0];
        let keys: Vec<&String> = session.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "id",
                "scheduledDate",
                "order",
                "status",
                "templateRef",
                "name",
                "intent",
                "durationMinutes",
                "recoveryDemand",
                "keySession",
                "components",
                "progressionNote",
                "schedulingRationale",
                "legacySnapshot"
            ]
        );
        assert_eq!(session["status"], json!("planned"));
        assert_eq!(session["templateRef"], json!(null));
        assert_eq!(session["keySession"], json!(false));
        let fact = &session["components"][0]["domain"];
        let keys: Vec<&String> = fact.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "value",
                "source",
                "confidence",
                "evidence",
                "taxonomyVersion"
            ]
        );
        assert_eq!(plan["mesocycle"]["weeks"][0]["focus"], json!(null));
        assert_eq!(plan["mesocycle"]["adjustmentRules"], json!([]));
        // The step keeps only the effort targets the source observation has.
        assert_eq!(
            session["components"][0]["prescription"]["segments"][0],
            json!({ "type": "step", "name": "Steady", "role": "steady", "durationSeconds": 1800 })
        );
    }

    #[test]
    fn mesocycles_reject_phase_and_domain_mismatches() {
        let mut payload = plan_write();
        payload["mesocycle"]["durationWeeks"] = json!(2);
        let error = parse_current_plan_write(&payload).unwrap_err();
        assert_eq!(error.code(), crate::AthriaErrorCode::InvalidData);
        assert!(
            error.message().contains("contiguously cover"),
            "{}",
            error.message()
        );

        let mut payload = plan_write();
        payload["mesocycle"]["domainProgressions"][0]["domain"] = json!("strength");
        let error = parse_current_plan_write(&payload).unwrap_err();
        assert!(
            error
                .message()
                .contains("exactly match resolved session domains"),
            "{}",
            error.message()
        );
    }

    #[test]
    fn session_dates_must_fall_inside_their_plan_week() {
        let mut payload = plan_write();
        payload["mesocycle"]["weeks"][0]["sessions"][0]["scheduledDate"] = json!("2026-09-17");
        let error = parse_current_plan_write(&payload).unwrap_err();
        assert!(
            error.message().contains("inside its plan week"),
            "{}",
            error.message()
        );
    }

    #[test]
    fn components_require_a_matching_prescription_kind() {
        fn with_component(domain: &str, prescription: Value) -> Value {
            let mut payload = plan_write();
            let component = &mut payload["mesocycle"]["weeks"][0]["sessions"][0]["components"][0];
            component["domain"] = domain_fact(domain);
            component["prescription"] = prescription;
            payload
        }

        let strength_prescription = json!({ "kind": "strength", "exercises": [{
            "id": "e1", "displayName": "Back Squat",
            "classification": {
                "primaryMovement": { "value": "squat", "source": "catalog", "confidence": 1, "evidence": "built-in", "taxonomyVersion": "strength-2.0" },
                "primaryMuscles": { "value": ["quadriceps"], "source": "catalog", "confidence": 1, "evidence": "built-in", "taxonomyVersion": "strength-2.0" },
                "secondaryMuscles": { "value": [], "source": "catalog", "confidence": 1, "evidence": "built-in", "taxonomyVersion": "strength-2.0" },
                "equipment": { "value": ["barbell"], "source": "catalog", "confidence": 1, "evidence": "built-in", "taxonomyVersion": "strength-2.0" },
                "impact": { "value": "high", "source": "catalog", "confidence": 1, "evidence": "built-in", "taxonomyVersion": "strength-2.0" },
                "laterality": { "value": "bilateral", "source": "catalog", "confidence": 1, "evidence": "built-in", "taxonomyVersion": "strength-2.0" },
            },
            "sets": 3, "repsMin": 5, "repsMax": 5,
        }] });

        let error = parse_current_plan_write(&with_component("endurance", strength_prescription))
            .unwrap_err();
        assert!(
            error
                .message()
                .contains("strength prescription requires strength domain"),
            "{}",
            error.message()
        );

        let error = parse_current_plan_write(&with_component(
            "strength",
            json!({ "kind": "duration_only" }),
        ))
        .unwrap_err();
        assert!(
            error
                .message()
                .contains("strength domain requires strength prescription"),
            "{}",
            error.message()
        );

        let error = parse_current_plan_write(&with_component(
            "mind_body",
            endurance_component()["prescription"].clone(),
        ))
        .unwrap_err();
        assert!(
            error
                .message()
                .contains("endurance prescription requires matching domain"),
            "{}",
            error.message()
        );

        // `duration_only` is the general fallback: it is only rejected on a
        // strength domain, so an endurance component with it stays valid.
        parse_current_plan_write(&with_component(
            "endurance",
            json!({ "kind": "duration_only" }),
        ))
        .unwrap();
    }

    #[test]
    fn planned_sessions_are_rebuilt_in_schema_order_with_defaults() {
        let plan = parse_current_plan_write(&plan_write()).unwrap();
        let mut session = plan["mesocycle"]["weeks"][0]["sessions"][0].clone();
        session["occurrenceId"] = json!("occurrence-1");
        session["ownerId"] = json!(crate::DEFAULT_OWNER_ID);
        session["planRevision"] = json!(1);
        session["weekNumber"] = json!(1);
        session["phaseRefs"] = json!([{ "domain": "endurance", "phaseId": "phase-1" }]);
        session["createdAt"] = json!("2026-09-07T04:00:00.000Z");
        session["updatedAt"] = json!("2026-09-07T04:00:00.000Z");
        // `scheduledDate`/`order` are weekly-session keys the planned session
        // schema keeps, and `exerciseOverrides` is added by the caller.
        let parsed = parse_planned_session(&session).unwrap();
        let keys: Vec<&String> = parsed.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "id",
                "occurrenceId",
                "ownerId",
                "planRevision",
                "scheduledDate",
                "order",
                "weekNumber",
                "phaseRefs",
                "templateRef",
                "name",
                "intent",
                "recoveryDemand",
                "durationMinutes",
                "keySession",
                "components",
                "progressionNote",
                "schedulingRationale",
                "exerciseOverrides",
                "legacySnapshot",
                "notes",
                "overrideReason",
                "status",
                "displayState",
                "completedTrainingSessionId",
                "completedAt",
                "completionSource",
                "match",
                "createdAt",
                "updatedAt"
            ]
        );
        assert_eq!(parsed["order"], json!(0));
        assert_eq!(parsed["exerciseOverrides"], json!([]));
        assert_eq!(parsed["displayState"], json!("scheduled"));
        assert_eq!(parsed["match"], json!(null));
    }

    #[test]
    fn planned_sessions_reject_phase_refs_that_do_not_match_components() {
        let mut session = json!({
            "id": "s1",
            "occurrenceId": "occurrence-1",
            "ownerId": crate::DEFAULT_OWNER_ID,
            "planRevision": 1,
            "scheduledDate": "2026-09-10",
            "weekNumber": 1,
            "phaseRefs": [],
            "name": "Easy Run",
            "intent": "Aerobic base",
            "recoveryDemand": "normal",
            "durationMinutes": 45,
            "components": [endurance_component()],
            "createdAt": "2026-09-07T04:00:00.000Z",
            "updatedAt": "2026-09-07T04:00:00.000Z",
        });
        let error = parse_planned_session(&session).unwrap_err();
        assert!(
            error.message().contains("phase references"),
            "{}",
            error.message()
        );

        session["phaseRefs"] = json!([{ "domain": "endurance", "phaseId": "phase-1" }]);
        assert_eq!(
            parse_planned_session(&session).unwrap()["phaseRefs"][0]["phaseId"],
            json!("phase-1")
        );
    }

    #[test]
    fn next_training_day_writes_default_session_fields() {
        let write = parse_next_training_day_write(&json!({
            "clientRequestId": "request-1",
            "scheduledDate": "2026-09-10",
            "expectedRevision": 0,
            "mode": "replace",
            "sessions": [{ "id": "s1", "name": "Easy Run", "intent": "Aerobic base", "durationMinutes": 45, "components": [endurance_component()] }],
        }))
        .unwrap();
        let keys: Vec<&String> = write.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "clientRequestId",
                "scheduledDate",
                "expectedRevision",
                "mode",
                "sessions"
            ]
        );
        let session = &write["sessions"][0];
        let keys: Vec<&String> = session.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "id",
                "status",
                "templateRef",
                "name",
                "intent",
                "durationMinutes",
                "recoveryDemand",
                "keySession",
                "components",
                "progressionNote",
                "schedulingRationale",
                "legacySnapshot",
                "notes"
            ]
        );
        assert_eq!(session["status"], json!("planned"));
        assert_eq!(session["notes"], json!(""));
        assert!(session.get("overrideReason").is_none());
    }

    #[test]
    fn planned_session_actions_keep_only_their_own_shape() {
        assert_eq!(
            parse_planned_session_action(&json!({ "action": "complete", "expectedRevision": 2 }))
                .unwrap(),
            json!({ "action": "complete", "expectedRevision": 2 })
        );
        let skip = parse_planned_session_action(&json!({ "action": "skip", "expectedRevision": 2, "reason": { "reasonCode": "travel", "note": "  flying  " } })).unwrap();
        assert_eq!(
            skip,
            json!({ "action": "skip", "expectedRevision": 2, "reason": { "reasonCode": "travel", "note": "flying" } })
        );
        let moved = parse_planned_session_action(&json!({ "action": "move_occurrence", "expectedRevision": 2, "scheduledDate": "2026-09-12" })).unwrap();
        assert_eq!(
            moved,
            json!({ "action": "move_occurrence", "expectedRevision": 2, "scheduledDate": "2026-09-12" })
        );
        assert!(
            parse_planned_session_action(&json!({ "action": "postpone", "expectedRevision": 2 }))
                .is_err()
        );
    }
}
