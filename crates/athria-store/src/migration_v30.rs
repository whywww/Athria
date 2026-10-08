//! One-time conversion of legacy activity classification and plan vocabulary.
use std::collections::HashMap;
use athria_core::{Result, training_type, schema::parse_training_session};
use rusqlite::params;
use serde_json::{Value, json};
use crate::{SqliteStore, store::database_error};

fn convert(value: &mut Value, links: &HashMap<String, Value>) {
    match value {
        Value::Array(items) => for item in items { convert(item, links); },
        Value::Object(object) => {
            let record = object.contains_key("externalId") && object.contains_key("startAt");
            let planned = object.contains_key("components") && object.contains_key("name");
            if record {
                let raw = object.get("type").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).or_else(|| object.get("sport").and_then(Value::as_str).filter(|v| !v.trim().is_empty())).map(str::to_owned)
                    .or_else(|| match object.get("modality").and_then(Value::as_str) {
                        Some("strength") => Some("StrengthTraining".into()),
                        Some("mixed") => Some("FunctionalTraining".into()),
                        Some("recovery") => Some("Mobility".into()),
                        _ if object.get("strengthSets").and_then(Value::as_array).is_some_and(|sets| !sets.is_empty()) => {
                            if object.get("endurance").is_some_and(|e| e["distanceMeters"].as_f64().is_some_and(|distance| distance > 0.0)) { Some("FunctionalTraining".into()) }
                            else { Some("StrengthTraining".into()) }
                        },
                        _ => None,
                    });
                object.insert("type".into(), raw.map(Value::String).unwrap_or(Value::Null));
                object.remove("sport");
                object.remove("modality");
                return;
            }
            if planned {
                let kind = object.get("id").and_then(Value::as_str).and_then(|id| links.get(id)).and_then(|v| v.get("type")).and_then(Value::as_str).and_then(training_type::classify).map(|(kind, _, _)| kind)
                    .or_else(|| object.get("name").and_then(Value::as_str).and_then(training_type::infer_name));
                object.insert("type".into(), kind.map(|v| json!(v)).unwrap_or(Value::Null));
                object.insert("subtype".into(), Value::Null);
            }
            for (key, item) in object.iter_mut() {
                if key == "domain" && item == "recovery" { *item = json!("mobility"); }
                if key == "domain" && item.is_object() && item["value"] == "recovery" { item["value"] = json!("mobility"); }
                if key == "kind" && item == "recovery" { *item = json!("mobility"); }
                if key == "domains" {
                    if let Some(items) = item.as_array_mut() { for domain in items { if domain == "recovery" { *domain = json!("mobility"); } } }
                }
                convert(item, links);
            }
            // Components keep their own content, while explicit Yoga/Pilates and
            // functional sessions repair the legacy single-domain classification.
            let inferred = object.get("type").and_then(Value::as_str)
                .or_else(|| object.get("name").and_then(Value::as_str).and_then(training_type::infer_name));
            let mapped = inferred.and_then(training_type::classify).map(|(_, _, domain)| domain);
            if matches!(mapped, Some("mind_body" | "functional")) {
                let target = mapped.unwrap();
                if object.contains_key("prescription") && object.get("domain").is_some_and(Value::is_object)
                    && (target == "functional" || !matches!(object["prescription"]["kind"].as_str(), Some("strength" | "endurance" | "sport_skill"))) {
                    object["domain"]["value"] = json!(target);
                    if object["prescription"]["kind"] == "recovery" || object["prescription"]["kind"] == "mobility" {
                        object["prescription"]["kind"] = json!(target);
                    }
                }
                if planned {
                    let domains: std::collections::HashSet<_> = object["components"].as_array().into_iter().flatten()
                        .filter_map(|c| c["domain"]["value"].as_str()).collect();
                    let compatible = target == "functional" || object["components"].as_array().into_iter().flatten()
                        .all(|c| !matches!(c["prescription"]["kind"].as_str(), Some("strength" | "endurance" | "sport_skill")));
                    if domains.len() == 1 && compatible {
                        for component in object.get_mut("components").and_then(Value::as_array_mut).into_iter().flatten() {
                            component["domain"]["value"] = json!(target);
                            if matches!(component["prescription"]["kind"].as_str(), Some("mobility" | "mind_body")) { component["prescription"]["kind"] = json!(target); }
                        }
                        for phase in object.get_mut("phaseRefs").and_then(Value::as_array_mut).into_iter().flatten() { phase["domain"] = json!(target); }
                    }
                }
            }
            // A template has a single field describing its default domain.
            if object.contains_key("nodes") {
                if let Some(kind) = object.get("name").and_then(Value::as_str).and_then(training_type::infer_name) {
                    let target = training_type::domains(Some(kind))[0].clone();
                    if target == "mind_body" && object.get("domain") != Some(&target) {
                        for node in object.get_mut("nodes").and_then(Value::as_array_mut).into_iter().flatten() {
                            node["role"] = json!("practice_flow");
                            for key in ["variables", "optionalVariables"] {
                                if let Some(variables) = node.get_mut(key).and_then(Value::as_array_mut) {
                                    variables.retain(|v| matches!(v.as_str(), Some("duration" | "intensity" | "instructions" | "technique")));
                                }
                            }
                        }
                    }
                    if target == "functional" {
                        let allowed = athria_core::schema::template_variables()["functional"].clone();
                        for node in object.get_mut("nodes").and_then(Value::as_array_mut).into_iter().flatten() {
                            if !matches!(node["role"].as_str(), Some("primary" | "secondary" | "accessory" | "trunk" | "warm_up" | "steady" | "repeat_work_recovery" | "cool_down")) { node["role"] = json!("steady"); }
                            for key in ["variables", "optionalVariables"] {
                                if let Some(variables) = node.get_mut(key).and_then(Value::as_array_mut) { variables.retain(|v| allowed.as_array().unwrap().contains(v)); }
                            }
                        }
                    }
                    if matches!(target.as_str(), Some("mind_body" | "functional")) { object.insert("domain".into(), target); }
                }
            }
        },
        _ => {},
    }
}

