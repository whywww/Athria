//! Helpers for reading the schema-validated JSON documents that cross the core
//! boundary and for building JSON-only results.
//!
//! The TypeScript core is duck-typed over Zod-parsed objects; the port keeps
//! the same contract by reading [`serde_json::Value`] directly. Inputs are
//! validated before they reach the core (the application boundary owns Zod /
//! JSON-schema validation), so missing or mistyped fields are programming
//! errors and surface as panics, matching the TypeScript `undefined`
//! dereference behavior.

use serde_json::{Map, Value};

pub(crate) static NULL: Value = Value::Null;

/// Builds a JSON number that matches `JSON.stringify` formatting for doubles:
/// integral values become integers (`3`, not `3.0`). Every store write and
/// application response funnels through this so a Rust-produced document is
/// byte-identical to its TypeScript equivalent.
pub fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

pub(crate) fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&NULL)
}

pub(crate) fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    field(value, key).as_str().unwrap_or_else(|| panic!("expected `{key}` to be a string"))
}

pub(crate) fn optional_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    field(value, key).as_str()
}

pub(crate) fn int_field(value: &Value, key: &str) -> i64 {
    field(value, key).as_i64().unwrap_or_else(|| panic!("expected `{key}` to be an integer"))
}

pub(crate) fn number_field(value: &Value, key: &str) -> f64 {
    field(value, key).as_f64().unwrap_or_else(|| panic!("expected `{key}` to be a number"))
}

pub(crate) fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    field(value, key).as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("expected `{key}` to be an array"))
}

/// `value.key == null` under JavaScript's loose equality: missing or `null`.
pub(crate) fn is_null_or_missing(value: &Value, key: &str) -> bool {
    matches!(value.get(key), None | Some(Value::Null))
}

/// `value === null` for an explicitly present field.
pub(crate) fn is_null(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null))
}

/// Accumulates `amount` under `key`, mirroring the TypeScript record patterns
/// `counts[key] = (counts[key] ?? 0) + amount`.
pub(crate) fn bump(counts: &mut Map<String, Value>, key: &str, amount: f64) {
    let current = counts.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    counts.insert(key.to_string(), number(current + amount));
}
