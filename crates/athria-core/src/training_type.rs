//! Canonical activity types. Subtypes describe the source, never matching eligibility.
use serde_json::{Value, json};

pub const TYPES: &[(&str, &str, &[&str])] = &[
    ("StrengthTraining", "strength", &["strengthtraining", "weighttraining"]),
    ("Swim", "endurance", &["swim", "poolswim", "openwaterswim"]),
    ("Run", "endurance", &["run", "running", "trailrun", "virtualrun"]),
    ("Ride", "endurance", &["ride", "cycling", "virtualride", "mountainbikeride", "gravelride", "trackride", "cyclocross", "ebikeride", "emountainbikeride"]),
    ("Rowing", "endurance", &["rowing", "virtualrow"]),
    ("Hike", "endurance", &["hike", "hiking"]),
    ("Walk", "endurance", &["walk", "walking"]),
    ("Tennis", "sport_skill", &["tennis"]),
    ("TableTennis", "sport_skill", &["tabletennis"]),
    ("Badminton", "sport_skill", &["badminton"]),
    ("Padel", "sport_skill", &["padel"]),
    ("Pickleball", "sport_skill", &["pickleball"]),
    ("Squash", "sport_skill", &["squash"]),
    ("Racquetball", "sport_skill", &["racquetball"]),
    ("Basketball", "sport_skill", &["basketball"]),
    ("Yoga", "mind_body", &["yoga"]),
    ("Pilates", "mind_body", &["pilates"]),
    ("Mobility", "mobility", &["mobility", "stretching", "recovery"]),
    ("FunctionalTraining", "functional", &["functionaltraining", "functionalstrengthtraining", "crossfit", "hiit", "highintensityintervaltraining", "hyrox"]),
];

pub fn token(value: &str) -> String {
    value.to_ascii_lowercase().chars().filter(char::is_ascii_alphanumeric).collect()
}

pub fn classify(value: &str) -> Option<(&'static str, Option<String>, &'static str)> {
    let value = match value.trim() {
        "跑步" | "跑步机" => "Run", "游泳" => "Swim", "泳池游泳" => "PoolSwim", "开放水域游泳" => "OpenWaterSwim",
        "骑行" | "骑车" => "Ride", "划船" | "划船机" => "Rowing", "徒步" => "Hike", "步行" | "走路" => "Walk",
        "力量训练" | "力量" => "StrengthTraining", "瑜伽" => "Yoga", "普拉提" => "Pilates", "拉伸" => "Stretching",
        _ => value,
    };
    let key = token(value);
    let (kind, domain, _) = TYPES.iter().find(|(_, _, aliases)| aliases.contains(&key.as_str()))?;
    let subtype = if key == token(kind) || matches!(key.as_str(), "weighttraining" | "running" | "cycling" | "hiking" | "walking") {
        None
    } else if key == "highintensityintervaltraining" { Some("hiit".to_owned()) } else { Some(key) };
    Some((*kind, subtype, *domain))
}

/// Shared input normalization for stored records and whole planned sessions.
/// Legacy sport is an input alias only; modality never participates.
pub fn fields(value: &Value) -> (Value, Value) {
    let raw = value.get("type").and_then(Value::as_str).filter(|v| !v.trim().is_empty())
        .or_else(|| value.get("sport").and_then(Value::as_str).filter(|v| !v.trim().is_empty()));
    let classified = raw.and_then(classify);
    let kind = classified.as_ref().map(|(kind, _, _)| *kind).or(raw);
    let subtype = if kind == Some("StrengthTraining") { None } else {
        value.get("subtype").and_then(Value::as_str).map(token).filter(|v| !v.is_empty())
            .or_else(|| classified.and_then(|(_, subtype, _)| subtype))
    };
    (kind.map(|kind| json!(kind)).unwrap_or(Value::Null), subtype.map(Value::String).unwrap_or(Value::Null))
}

pub fn domains(kind: Option<&str>) -> Value {
    kind.and_then(classify).map(|(_, _, domain)| json!([domain])).unwrap_or_else(|| json!([]))
}

/// A planned session owns one domain. Known activity types are authoritative;
/// an explicit domain can preserve classification when the activity is unknown.
pub fn session_domain(session: &Value) -> Option<&str> {
    let (kind, _) = fields(session);
    kind.as_str().and_then(classify).map(|(_, _, domain)| domain)
        .or_else(|| session["domain"].as_str().filter(|domain| crate::vocab::DOMAIN_IDS.contains(domain)))
}