fn repair_progressions(value: &mut Value) {
    match value {
        Value::Array(items) => for item in items { repair_progressions(item); },
        Value::Object(object) => {
            for child in object.values_mut() { repair_progressions(child); }
            if let Some(original) = object.get("domainProgressions").and_then(Value::as_array).cloned() {
                fn refs(value: &Value, found: &mut Vec<(String, String)>) {
                    match value {
                        Value::Array(items) => for item in items { refs(item, found); },
                        Value::Object(object) => {
                            if let (Some(domain), Some(id)) = (object.get("domain").and_then(Value::as_str), object.get("phaseId").and_then(Value::as_str)) {
                                found.push((domain.into(), id.into()));
                            }
                            for child in object.values() { refs(child, found); }
                        }, _ => {}
                    }
                }
                let mut needed = Vec::new();
                for child in object.values() { refs(child, &mut needed); }
                let mut progressions = original.clone();
                for (domain, id) in needed {
                    if progressions.iter().any(|p| p["domain"] == domain && p["phases"].as_array().is_some_and(|phases| phases.iter().any(|p| p["id"] == id))) { continue; }
                    let phase = original.iter().flat_map(|p| p["phases"].as_array().into_iter().flatten()).find(|p| p["id"] == id).cloned();
                    if let Some(phase) = phase {
                        if let Some(progression) = progressions.iter_mut().find(|p| p["domain"] == domain) { progression["phases"].as_array_mut().unwrap().push(phase); }
                        else { progressions.push(json!({"domain":domain,"phases":[phase]})); }
                    }
                }
                object.insert("domainProgressions".into(), json!(progressions));
            }
        }, _ => {}
    }
}

fn bump_template_refs(value: &mut Value, templates: &std::collections::HashSet<String>) {
    match value {
        Value::Array(items) => for item in items { bump_template_refs(item, templates); },
        Value::Object(object) => {
            if let Some(reference) = object.get_mut("templateRef") {
                if reference["id"].as_str().is_some_and(|id| templates.contains(id)) {
                    if let Some(revision) = reference["revision"].as_i64() { reference["revision"] = json!(revision + 1); }
                }
            }
            for child in object.values_mut() { bump_template_refs(child, templates); }
        }, _ => {}
    }
}

