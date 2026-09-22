//! `sessionTemplateSchema` and its stored/builtin/create/update variants.
//!
//! Session-template schema parsing and normalization,
//! 246-247. Templates are a five-way discriminated union on `domain`; the port
//! rebuilds each variant in schema declaration order and enforces the node
//! refinements the TypeScript `superRefine` hooks apply.

use serde_json::{Map, Value, json};

use super::common::*;
use crate::Result;
use crate::vocab::{MOVEMENT_PATTERN_IDS, MUSCLE_GROUP_IDS};

const STRENGTH_ROLES: [&str; 4] = ["primary", "secondary", "accessory", "trunk"];
const ENDURANCE_ROLES: [&str; 4] = ["warm_up", "steady", "repeat_work_recovery", "cool_down"];
const SPORT_ROLES: [&str; 8] = [
    "preparation",
    "technical",
    "tactical",
    "small_sided_game",
    "match",
    "competition",
    "conditioning",
    "cool_down",
];
const RECOVERY_ROLES: [&str; 3] = ["down_regulation", "mobility", "easy_movement"];
const MIND_BODY_ROLES: [&str; 4] = ["centering", "practice_flow", "breathing", "down_regulation"];

const STRENGTH_VARIABLES: [&str; 9] = [
    "exercise_selection",
    "sets",
    "repetitions",
    "duration",
    "load",
    "rpe",
    "rest",
    "tempo",
    "alternatives",
];
const ENDURANCE_VARIABLES: [&str; 12] = [
    "repetitions",
    "duration",
    "distance",
    "pace",
    "heart_rate_zone",
    "power",
    "cadence",
    "rpe",
    "talk_test",
    "terrain",
    "strides",
    "recovery_mode",
];
const SPORT_VARIABLES: [&str; 6] = [
    "drill",
    "participants",
    "position",
    "duration",
    "intensity",
    "instructions",
];
const RECOVERY_VARIABLES: [&str; 5] = [
    "body_region",
    "movement",
    "duration",
    "intensity",
    "instructions",
];
const MIND_BODY_VARIABLES: [&str; 4] = ["technique", "duration", "intensity", "instructions"];

const DOMAINS: [&str; 5] = [
    "strength",
    "endurance",
    "sport_skill",
    "recovery",
    "mind_body",
];

/// `sessionTemplateSchema.parse(value)`.
pub fn parse_session_template(value: &Value) -> Result<Value> {
    object(value, "template")?;
    let domain = enum_or(value, "domain", &DOMAINS, "");
    if domain.is_empty() {
        return Err(invalid("template.domain", "expected a training domain"));
    }
    let mut template = Map::new();
    template.insert(
        "id".into(),
        Value::String(required_text(value, "id", "template")?),
    );
    template.insert(
        "name".into(),
        Value::String(required_text(value, "name", "template")?),
    );
    template.insert(
        "intent".into(),
        Value::String(required_text(value, "intent", "template")?),
    );
    template.insert("domain".into(), Value::String(domain.clone()));
    template.insert("nodes".into(), parse_nodes(value, &domain)?);
    Ok(Value::Object(template))
}

/// `storedSessionTemplateSchema.parse(value)`: the template plus `origin` and
/// `revision`, appended in `extend` order.
pub fn stored_session_template(template: &Value, revision: i64) -> Result<Value> {
    let mut stored = into_entries(parse_session_template(template)?);
    stored.insert("origin".into(), Value::String("user".into()));
    stored.insert("revision".into(), Value::from(revision));
    Ok(Value::Object(stored))
}

/// `builtinSessionTemplateSchema`: the template plus the catalog metadata.
pub fn builtin_session_template(template: &Value, catalog_version: &str) -> Result<Value> {
    let mut stored = into_entries(parse_session_template(template)?);
    stored.insert("origin".into(), Value::String("builtin".into()));
    stored.insert(
        "catalogVersion".into(),
        Value::String(catalog_version.to_owned()),
    );
    Ok(Value::Object(stored))
}

