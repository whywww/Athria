//! Planned-session projection and writes: the Rust port of
//! `AthriaRepository.listCurrentPlannedSessions`, `scheduleRevision`,
//! `updateCurrentPlannedSessions` and `saveCurrentPlannedSessions` in
//! current-plan persistence contract.
//!
//! The stored current mesocycle keeps the compact weekly-session shape; the
//! projection adds occurrence identity, plan revision, phase references,
//! completion state and timestamps on every read, exactly like TypeScript.

use std::collections::HashMap;

use athria_application::{SaveCurrentPlannedSessionsInput, UpdateCurrentPlannedSessionsInput};
use athria_core::{AthriaError, AthriaErrorCode, Result, js_locale_compare};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::sessions::{array, integer, text_or};
use crate::store::{SqliteStore, database_error, parse_json_column};

/// The weekly-session shape stored inside `current_mesocycles.data`.
fn weekly_session_projection(session: &Value, status: &str) -> Value {
    json!({
        "id": session["id"],
        "scheduledDate": session["scheduledDate"],
        "order": session["order"],
        "status": status,
        "templateRef": session["templateRef"],
        "name": session["name"],
        "intent": session["intent"],
        "durationMinutes": session["durationMinutes"],
        "recoveryDemand": session["recoveryDemand"],
        "keySession": session["keySession"],
        "components": session["components"],
        "progressionNote": session["progressionNote"],
        "schedulingRationale": session["schedulingRationale"],
        "legacySnapshot": session["legacySnapshot"],
    })
}

/// `[...new Set(components.map(component => component.domain.value).filter(Boolean))]`
fn component_domains(session: &Value) -> Vec<String> {
    let mut domains: Vec<String> = Vec::new();
    for component in array(session, "components") {
        if let Some(domain) = component
            .get("domain")
            .and_then(|domain| domain.get("value"))
            .and_then(Value::as_str)
        {
            if !domains.iter().any(|existing| existing == domain) {
                domains.push(domain.to_string());
            }
        }
    }
    domains
}

/// `phaseRefs`: one reference per resolved component domain, resolved through
/// the plan's domain progressions and the phase covering the week.
fn phase_refs(plan: &Value, session: &Value, week_number: i64) -> Result<Value> {
    let progressions = plan
        .get("mesocycle")
        .and_then(|mesocycle| mesocycle.get("domainProgressions"))
        .and_then(Value::as_array);
    let mut refs = Vec::new();
    for domain in component_domains(session) {
        let progression = progressions
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| text_or(item, "domain", "") == domain.as_str())
            })
            .ok_or_else(|| {
                AthriaError::new(
                    AthriaErrorCode::InvalidData,
                    format!("plan is missing the `{domain}` domain progression"),
                )
            })?;
        let phase = array(progression, "phases")
            .iter()
            .find(|phase| {
                week_number >= integer(phase, "startWeek")
                    && week_number <= integer(phase, "endWeek")
            })
            .ok_or_else(|| {
                AthriaError::new(
                    AthriaErrorCode::InvalidData,
                    format!("plan is missing a `{domain}` phase covering week {week_number}"),
                )
            })?;
        refs.push(json!({ "domain": domain, "phaseId": text_or(phase, "id", "") }));
    }
    Ok(Value::Array(refs))
}