/// One-time upgrade of the legacy component classification. Never guesses an
/// activity type from a broad domain, and leaves conflicting domains unknown.
pub fn migrate_session_domains(value: &mut Value) {
    match value {
        Value::Array(items) => for item in items { migrate_session_domains(item); },
        Value::Object(object) => {
            // Capture legacy timeline associations before removing component fields.
            let legacy_progressions = if object.contains_key("weeks") { object.get("domainProgressions").and_then(Value::as_array).cloned() } else { None };
            let mut timeline_sources: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
            if legacy_progressions.is_some() {
                for week in object.get("weeks").and_then(Value::as_array).into_iter().flatten() {
                    for session in week["sessions"].as_array().into_iter().flatten() {
                        if let Some(target) = session_domain(session) {
                            let sources = timeline_sources.entry(target.to_owned()).or_default();
                            for component in session["components"].as_array().into_iter().flatten() {
                                if let Some(source) = component["domain"]["value"].as_str() {
                                    if !sources.iter().any(|existing| existing == source) { sources.push(source.to_owned()); }
                                }
                            }
                        }
                    }
                }
            }
            if object.contains_key("components") && object.contains_key("name") {
                let mut session = Value::Object(object.clone());
                let resolved = session_domain(&session).map(str::to_owned).or_else(|| {
                    let mut domains = std::collections::BTreeSet::new();
                    for component in session["components"].as_array().into_iter().flatten() {
                        if let Some(domain) = component["domain"]["value"].as_str().filter(|domain| crate::vocab::DOMAIN_IDS.contains(domain)) { domains.insert(domain); }
                    }
                    if domains.len() == 1 { domains.first().map(|domain| (*domain).to_owned()) } else { None }
                });
                object.insert("domain".into(), resolved.map(Value::String).unwrap_or(Value::Null));
                for component in object.get_mut("components").and_then(Value::as_array_mut).into_iter().flatten() {
                    if let Some(component) = component.as_object_mut() { component.remove("domain"); }
                }
                session["domain"] = object["domain"].clone();
                if let Some(refs) = object.get_mut("phaseRefs").and_then(Value::as_array_mut) {
                    refs.retain(|reference| reference["domain"].as_str() == session_domain(&session));
                }
            }
            for child in object.values_mut() { migrate_session_domains(child); }
            if let Some(original) = legacy_progressions {
                let domains: std::collections::BTreeSet<String> = object.get("weeks").and_then(Value::as_array).into_iter().flatten()
                    .flat_map(|week| week["sessions"].as_array().into_iter().flatten())
                    .filter_map(session_domain).map(str::to_owned).collect();
                let mut progressions = Vec::new();
                for domain in &domains {
                    if let Some(existing) = original.iter().find(|progression| progression["domain"].as_str() == Some(domain.as_str())) {
                        progressions.push(existing.clone());
                        continue;
                    }
                    let sources = timeline_sources.get(domain).cloned().unwrap_or_default();
                    let mut timelines: Vec<&Value> = original.iter().filter(|progression| progression["domain"].as_str().is_some_and(|source| sources.iter().any(|candidate| candidate == source))).collect();
                    // Earlier migrations may already have renamed the content domain.
                    // Preserve its remaining timelines rather than discard written plans.
                    if timelines.is_empty() {
                        timelines = original.iter().filter(|progression| progression["domain"].as_str().is_some_and(|source| !domains.contains(source))).collect();
                    }
                    if timelines.is_empty() { continue; }
                    // Merge source timeline boundaries, retaining every phase's written strategies.
                    let mut boundaries = std::collections::BTreeSet::new();
                    for timeline in &timelines {
                        for phase in timeline["phases"].as_array().into_iter().flatten() {
                            if let (Some(start), Some(end)) = (phase["startWeek"].as_i64(), phase["endWeek"].as_i64()) {
                                boundaries.insert(start); boundaries.insert(end + 1);
                            }
                        }
                    }
                    let boundaries: Vec<i64> = boundaries.into_iter().collect();
                    let mut phases = Vec::new();
                    for bounds in boundaries.windows(2) {
                        let active: Vec<&Value> = timelines.iter().flat_map(|timeline| timeline["phases"].as_array().into_iter().flatten())
                            .filter(|phase| phase["startWeek"].as_i64().is_some_and(|start| start <= bounds[0]) && phase["endWeek"].as_i64().is_some_and(|end| end >= bounds[0])).collect();
                        if active.is_empty() { continue; }
                        let mut phase = active[0].clone();
                        phase["id"] = json!(format!("session-{domain}-{}", bounds[0]));
                        phase["startWeek"] = json!(bounds[0]); phase["endWeek"] = json!(bounds[1] - 1);
                        for key in ["name", "focus"] {
                            phase[key] = json!(active.iter().filter_map(|phase| phase[key].as_str()).collect::<Vec<_>>().join(" / "));
                        }
                        let mut strategies = Vec::new();
                        for source in &active { for strategy in source["progression"].as_array().into_iter().flatten() {
                            if !strategies.contains(strategy) { strategies.push(strategy.clone()); }
                        } }
                        phase["progression"] = json!(strategies);
                        phases.push(phase);
                    }
                    progressions.push(json!({"domain":domain,"phases":phases}));
                }
                object.insert("domainProgressions".into(), json!(progressions));
            }
        },
        _ => {},
    }
}

