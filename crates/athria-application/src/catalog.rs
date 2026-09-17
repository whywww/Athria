//! The built-in template catalog, ported from
//! `packages/application/src/template-catalog.ts` in source order.
//!
//! The catalog is code-defined data: entries are never validated at runtime in
//! TypeScript (the module casts its literals), so the port keeps the same
//! literal key order rather than re-deriving the schema order. Every entry
//! carries `origin: "builtin"` and the catalog version stamped into plan
//! template references.

use serde_json::{Value, json};

use crate::TEMPLATE_CATALOG_VERSION;

fn builtin(template: Value) -> Value {
    let mut entries = template.as_object().cloned().unwrap_or_default();
    entries.insert("origin".into(), json!("builtin"));
    entries.insert("catalogVersion".into(), json!(TEMPLATE_CATALOG_VERSION));
    Value::Object(entries)
}

/// `builtinSessionTemplates`.
pub fn builtin_session_templates() -> Vec<Value> {
    vec![
        builtin(json!({
            "id": "builtin.easy-run", "name": "Easy Run",
            "intent": "Build or maintain low-intensity aerobic capacity at a conversational effort.",
            "domain": "endurance",
            "nodes": [
                { "role": "warm_up", "variables": ["duration"] },
                { "role": "steady", "variables": ["duration"], "optionalVariables": ["distance", "rpe", "talk_test", "strides"] },
                { "role": "cool_down", "variables": ["duration"] },
            ],
        })),
        builtin(json!({
            "id": "builtin.intervals", "name": "Intervals",
            "intent": "Develop high-aerobic or event-specific capacity with repeated work and recovery.",
            "domain": "endurance",
            "nodes": [
                { "role": "warm_up", "variables": ["duration"] },
                { "role": "repeat_work_recovery", "variables": ["repetitions", "recovery_mode"], "optionalVariables": ["duration", "distance", "pace", "heart_rate_zone", "power", "rpe"] },
                { "role": "cool_down", "variables": ["duration"] },
            ],
        })),
        builtin(json!({
            "id": "builtin.long-run", "name": "Long Run",
            "intent": "Develop aerobic endurance and durable time on feet with an optional progressive finish.",
            "domain": "endurance",
            "nodes": [
                { "name": "Easy start", "role": "warm_up", "variables": ["duration"] },
                { "name": "Continuous endurance", "role": "steady", "variables": ["duration"], "optionalVariables": ["distance", "terrain", "rpe", "talk_test"] },
                { "name": "Progressive finish", "role": "steady", "optional": true, "variables": ["duration"], "optionalVariables": ["pace", "rpe"] },
            ],
        })),
        builtin(json!({
            "id": "builtin.lower-strength-a", "name": "Lower Strength A",
            "intent": "Develop or maintain balanced lower-body and trunk strength while allowing exercise choice to vary.",
            "domain": "strength",
            "nodes": [
                { "name": "Squat pattern", "role": "primary", "movementPatternIds": ["squat"], "targetMuscleIds": ["quadriceps", "gluteus_maximus"], "variables": ["exercise_selection", "sets", "repetitions"], "optionalVariables": ["load", "rpe", "rest"] },
                { "name": "Hinge pattern", "role": "secondary", "movementPatternIds": ["hinge"], "targetMuscleIds": ["hamstrings", "gluteus_maximus"], "variables": ["exercise_selection", "sets", "repetitions"], "optionalVariables": ["load", "rpe", "rest"] },
                { "name": "Unilateral lower body", "role": "accessory", "movementPatternIds": ["lunge", "step"], "targetMuscleIds": ["quadriceps", "glutes"], "variables": ["exercise_selection", "sets", "repetitions"], "optionalVariables": ["alternatives"] },
                { "name": "Hip stability", "role": "accessory", "optional": true, "movementPatternIds": ["hip_abduction"], "targetMuscleIds": ["gluteus_medius", "gluteus_minimus"], "variables": ["exercise_selection", "sets", "repetitions"] },
                { "name": "Trunk stability", "role": "trunk", "movementPatternIds": ["anti_rotation", "anti_extension", "trunk_extension"], "targetMuscleIds": ["core"], "variables": ["exercise_selection", "sets"], "optionalVariables": ["repetitions", "duration"] },
            ],
        })),
        builtin(json!({
            "id": "builtin.upper-strength-a", "name": "Upper Strength A",
            "intent": "Develop or maintain balanced upper-body pushing and pulling strength while allowing exercise choice to vary.",
            "domain": "strength",
            "nodes": [
                { "name": "Horizontal push", "role": "primary", "movementPatternIds": ["horizontal_push"], "targetMuscleIds": ["chest"], "variables": ["exercise_selection", "sets", "repetitions"], "optionalVariables": ["load", "rpe"] },
                { "name": "Horizontal pull", "role": "primary", "movementPatternIds": ["horizontal_pull"], "targetMuscleIds": ["back"], "variables": ["exercise_selection", "sets", "repetitions"], "optionalVariables": ["load", "rpe"] },
                { "name": "Vertical push", "role": "secondary", "movementPatternIds": ["vertical_push"], "targetMuscleIds": ["shoulders"], "variables": ["exercise_selection", "sets", "repetitions"] },
                { "name": "Vertical pull", "role": "secondary", "movementPatternIds": ["vertical_pull"], "targetMuscleIds": ["latissimus_dorsi"], "variables": ["exercise_selection", "sets", "repetitions"] },
                { "name": "Arm accessories", "role": "accessory", "optional": true, "movementPatternIds": ["elbow_flexion", "elbow_extension"], "targetMuscleIds": ["biceps_brachii", "triceps_brachii"], "variables": ["exercise_selection", "sets", "repetitions"] },
            ],
        })),
        builtin(json!({
            "id": "builtin.basketball-practice", "name": "Basketball High-intensity Practice",
            "intent": "Develop basketball technique, tactical decisions and repeated game-intensity efforts.",
            "domain": "sport_skill",
            "nodes": [
                { "role": "preparation", "variables": ["duration"] },
                { "role": "technical", "variables": ["drill", "duration"], "optionalVariables": ["intensity"] },
                { "role": "small_sided_game", "variables": ["participants", "duration", "intensity"] },
                { "role": "tactical", "variables": ["drill", "duration"], "optionalVariables": ["position"] },
                { "role": "cool_down", "variables": ["duration"] },
            ],
        })),
        builtin(json!({
            "id": "builtin.mobility-reset", "name": "Mobility Reset",
            "intent": "Support recovery through low-load movement, mobility and down-regulation.",
            "domain": "recovery",
            "nodes": [
                { "role": "down_regulation", "variables": ["duration"] },
                { "role": "mobility", "variables": ["body_region", "movement", "duration"] },
                { "role": "easy_movement", "variables": ["movement", "duration"], "optionalVariables": ["intensity"] },
            ],
        })),
        builtin(json!({
            "id": "builtin.mind-body-reset", "name": "Mind-body Reset",
            "intent": "Practice attention, breathing and gentle integrated movement for a low-load reset.",
            "domain": "mind_body",
            "nodes": [
                { "role": "centering", "variables": ["technique", "duration"] },
                { "role": "practice_flow", "variables": ["technique", "duration"], "optionalVariables": ["intensity"] },
                { "role": "breathing", "variables": ["technique", "duration"] },
                { "role": "down_regulation", "variables": ["duration"], "optionalVariables": ["technique"] },
            ],
        })),
    ]
}

/// The catalog entry for `id`, if the id names a built-in.
pub fn builtin_template(id: &str) -> Option<Value> {
    builtin_session_templates()
        .into_iter()
        .find(|template| template["id"] == json!(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_entries_are_builtin_origin_and_versioned() {
        let templates = builtin_session_templates();
        assert_eq!(templates.len(), 8);
        for template in &templates {
            assert_eq!(template["origin"], json!("builtin"));
            assert_eq!(template["catalogVersion"], json!(TEMPLATE_CATALOG_VERSION));
            assert!(
                template["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("builtin."))
            );
        }
    }

    #[test]
    fn lower_strength_carries_strength_node_shape() {
        let template = builtin_template("builtin.lower-strength-a").unwrap();
        let node = &template["nodes"][0];
        assert_eq!(node["role"], json!("primary"));
        assert_eq!(node["movementPatternIds"], json!(["squat"]));
    }
}