#[allow(clippy::too_many_arguments)]
fn project_session(
    plan: &Value,
    session: &Value,
    week_number: i64,
    owner_id: &str,
    plan_revision: i64,
    timestamp: &str,
    today: &str,
    completed: &HashMap<String, (Value, String)>,
    sources: &HashMap<String, Vec<Value>>,
) -> Result<Value> {
    let session_id = text_or(session, "id", "");
    let scheduled_date = text_or(session, "scheduledDate", "");
    let entry = completed.get(session_id);
    let stored_status = text_or(session, "status", "planned");
    let status = if entry.is_some() {
        "completed"
    } else {
        stored_status
    };
    let display_state = if entry.is_some() {
        "completed"
    } else if stored_status == "skipped" {
        "skipped"
    } else if scheduled_date < today {
        "unrecorded"
    } else {
        "scheduled"
    };
    let (completed_training_session_id, completed_at, completion_source) = match entry {
        Some((workout, _)) => {
            let workout_id = text_or(workout, "id", "");
            let source = if sources.get(workout_id).is_some_and(|summaries| {
                summaries
                    .iter()
                    .any(|summary| text_or(summary, "source", "") != "manual")
            }) {
                "import"
            } else {
                "manual"
            };
            (
                workout.get("id").cloned().unwrap_or(Value::Null),
                workout.get("endAt").cloned().unwrap_or(Value::Null),
                json!(source),
            )
        }
        None => (Value::Null, Value::Null, Value::Null),
    };
    let plan_match = match entry {
        Some((_, method)) => json!({ "plannedSessionId": session_id, "method": method }),
        None => Value::Null,
    };

    // Keys follow `plannedSessionSchema` order, the shape of `zod` output.
    Ok(json!({
        "id": session["id"],
        "occurrenceId": format!("plan:{scheduled_date}"),
        "ownerId": owner_id,
        "planRevision": plan_revision,
        "scheduledDate": session["scheduledDate"],
        "order": session["order"],
        "weekNumber": week_number,
        "phaseRefs": phase_refs(plan, session, week_number)?,
        "templateRef": session["templateRef"],
        "name": session["name"],
        "intent": session["intent"],
        "recoveryDemand": session["recoveryDemand"],
        "durationMinutes": session["durationMinutes"],
        "keySession": session["keySession"],
        "components": session["components"],
        "progressionNote": session["progressionNote"],
        "schedulingRationale": session["schedulingRationale"],
        "exerciseOverrides": [],
        "legacySnapshot": session["legacySnapshot"],
        "notes": "",
        "overrideReason": Value::Null,
        "status": status,
        "displayState": display_state,
        "completedTrainingSessionId": completed_training_session_id,
        "completedAt": completed_at,
        "completionSource": completion_source,
        "match": plan_match,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }))
}

