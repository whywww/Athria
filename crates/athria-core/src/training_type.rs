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
/// Activity identity comes from the current type field.
pub fn fields(value: &Value) -> (Value, Value) {
    let raw = value.get("type").and_then(Value::as_str).filter(|v| !v.trim().is_empty());
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

}
    #[test]
    fn planned_classification_is_owned_by_the_session() {
        assert_eq!(session_domain(&json!({"type":"Run","domain":"strength","components":[{"domain":{"value":"mobility"}}]})), Some("endurance"));
        assert_eq!(session_domain(&json!({"type":null,"domain":"endurance"})), Some("endurance"));
        assert_eq!(session_domain(&json!({"type":null,"components":[{"domain":{"value":"endurance"}}]})), None);
    }