/// The `templateVariables` object `getTrainingTaxonomy` returns, in response
/// key order.
pub fn template_variables() -> Value {
    json!({
        "strength": STRENGTH_VARIABLES,
        "endurance": ENDURANCE_VARIABLES,
        "sport_skill": SPORT_VARIABLES,
        "recovery": RECOVERY_VARIABLES,
        "mind_body": MIND_BODY_VARIABLES,
    })
}

/// `sessionTemplateCreateSchema.parse(value)`: the template plus the optional
/// `clientRequestId` replay key the application strips before storing.
pub fn parse_session_template_create(value: &Value) -> Result<(Value, Option<String>)> {
    let template = parse_session_template(value)?;
    Ok((
        template,
        value
            .get("clientRequestId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    ))
}

/// `sessionTemplateUpdateSchema.parse(value)`.
pub fn parse_session_template_update(value: &Value) -> Result<(Value, i64)> {
    object(value, "templateUpdate")?;
    let template = parse_session_template(get(value, "template"))?;
    let expected_revision = get(value, "expectedRevision")
        .as_i64()
        .ok_or_else(|| invalid_type("templateUpdate.expectedRevision", "an integer"))?;
    Ok((template, expected_revision))
}

fn into_entries(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn parse_nodes(value: &Value, domain: &str) -> Result<Value> {
    let nodes = array(get(value, "nodes"), "template.nodes")?;
    let mut parsed = Vec::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        let path = format!("template.nodes.{index}");
        object(node, &path)?;
        parsed.push(parse_node(node, domain, &path)?);
    }
    Ok(Value::Array(parsed))
}

fn parse_node(node: &Value, domain: &str, path: &str) -> Result<Value> {
    let (roles, variables): (&[&str], &[&str]) = match domain {
        "strength" => (&STRENGTH_ROLES, &STRENGTH_VARIABLES),
        "endurance" => (&ENDURANCE_ROLES, &ENDURANCE_VARIABLES),
        "sport_skill" => (&SPORT_ROLES, &SPORT_VARIABLES),
        "recovery" => (&RECOVERY_ROLES, &RECOVERY_VARIABLES),
        _ => (&MIND_BODY_ROLES, &MIND_BODY_VARIABLES),
    };
    let role = node
        .get("role")
        .and_then(Value::as_str)
        .filter(|role| roles.contains(role))
        .ok_or_else(|| invalid(&format!("{path}.role"), "expected a node role"))?;
    let required_variables = parse_variables(
        node.get("variables"),
        variables,
        &format!("{path}.variables"),
    )?;
    let optional_variables = match node.get("optionalVariables") {
        Some(value) => Some(parse_variables(
            Some(value),
            variables,
            &format!("{path}.optionalVariables"),
        )?),
        None => None,
    };
    if let Some(optional) = &optional_variables {
        if optional
            .iter()
            .any(|variable| required_variables.contains(variable))
        {
            return Err(invalid(
                &format!("{path}.optionalVariables"),
                "required and optional variables must not overlap",
            ));
        }
    }

    let mut parsed = Map::new();
    if let Some(name) = node.get("name").and_then(Value::as_str) {
        parsed.insert("name".into(), Value::String(name.to_owned()));
    }
    parsed.insert("role".into(), Value::String(role.to_owned()));
    if node.get("optional") == Some(&Value::Bool(true)) {
        parsed.insert("optional".into(), Value::Bool(true));
    }
    parsed.insert(
        "variables".into(),
        Value::Array(required_variables.into_iter().map(Value::String).collect()),
    );
    if let Some(optional_variables) = optional_variables {
        parsed.insert(
            "optionalVariables".into(),
            Value::Array(optional_variables.into_iter().map(Value::String).collect()),
        );
    }
    if domain == "strength" {
        let movement = parse_id_list(
            node.get("movementPatternIds"),
            &MOVEMENT_PATTERN_IDS,
            &format!("{path}.movementPatternIds"),
        )?;
        let muscles = parse_id_list(
            node.get("targetMuscleIds"),
            &MUSCLE_GROUP_IDS,
            &format!("{path}.targetMuscleIds"),
        )?;
        if movement.is_none() && muscles.is_none() {
            return Err(invalid(
                &format!("{path}.movementPatternIds"),
                "a strength node needs a movement pattern or target muscle",
            ));
        }
        if let Some(movement) = movement {
            parsed.insert(
                "movementPatternIds".into(),
                Value::Array(movement.into_iter().map(Value::String).collect()),
            );
        }
        if let Some(muscles) = muscles {
            parsed.insert(
                "targetMuscleIds".into(),
                Value::Array(muscles.into_iter().map(Value::String).collect()),
            );
        }
        if node.get("matchPolicy").and_then(Value::as_str) == Some("all") {
            parsed.insert("matchPolicy".into(), Value::String("all".into()));
        }
    }
    Ok(Value::Object(parsed))
}

/// `variables` / `optionalVariables`: the domain vocabulary only, unique
/// (the `validateNodeVariables` refinement).
fn parse_variables(value: Option<&Value>, allowed: &[&str], path: &str) -> Result<Vec<String>> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Err(invalid_type(path, "an array"));
    };
    let mut parsed: Vec<String> = Vec::with_capacity(items.len());
    for entry in items {
        let candidate = entry
            .as_str()
            .filter(|candidate| allowed.contains(candidate))
            .ok_or_else(|| invalid(path, "unknown template variable"))?;
        if parsed.iter().any(|existing| existing == candidate) {
            return Err(invalid(path, "template variables must be unique"));
        }
        parsed.push(candidate.to_owned());
    }
    Ok(parsed)
}

/// An optional `z.array(z.enum(ids)).min(1)`: absent stays absent.
fn parse_id_list(
    value: Option<&Value>,
    allowed: &[&str],
    path: &str,
) -> Result<Option<Vec<String>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let items = array(value, path)?;
    if items.is_empty() {
        return Err(invalid(path, "expected at least one id"));
    }
    let mut parsed = Vec::with_capacity(items.len());
    for entry in items {
        let candidate = entry
            .as_str()
            .filter(|candidate| allowed.contains(candidate))
            .ok_or_else(|| invalid(path, "unknown taxonomy id"))?;
        parsed.push(candidate.to_owned());
    }
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_builtin_endurance_shape_in_schema_order() {
        let template = parse_session_template(&json!({
            "id": "builtin.easy-run", "name": "Easy Run", "intent": "Aerobic base", "domain": "endurance",
            "nodes": [{ "role": "warm_up", "variables": ["duration"] }],
        }))
        .unwrap();
        let keys: Vec<&String> = template.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "name", "intent", "domain", "nodes"]);
        assert_eq!(
            template["nodes"][0],
            json!({ "role": "warm_up", "variables": ["duration"] })
        );
    }

    #[test]
    fn strength_nodes_require_a_movement_pattern_or_target_muscle() {
        let error = parse_session_template(&json!({
            "id": "t1", "name": "Lower", "intent": "Strength", "domain": "strength",
            "nodes": [{ "role": "primary", "variables": ["sets"] }],
        }))
        .unwrap_err();
        assert_eq!(error.code(), crate::AthriaErrorCode::InvalidData);
        assert!(
            error
                .message()
                .contains("movement pattern or target muscle")
        );
    }

    #[test]
    fn optional_variables_must_not_overlap_required_ones() {
        assert!(
            parse_session_template(&json!({
                "id": "t1", "name": "Run", "intent": "Base", "domain": "endurance",
                "nodes": [{ "role": "steady", "variables": ["duration"], "optionalVariables": ["duration"] }],
            }))
            .is_err()
        );
    }

    #[test]
    fn stored_templates_append_origin_and_revision() {
        let stored = stored_session_template(
            &json!({ "id": "t1", "name": "Run", "intent": "Base", "domain": "endurance", "nodes": [{ "role": "steady", "variables": ["duration"] }] }),
            3,
        )
        .unwrap();
        let keys: Vec<&String> = stored.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "id", "name", "intent", "domain", "nodes", "origin", "revision"
            ]
        );
        assert_eq!(stored["origin"], json!("user"));
        assert_eq!(stored["revision"], json!(3));
    }
}