impl SqliteStore {
    pub(crate) fn convert_v30_data(&self) -> Result<()> {
        let templates: std::collections::HashSet<String> = {
            let mut statement = self.sqlite().prepare("SELECT id FROM session_templates").map_err(database_error)?;
            statement.query_map([], |row| row.get(0)).map_err(database_error)?.collect::<std::result::Result<_, _>>().map_err(database_error)?
        };
        // Source and canonical ids stay untouched; only their document shape changes.
        for table in ["training_session_sources", "training_sessions"] {
            let rows: Vec<(i64, String)> = {
                let mut statement = self.sqlite().prepare(&format!("SELECT rowid, data FROM {table}")).map_err(database_error)?;
                statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(database_error)?.collect::<std::result::Result<_, _>>().map_err(database_error)?
            };
            for (id, raw) in rows {
                let mut value: Value = serde_json::from_str(&raw).map_err(|e| athria_core::AthriaError::new(athria_core::AthriaErrorCode::InvalidData, e.to_string()))?;
                convert(&mut value, &HashMap::new());
                value = parse_training_session(&value)?;
                self.sqlite().execute(&format!("UPDATE {table} SET data = ?1 WHERE rowid = ?2"), params![value.to_string(), id]).map_err(database_error)?;
            }
        }
        let mut links_by_owner: HashMap<String, HashMap<String, Value>> = HashMap::new();
        {
            let mut statement = self.sqlite().prepare("SELECT m.owner_id, m.planned_session_id, s.data FROM plan_workout_matches m JOIN training_sessions s ON s.id=m.training_session_id AND s.owner_id=m.owner_id").map_err(database_error)?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(database_error)?;
            for row in rows {
                let (owner, id, raw) = row.map_err(database_error)?;
                let value = serde_json::from_str(&raw).map_err(|e| athria_core::AthriaError::new(athria_core::AthriaErrorCode::InvalidData, e.to_string()))?;
                links_by_owner.entry(owner).or_default().insert(id, value);
            }
        }
        for table in ["current_mesocycles", "plan_drafts", "session_templates", "profiles"] {
            let rows: Vec<(i64, String, String)> = {
                let mut statement = self.sqlite().prepare(&format!("SELECT rowid, owner_id, data FROM {table}")).map_err(database_error)?;
                statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(database_error)?.collect::<std::result::Result<_, _>>().map_err(database_error)?
            };
            for (id, owner, raw) in rows {
                let mut value: Value = serde_json::from_str(&raw).map_err(|e| athria_core::AthriaError::new(athria_core::AthriaErrorCode::InvalidData, e.to_string()))?;
                convert(&mut value, links_by_owner.get(&owner).unwrap_or(&HashMap::new()));
                repair_progressions(&mut value);
                training_type::migrate_session_domains(&mut value);
                bump_template_refs(&mut value, &templates);
                if matches!(table, "current_mesocycles" | "session_templates") {
                    if let Some(revision) = value.get("revision").and_then(Value::as_i64) { value["revision"] = json!(revision + 1); }
                }
                self.sqlite().execute(&format!("UPDATE {table} SET data = ?1 WHERE rowid = ?2"), params![value.to_string(), id]).map_err(database_error)?;
            }
        }
        let rows: Vec<(i64, String, String)> = {
            let mut statement = self.sqlite().prepare("SELECT w.rowid, d.owner_id, w.data FROM plan_draft_weeks w JOIN plan_drafts d ON d.id=w.draft_id").map_err(database_error)?;
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(database_error)?.collect::<std::result::Result<_, _>>().map_err(database_error)?
        };
        for (id, owner, raw) in rows {
            let mut value: Value = serde_json::from_str(&raw).map_err(|e| athria_core::AthriaError::new(athria_core::AthriaErrorCode::InvalidData, e.to_string()))?;
            convert(&mut value, links_by_owner.get(&owner).unwrap_or(&HashMap::new()));
            repair_progressions(&mut value);
                training_type::migrate_session_domains(&mut value);
            bump_template_refs(&mut value, &templates);
            self.sqlite().execute("UPDATE plan_draft_weeks SET data=?1 WHERE rowid=?2", params![value.to_string(), id]).map_err(database_error)?;
        }
        self.sqlite().execute_batch("UPDATE current_mesocycles SET revision=revision+1; UPDATE plan_drafts SET draft_revision=draft_revision+1, base_plan_revision=base_plan_revision+1; UPDATE session_templates SET revision=revision+1; UPDATE athria_data_version SET version=version+1;").map_err(database_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_records_restore_only_explicit_sport_or_strength_content() {
        for (sport, modality, expected) in [(Some("WeightTraining"), "endurance", Some("StrengthTraining")), (Some("OpenWaterSwim"), "unknown", Some("Swim")), (None, "endurance", None), (None, "strength", Some("StrengthTraining")), (None, "mixed", Some("FunctionalTraining")), (None, "recovery", Some("Mobility"))] {
            let mut value = json!({"id":"r","externalId":"e","source":"manual","name":"Swim","startAt":"2026-10-07T10:00:00Z","endAt":"2026-10-07T11:00:00Z","durationMinutes":60,"type":null,"sport":sport,"modality":modality,"endurance":{"averageHeartRate":130}});
            convert(&mut value, &HashMap::new());
            let value = parse_training_session(&value).unwrap();
            assert_eq!(value["type"], json!(expected));
            assert_eq!(value["domains"], training_type::domains(expected));
        }
    }
    #[test]
    fn linked_type_wins_names_conflict_and_special_domains_are_repaired() {
        let links = HashMap::from([("linked".into(), json!({"type":"Swim"}))]);
        let mut value = json!({"domainProgressions":[{"domain":"recovery","phases":[{"id":"phase"}]}],"sessions":[
            {"id":"linked","name":"Run","components":[]},
            {"id":"ambiguous","name":"Swim and Run","components":[]},
            {"id":"yoga","name":"瑜伽","components":[{"name":"瑜伽","domain":{"value":"recovery"},"prescription":{"kind":"recovery","blocks":[]}}],"phaseRefs":[{"domain":"recovery","phaseId":"phase"}]},
            {"id":"functional","name":"Hyrox","components":[{"name":"Circuit","domain":{"value":"strength"},"prescription":{"kind":"strength","exercises":[]}}]}
        ]});
        convert(&mut value, &links);
        repair_progressions(&mut value);
                training_type::migrate_session_domains(&mut value);
        assert_eq!(value["sessions"][0]["type"], "Swim");
        assert_eq!(value["sessions"][0]["subtype"], Value::Null);
        assert_eq!(value["sessions"][1]["type"], Value::Null);
        assert_eq!(value["sessions"][2]["domain"], "mind_body");
        assert!(value["sessions"][2]["components"][0].get("domain").is_none());
        assert_eq!(value["sessions"][2]["components"][0]["prescription"]["kind"], "mind_body");
        assert_eq!(value["sessions"][3]["domain"], "functional");
        assert_eq!(value["sessions"][3]["components"][0]["prescription"]["kind"], "strength");
        assert_eq!(value["domainProgressions"][1]["domain"], "mind_body");
        assert_eq!(value["domainProgressions"][1]["phases"][0]["id"], "phase");
    }
    #[test]
    fn yoga_and_functional_templates_remain_valid() {
        for name in ["Yoga", "Hyrox"] {
            for (domain, role, variables) in [("endurance", "steady", json!(["duration","heart_rate_zone"])), ("recovery", "mobility", json!(["duration","movement"]))] {
                let mut value = json!({"id":"template","name":name,"intent":"practice","domain":domain,"nodes":[{"role":role,"variables":variables}]});
                convert(&mut value, &HashMap::new());
                athria_core::schema::parse_session_template(&value).unwrap();
            }
        }
    }
}
