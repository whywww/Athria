//! Readers shared by the schema-shape normalizers.
//!
//! The TypeScript implementation validates and normalizes input documents with
//! Zod: unknown keys are rejected (`.strict()`), missing keys take their schema
//! default, and the parsed object is rebuilt in schema declaration order. The
//! Rust port reproduces the *output* of that parse — defaults applied, fields in
//! schema order — for the documents that cross the application boundary.
//! Validation failures surface as [`AthriaErrorCode::InvalidData`]; the
//! transports own user-facing message formatting.
//!
//! `serde_json` is built with `preserve_order`, so a normalizer inserts keys in
//! schema declaration order and the document serializes in that same order.

use serde_json::{Map, Value};

use crate::{AthriaError, AthriaErrorCode, Result};

/// Schema violation on the document being parsed.
pub(crate) fn invalid(path: &str, message: &str) -> AthriaError {
    AthriaError::new(AthriaErrorCode::InvalidData, format!("{path}: {message}"))
}

pub(crate) fn invalid_type(path: &str, expected: &str) -> AthriaError {
    invalid(path, &format!("expected {expected}"))
}

/// The object entries of `value`, or a schema violation.
pub(crate) fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid_type(path, "an object"))
}

pub(crate) fn array<'a>(value: &'a Value, path: &str) -> Result<&'a [Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid_type(path, "an array"))
}

/// `value[key]`, with `null` for anything missing.
pub(crate) fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// A required string field.
pub(crate) fn required_text(value: &Value, key: &str, path: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid_type(&format!("{path}.{key}"), "a string"))
}

/// A required, trimmed string field.
pub(crate) fn required_trimmed(value: &Value, key: &str, path: &str) -> Result<String> {
    Ok(required_text(value, key, path)?.trim().to_owned())
}

/// A string field with a schema default.
pub(crate) fn text_or(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

/// A nullable string field: missing, `null`, and non-strings all parse as
/// `null`, matching `z.string().nullable()`.
pub(crate) fn text_or_null(value: &Value, key: &str) -> Value {
    match value.get(key).and_then(Value::as_str) {
        Some(text) => Value::String(text.to_owned()),
        None => Value::Null,
    }
}

/// `z.string().trim()` with a schema default.
pub(crate) fn trimmed_or(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or(fallback)
        .to_owned()
}

/// An enum field with a schema default: values outside `allowed` fall back.
pub(crate) fn enum_or(value: &Value, key: &str, allowed: &[&str], fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|candidate| allowed.contains(candidate))
        .unwrap_or(fallback)
        .to_owned()
}

/// An integer field with a schema default.
pub(crate) fn int_or(value: &Value, key: &str, fallback: i64) -> Value {
    Value::from(value.get(key).and_then(Value::as_i64).unwrap_or(fallback))
}

/// A required integer field.
pub(crate) fn required_int(value: &Value, key: &str, path: &str) -> Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid_type(&format!("{path}.{key}"), "an integer"))
}

/// A required enum field: the value must be one of `allowed`.
pub(crate) fn required_enum(
    value: &Value,
    key: &str,
    allowed: &[&str],
    path: &str,
) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|candidate| allowed.contains(candidate))
        .map(str::to_owned)
        .ok_or_else(|| invalid(&format!("{path}.{key}"), "unexpected value"))
}

/// A required `dateSchema` field: the strict `^\d{4}-\d{2}-\d{2}$` form.
pub(crate) fn required_date(value: &Value, key: &str, path: &str) -> Result<String> {
    let date = required_text(value, key, path)?;
    if !is_iso_date(&date) {
        return Err(invalid(&format!("{path}.{key}"), "expected YYYY-MM-DD"));
    }
    Ok(date)
}

/// `planWorkoutMatchSummarySchema.nullable()` read from `key`.
pub(crate) fn match_summary_or_null(value: &Value, key: &str) -> Value {
    let Some(match_value) = value.get(key).filter(|item| !item.is_null()) else {
        return Value::Null;
    };
    let method = enum_or(match_value, "method", &["auto", "manual"], "");
    match (
        match_value.get("plannedSessionId").and_then(Value::as_str),
        method.is_empty(),
    ) {
        (Some(planned_session_id), false) => {
            serde_json::json!({ "plannedSessionId": planned_session_id, "method": method })
        }
        _ => Value::Null,
    }
}

/// `z.enum(values).nullable()`: missing, `null` and unknown values parse as
/// `null`.
pub(crate) fn nullable_enum(value: &Value, key: &str, allowed: &[&str]) -> Value {
    match value
        .get(key)
        .and_then(Value::as_str)
        .filter(|candidate| allowed.contains(candidate))
    {
        Some(candidate) => Value::String(candidate.to_owned()),
        None => Value::Null,
    }
}

/// `z.number().int().nullable()`.
pub(crate) fn nullable_int(value: &Value, key: &str) -> Value {
    match value.get(key).and_then(Value::as_i64) {
        Some(number) => Value::from(number),
        None => Value::Null,
    }
}

/// `dateSchema`: the strict `^\d{4}-\d{2}-\d{2}$` form.
pub(crate) use crate::date::is_iso_date;

/// A nullable numeric field.
pub(crate) fn number_or_null(value: &Value, key: &str) -> Value {
    match value.get(key).and_then(Value::as_f64) {
        Some(number) => crate::js_number(number),
        None => Value::Null,
    }
}

/// `z.array(z.string())` with a schema default.
pub(crate) fn text_array_or(value: &Value, key: &str, fallback: &[&str]) -> Value {
    let items = match value.get(key).and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|text| Value::String(text.to_owned()))
            .collect(),
        None => fallback
            .iter()
            .map(|text| Value::String((*text).to_owned()))
            .collect(),
    };
    Value::Array(items)
}

/// `z.array(z.enum(ids))` with a schema default of every allowed id.
pub(crate) fn enum_array_or(
    value: &Value,
    key: &str,
    allowed: &[&str],
    fallback: &[&str],
) -> Value {
    let items = match value.get(key).and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|candidate| allowed.contains(candidate))
            .map(|text| Value::String(text.to_owned()))
            .collect(),
        None => fallback
            .iter()
            .map(|text| Value::String((*text).to_owned()))
            .collect(),
    };
    Value::Array(items)
}