impl SqliteStore {
    /// `listCurrentPlannedSessions`: every scheduled occurrence of the current
    /// plan with completion state derived from plan matches.
    pub fn list_current_planned_sessions(
        &self,
        owner_id: &str,
        scheduled_date: Option<&str>,
    ) -> Result<Vec<Value>> {
        let Some(plan) = self.get_current_plan(owner_id)? else {
            return Ok(Vec::new());
        };
        let timestamp = text_or(&plan, "updatedAt", "").to_string();
        let plan_revision = integer(&plan, "revision");
        let mut completed: HashMap<String, (Value, String)> = HashMap::new();
        {
            let mut statement = self
                .sqlite()
                .prepare("SELECT planned_session_id, training_session_id, method FROM plan_workout_matches WHERE owner_id = ?1")
                .map_err(database_error)?;
            let rows = statement
                .query_map(params![owner_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(database_error)?;
            for row in rows {
                let (planned_session_id, training_session_id, method) =
                    row.map_err(database_error)?;
                let data: Option<String> = self
                    .sqlite()
                    .query_row(
                        "SELECT data FROM training_sessions WHERE owner_id = ?1 AND id = ?2",
                        params![owner_id, training_session_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(database_error)?;
                if let Some(data) = data {
                    completed.insert(planned_session_id, (parse_json_column(&data)?, method));
                }
            }
        }
        let sources = self.source_summaries(owner_id)?;
        let today = crate::tz::local_date(&self.now(), &self.profile_timezone(owner_id)?)?;

        let mut sessions = Vec::new();
        if let Some(weeks) = plan
            .get("mesocycle")
            .and_then(|mesocycle| mesocycle.get("weeks"))
            .and_then(Value::as_array)
        {
            for week in weeks {
                let week_number = integer(week, "weekNumber");
                for session in array(week, "sessions") {
                    sessions.push(project_session(
                        &plan,
                        session,
                        week_number,
                        owner_id,
                        plan_revision,
                        &timestamp,
                        &today,
                        &completed,
                        &sources,
                    )?);
                }
            }
        }
        if let Some(date) = scheduled_date {
            sessions.retain(|session| text_or(session, "scheduledDate", "") == date);
        }
        sessions.sort_by(|left, right| {
            js_locale_compare(
                text_or(left, "scheduledDate", ""),
                text_or(right, "scheduledDate", ""),
            )
            .then_with(|| integer(left, "order").cmp(&integer(right, "order")))
        });
        Ok(sessions)
    }

    /// `scheduleRevision`: current plan revision, 0 without a plan.
    pub fn schedule_revision(&self, owner_id: &str) -> Result<i64> {
        Ok(self
            .get_current_plan(owner_id)?
            .map(|plan| integer(&plan, "revision"))
            .unwrap_or(0))
    }

    /// `updateCurrentPlannedSessions`: replace occurrences by id, record one
    /// event per occurrence and bump the plan revision.
    pub fn update_current_planned_sessions(
        &self,
        input: &UpdateCurrentPlannedSessionsInput<'_>,
    ) -> Result<Value> {
        let sessions = self.transaction(&mut || {
            let current = self
                .get_current_plan(input.owner_id)?
                .ok_or_else(|| AthriaError::new(AthriaErrorCode::NoCurrentPlan, "NO_CURRENT_PLAN"))?;
            let revision = integer(&current, "revision");
            if revision != input.expected_revision {
                return Err(AthriaError::new(AthriaErrorCode::PlannedSessionRevisionConflict, "PLANNED_SESSION_REVISION_CONFLICT"));
            }
            let mut previous: HashMap<String, Value> = HashMap::new();
            if let Some(weeks) = current.get("mesocycle").and_then(|mesocycle| mesocycle.get("weeks")).and_then(Value::as_array) {
                for week in weeks {
                    for session in array(week, "sessions") {
                        previous.insert(text_or(session, "id", "").to_string(), session.clone());
                    }
                }
            }
            let update_ids: Vec<&str> = input.sessions.iter().map(|session| text_or(session, "id", "")).collect();
            let mut weeks: Vec<Value> = Vec::new();
            if let Some(current_weeks) = current.get("mesocycle").and_then(|mesocycle| mesocycle.get("weeks")).and_then(Value::as_array) {
                for week in current_weeks {
                    let mut updated = week.clone();
                    let kept: Vec<Value> = array(week, "sessions").iter().filter(|session| !update_ids.contains(&text_or(session, "id", ""))).cloned().collect();
                    updated["sessions"] = Value::Array(kept);
                    weeks.push(updated);
                }
            }
            for session in input.sessions {
                let week_number = integer(session, "weekNumber");
                let Some(week) = weeks.iter_mut().find(|week| integer(week, "weekNumber") == week_number) else {
                    return Err(AthriaError::new(AthriaErrorCode::PlanWeekNotFound, "PLAN_WEEK_NOT_FOUND"));
                };
                let status = if text_or(session, "status", "planned") == "skipped" { "skipped" } else { "planned" };
                week["sessions"].as_array_mut().expect("week sessions stay an array").push(weekly_session_projection(session, status));
            }
            let updated_at = self.now();
            let mut plan = current.clone();
            plan["mesocycle"]["weeks"] = Value::Array(weeks);
            plan["revision"] = json!(revision + 1);
            plan["updatedAt"] = json!(updated_at);
            self.write_current_plan(input.owner_id, &plan, revision + 1, &updated_at)?;
            for session in input.sessions {
                let session_id = text_or(session, "id", "");
                let from_date = previous
                    .get(session_id)
                    .and_then(|before| before.get("scheduledDate"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.sqlite()
                    .execute(
                        "INSERT INTO planned_session_events(id, owner_id, planned_session_id, action, from_date, to_date, reason_code, reason_note, revision_before, revision_after, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                        params![
                            uuid::Uuid::new_v4().to_string(),
                            input.owner_id,
                            session_id,
                            input.mode,
                            from_date,
                            text_or(session, "scheduledDate", ""),
                            input.reason_code,
                            input.reason_note,
                            revision,
                            revision + 1,
                            updated_at
                        ],
                    )
                    .map_err(database_error)?;
            }
            Ok(json!({ "sessions": input.sessions, "revision": revision + 1 }))
        })?;
        self.reconcile_plan_matches(input.owner_id)?;
        Ok(sessions)
    }

    /// `saveCurrentPlannedSessions`: insert or replace one scheduled date of
    /// the current plan and return the fresh projection for that date.
    pub fn save_current_planned_sessions(
        &self,
        input: &SaveCurrentPlannedSessionsInput<'_>,
    ) -> Result<Value> {
        let current = self
            .get_current_plan(input.owner_id)?
            .ok_or_else(|| AthriaError::new(AthriaErrorCode::NoCurrentPlan, "NO_CURRENT_PLAN"))?;
        let revision = integer(&current, "revision");
        if revision != input.expected_revision {
            return Err(AthriaError::new(
                AthriaErrorCode::PlannedSessionRevisionConflict,
                "PLANNED_SESSION_REVISION_CONFLICT",
            ));
        }
        let Some(target_week) = input
            .sessions
            .first()
            .map(|session| integer(session, "weekNumber"))
            .filter(|week| *week != 0)
        else {
            return Err(AthriaError::new(
                AthriaErrorCode::PlanWeekNotFound,
                "PLAN_WEEK_NOT_FOUND",
            ));
        };
        let replace = input.mode == "replace";
        let mut weeks: Vec<Value> = Vec::new();
        if let Some(current_weeks) = current
            .get("mesocycle")
            .and_then(|mesocycle| mesocycle.get("weeks"))
            .and_then(Value::as_array)
        {
            for week in current_weeks {
                let mut updated = week.clone();
                if integer(week, "weekNumber") == target_week {
                    let mut sessions: Vec<Value> = if replace {
                        array(week, "sessions")
                            .iter()
                            .filter(|session| {
                                text_or(session, "scheduledDate", "") != input.scheduled_date
                            })
                            .cloned()
                            .collect()
                    } else {
                        array(week, "sessions").to_vec()
                    };
                    for session in input.sessions {
                        sessions.push(weekly_session_projection(session, "planned"));
                    }
                    updated["sessions"] = Value::Array(sessions);
                }
                weeks.push(updated);
            }
        }
        let updated_at = self.now();
        let mut plan = current.clone();
        plan["mesocycle"]["weeks"] = Value::Array(weeks);
        plan["revision"] = json!(revision + 1);
        plan["updatedAt"] = json!(updated_at);
        self.save_current_plan(&plan, revision)?;
        Ok(json!({
            "sessions": self.list_current_planned_sessions(input.owner_id, Some(input.scheduled_date))?,
            "revision": revision + 1,
            "idempotentReplay": false,
        }))
    }

    /// `AthriaRepository.saveCurrentPlan` writes the row with the plan's own
    /// revision and timestamp columns.
    pub(crate) fn write_current_plan(
        &self,
        owner_id: &str,
        plan: &Value,
        revision: i64,
        updated_at: &str,
    ) -> Result<()> {
        self.sqlite()
            .execute(
                "INSERT INTO current_mesocycles(owner_id, data, revision, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, revision = excluded.revision, updated_at = excluded.updated_at",
                params![owner_id, plan.to_string(), revision, updated_at],
            )
            .map_err(database_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;
    use crate::store::DEFAULT_OWNER_ID;
    use std::sync::Arc;

    fn store() -> SqliteStore {
        SqliteStore::open_in_memory_with_clock(Arc::new(FixedClock::new(
            "2026-09-17T04:00:00.000Z",
        )))
        .unwrap()
    }

    fn session(id: &str, scheduled_date: &str, order: i64, name: &str) -> Value {
        json!({
            "id": id, "scheduledDate": scheduled_date, "order": order, "status": "planned", "templateRef": null,
            "name": name, "intent": "Aerobic base", "durationMinutes": 60, "recoveryDemand": "low", "keySession": false,
            "components": [{
                "id": format!("{id}-c1"), "name": "Run",
                "domain": { "value": "endurance", "source": "user_confirmed", "confidence": 1, "evidence": "", "taxonomyVersion": "strength-2.0" },
                "prescription": { "kind": "duration_only", "notes": "" },
            }],
            "progressionNote": null, "schedulingRationale": null, "legacySnapshot": false,
        })
    }

    fn plan() -> Value {
        json!({
            "ownerId": DEFAULT_OWNER_ID, "revision": 1, "updatedAt": "2026-09-01T04:00:00.000Z",
            "mesocycle": {
                "durationWeeks": 2,
                "schedule": { "kind": "fixed_week", "days": [3, 6] },
                "domainProgressions": [{
                    "domain": "endurance",
                    "phases": [
                        { "id": "phase-1", "phaseType": "foundation", "name": "Base", "startWeek": 1, "endWeek": 1, "focus": "Aerobic base", "progression": [] },
                        { "id": "phase-2", "phaseType": "progression", "name": "Build", "startWeek": 2, "endWeek": 2, "focus": "Threshold", "progression": [] },
                    ],
                }],
                "weeks": [
                    { "weekNumber": 1, "focus": null, "sessions": [session("s1", "2026-09-10", 0, "Easy Run")] },
                    { "weekNumber": 2, "focus": null, "sessions": [session("s2", "2026-09-20", 0, "Tempo Run")] },
                ],
            },
        })
    }

    #[test]
    fn projects_scheduled_occurrences_with_display_states_and_schema_key_order() {
        let store = store();
        store.save_current_plan(&plan(), 0).unwrap();
        let sessions = store
            .list_current_planned_sessions(DEFAULT_OWNER_ID, None)
            .unwrap();
        assert_eq!(sessions.len(), 2);

        let keys: Vec<&String> = sessions[0].as_object().unwrap().keys().collect();
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
                "updatedAt",
            ]
        );
        assert_eq!(sessions[0]["occurrenceId"], json!("plan:2026-09-10"));
        assert_eq!(sessions[0]["displayState"], json!("unrecorded"));
        assert_eq!(
            sessions[0]["phaseRefs"],
            json!([{ "domain": "endurance", "phaseId": "phase-1" }])
        );
        assert_eq!(sessions[0]["createdAt"], json!("2026-09-01T04:00:00.000Z"));
        assert_eq!(sessions[1]["displayState"], json!("scheduled"));
        assert_eq!(
            sessions[1]["phaseRefs"],
            json!([{ "domain": "endurance", "phaseId": "phase-2" }])
        );

        let filtered = store
            .list_current_planned_sessions(DEFAULT_OWNER_ID, Some("2026-09-20"))
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["id"], json!("s2"));
    }

    #[test]
    fn reported_schedule_revision_tracks_the_stored_plan() {
        let store = store();
        assert_eq!(store.schedule_revision(DEFAULT_OWNER_ID).unwrap(), 0);
        store.save_current_plan(&plan(), 0).unwrap();
        assert_eq!(store.schedule_revision(DEFAULT_OWNER_ID).unwrap(), 1);
    }

    #[test]
    fn moving_an_occurrence_records_an_event_and_bumps_the_revision() {
        let store = store();
        store.save_current_plan(&plan(), 0).unwrap();
        let mut moved = session("s1", "2026-09-12", 0, "Easy Run");
        moved["weekNumber"] = json!(1);
        let result = store
            .update_current_planned_sessions(&UpdateCurrentPlannedSessionsInput {
                owner_id: DEFAULT_OWNER_ID,
                expected_revision: 1,
                mode: "move_occurrence",
                sessions: &[moved],
                reason_code: Some("travel"),
                reason_note: None,
            })
            .unwrap();
        assert_eq!(result["revision"], json!(2));
        assert_eq!(store.schedule_revision(DEFAULT_OWNER_ID).unwrap(), 2);

        let (from_date, to_date, action, revision_before, revision_after): (Option<String>, String, String, i64, i64) = store
            .sqlite()
            .query_row(
                "SELECT from_date, to_date, action, revision_before, revision_after FROM planned_session_events WHERE owner_id = ?1",
                params![DEFAULT_OWNER_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(from_date.as_deref(), Some("2026-09-10"));
        assert_eq!(to_date, "2026-09-12");
        assert_eq!(action, "move_occurrence");
        assert_eq!((revision_before, revision_after), (1, 2));

        let sessions = store
            .list_current_planned_sessions(DEFAULT_OWNER_ID, None)
            .unwrap();
        assert_eq!(
            sessions
                .iter()
                .map(|session| text_or(session, "scheduledDate", "").to_string())
                .collect::<Vec<_>>(),
            ["2026-09-12", "2026-09-20"]
        );
    }

    #[test]
    fn planned_session_writes_fail_on_stale_revisions_and_unknown_weeks() {
        let store = store();
        store.save_current_plan(&plan(), 0).unwrap();
        let mut moved = session("s1", "2026-09-12", 0, "Easy Run");
        moved["weekNumber"] = json!(1);
        let stale = store.update_current_planned_sessions(&UpdateCurrentPlannedSessionsInput {
            owner_id: DEFAULT_OWNER_ID,
            expected_revision: 0,
            mode: "move_occurrence",
            sessions: std::slice::from_ref(&moved),
            reason_code: None,
            reason_note: None,
        });
        assert_eq!(
            stale.unwrap_err().code(),
            AthriaErrorCode::PlannedSessionRevisionConflict
        );

        moved["weekNumber"] = json!(9);
        let unknown_week =
            store.update_current_planned_sessions(&UpdateCurrentPlannedSessionsInput {
                owner_id: DEFAULT_OWNER_ID,
                expected_revision: 1,
                mode: "move_occurrence",
                sessions: std::slice::from_ref(&moved),
                reason_code: None,
                reason_note: None,
            });
        assert_eq!(
            unknown_week.unwrap_err().code(),
            AthriaErrorCode::PlanWeekNotFound
        );
        assert_eq!(store.schedule_revision(DEFAULT_OWNER_ID).unwrap(), 1);
    }

    #[test]
    fn saving_a_scheduled_date_replaces_or_appends_that_days_occurrences() {
        let store = store();
        store.save_current_plan(&plan(), 0).unwrap();
        let mut appended = session("s3", "2026-09-10", 1, "Recovery Run");
        appended["weekNumber"] = json!(1);
        let saved = store
            .save_current_planned_sessions(&SaveCurrentPlannedSessionsInput {
                owner_id: DEFAULT_OWNER_ID,
                client_request_id: "request-1",
                scheduled_date: "2026-09-10",
                expected_revision: 1,
                mode: "append",
                sessions: std::slice::from_ref(&appended),
            })
            .unwrap();
        assert_eq!(saved["revision"], json!(2));
        assert_eq!(saved["idempotentReplay"], json!(false));
        assert_eq!(saved["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(saved["sessions"][1]["id"], json!("s3"));
        assert_eq!(store.schedule_revision(DEFAULT_OWNER_ID).unwrap(), 2);
    }
}