/// Explicit legacy plan-name aliases; ambiguous names remain unclassified.
pub fn infer_name(name: &str) -> Option<&'static str> {
    let words = name.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' }).collect::<String>();
    let padded = format!(" {} ", words.split_whitespace().collect::<Vec<_>>().join(" "));
    let aliases: &[(&str, &[&str], &[&str])] = &[
        ("StrengthTraining", &["strength", "strength training", "strengthtraining", "weight training", "weighttraining", "weights"], &["力量训练", "力量", "抗阻"]),
        ("Swim", &["swim", "swimming", "pool swim", "poolswim", "open water swim", "openwaterswim"], &["游泳"]),
        ("Run", &["run", "running", "jog", "jogging", "trail run", "trailrun", "virtual run", "virtualrun"], &["跑步", "慢跑"]),
        ("Ride", &["ride", "cycling", "bike", "virtualride", "mountainbikeride", "gravelride", "trackride", "cyclocross", "ebikeride", "emountainbikeride"], &["骑行", "骑车"]),
        ("Rowing", &["row", "rowing", "virtualrow", "virtual row"], &["划船"]),
        ("Hike", &["hike", "hiking"], &["徒步"]),
        ("Walk", &["walk", "walking"], &["步行", "散步"]),
        ("Tennis", &["tennis"], &["网球"]),
        ("TableTennis", &["table tennis", "tabletennis", "ping pong"], &["乒乓球"]),
        ("Badminton", &["badminton"], &["羽毛球"]),
        ("Padel", &["padel"], &["板式网球"]),
        ("Pickleball", &["pickleball"], &["匹克球"]),
        ("Squash", &["squash"], &["壁球"]),
        ("Racquetball", &["racquetball"], &["短柄墙球"]),
        ("Basketball", &["basketball"], &["篮球"]),
        ("Yoga", &["yoga"], &["瑜伽"]),
        ("Pilates", &["pilates"], &["普拉提"]),
        ("Mobility", &["mobility", "stretch", "stretching", "recovery"], &["活动度", "拉伸", "恢复"]),
        ("FunctionalTraining", &["functional", "functionaltraining", "functionalstrengthtraining", "crossfit", "hiit", "high intensity interval training", "highintensityintervaltraining", "hyrox"], &["功能训练", "功能性训练"]),
    ];
    let found: Vec<_> = aliases.iter().filter(|(_, en, zh)| en.iter().any(|word| padded.contains(&format!(" {word} "))) || zh.iter().any(|word| name.contains(word))).map(|(kind, _, _)| *kind).collect();
    // Compound racquet names must not also be treated as generic tennis.
    let found: Vec<_> = found.iter().copied().filter(|kind| {
        !(*kind == "Tennis" && (found.contains(&"TableTennis") || found.contains(&"Padel")))
            && !(*kind == "StrengthTraining" && (padded.contains(" functional strength training ") || padded.contains(" functional strength ")))
    }).collect();
    if found.len() == 1 { Some(found[0]) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_explicit_alias_has_one_domain_and_normalized_subtype() {
        for (kind, domain, aliases) in TYPES {
            for alias in *aliases {
                let normal = classify(alias).unwrap();
                assert_eq!(normal.0, *kind);
                assert_eq!(normal.2, *domain);
                let separated = alias.chars().map(|c| c.to_ascii_uppercase().to_string()).collect::<Vec<_>>().join(" ._-");
                assert_eq!(classify(&separated), Some(normal));
            }
            assert_eq!(classify(kind).unwrap().1, None);
        }
        assert_eq!(classify("WeightTraining"), classify("StrengthTraining"));
        assert_eq!(classify("HIIT"), classify("HighIntensityIntervalTraining"));
        assert_eq!(classify("OpenWaterSwim").unwrap().1.as_deref(), Some("openwaterswim"));
        for unknown in ["", "swimrun", "NotRun", "MySwimmingWorkout"] { assert_eq!(classify(unknown), None); }
        assert_eq!(domains(Some("Unknown")), json!([]));
    }
    #[test]
    fn names_require_explicit_boundaries_and_resolve_conflicts() {
        for (name, kind) in [("午间游泳课", "Swim"), ("Pool Swim lesson", "Swim"), ("TrailRun", "Run"), ("晚间力量训练", "StrengthTraining"), ("Table tennis", "TableTennis"), ("板式网球", "Padel"), ("瑜伽", "Yoga"), ("Hyrox", "FunctionalTraining")] {
            assert_eq!(infer_name(name), Some(kind), "{name}");
        }
        for name in ["Run and Swim", "跑步与游泳", "brunch", "runner", "Unknown", "lower stress"] { assert_eq!(infer_name(name), None, "{name}"); }
    }
}
    #[test]
    fn planned_classification_is_owned_by_the_session() {
        assert_eq!(session_domain(&json!({"type":"Run","domain":"strength","components":[{"domain":{"value":"mobility"}}]})), Some("endurance"));
        assert_eq!(session_domain(&json!({"type":null,"domain":"endurance"})), Some("endurance"));
        assert_eq!(session_domain(&json!({"type":null,"components":[{"domain":{"value":"endurance"}}]})), None);
    }

    #[test]
    fn legacy_content_domains_migrate_without_guessing_activity_identity() {
        let mut sessions = json!([
            {"name":"周末轻松跑走","type":null,"components":[{"domain":{"value":"endurance"},"prescription":{"kind":"duration_only","notes":"Keep it easy"}}]},
            {"name":"Circuit","type":"FunctionalTraining","components":[{"domain":{"value":"strength"}},{"domain":{"value":"endurance"}}]},
            {"name":"Unknown","type":null,"components":[{"domain":{"value":"strength"}},{"domain":{"value":"endurance"}}]}
        ]);
        migrate_session_domains(&mut sessions);
        assert_eq!(sessions[0]["domain"], "endurance");
        assert_eq!(sessions[0]["type"], Value::Null);
        assert_eq!(sessions[0]["components"][0]["prescription"]["notes"], "Keep it easy");
        assert_eq!(sessions[1]["domain"], "functional");
        assert_eq!(sessions[2]["domain"], Value::Null);
        for session in sessions.as_array().unwrap() {
            for component in session["components"].as_array().unwrap() { assert!(component.get("domain").is_none()); }
        }
        let migrated = sessions.clone();
        migrate_session_domains(&mut sessions);
        assert_eq!(sessions, migrated);
    }

    #[test]
    fn whole_session_progressions_preserve_mixed_content_strategies() {
        let mut mesocycle = json!({"domainProgressions":[
            {"domain":"strength","phases":[{"id":"lift","phaseType":"foundation","name":"Lifts","focus":"Maintain strength","startWeek":1,"endWeek":2,"progression":["Add a rep"]}]},
            {"domain":"endurance","phases":[{"id":"base","phaseType":"foundation","name":"Aerobic","focus":"Build base","startWeek":1,"endWeek":1,"progression":["Stay easy"]},{"id":"build","phaseType":"progression","name":"Build","focus":"Extend duration","startWeek":2,"endWeek":2,"progression":["Add five minutes"]}]}
        ],"weeks":[{"sessions":[{"name":"Hyrox","type":"FunctionalTraining","components":[{"domain":{"value":"strength"}},{"domain":{"value":"endurance"}}]}]}]});
        migrate_session_domains(&mut mesocycle);
        assert_eq!(mesocycle["domainProgressions"].as_array().unwrap().len(), 1);
        let progression = &mesocycle["domainProgressions"][0];
        assert_eq!(progression["domain"], "functional");
        assert_eq!(progression["phases"][0]["startWeek"], 1);
        assert_eq!(progression["phases"][0]["endWeek"], 1);
        assert_eq!(progression["phases"][1]["startWeek"], 2);
        assert_eq!(progression["phases"][1]["endWeek"], 2);
        assert_eq!(progression["phases"][0]["progression"], json!(["Add a rep","Stay easy"]));
        assert_eq!(progression["phases"][1]["progression"], json!(["Add a rep","Add five minutes"]));
        let migrated = mesocycle.clone();
        migrate_session_domains(&mut mesocycle);
        assert_eq!(mesocycle, migrated);
    }
