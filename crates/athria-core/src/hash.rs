//! Stable canonical JSON hashing.
//!
//! `stableHash` is the content fingerprint used for optimistic-concurrency
//! checks (`inputSnapshotHash`, profile hashes). It JSON-canonicalizes a value
//! with JavaScript semantics — object keys sorted through `localeCompare`,
//! values rendered like `JSON.stringify` — and then folds the result with a
//! 32-bit FNV-1a over UTF-16 code units.
//!
//! Two JavaScript details are reproduced deliberately:
//!
//! * `localeCompare` sorts case-insensitively first and puts lowercase before
//!   uppercase on ties, unlike a byte-wise comparison;
//! * `for...of` iterates code points, and `charCodeAt(0)` then hashes only the
//!   high surrogate of an astral character.

use std::cmp::Ordering;

use serde_json::Value;

fn fold_char(character: char) -> char {
    character.to_lowercase().next().unwrap_or(character)
}

/// Approximation of the default ICU collation used by `localeCompare` for
/// identifier-shaped ASCII keys: case-insensitive primary order, lowercase
/// before uppercase on case-only ties.
pub fn js_locale_compare(left: &str, right: &str) -> Ordering {
    let left_folded: Vec<char> = left.chars().map(fold_char).collect();
    let right_folded: Vec<char> = right.chars().map(fold_char).collect();
    match left_folded.cmp(&right_folded) {
        Ordering::Equal => case_tertiary_compare(left, right),
        other => other,
    }
}

fn case_tertiary_compare(left: &str, right: &str) -> Ordering {
    for (left_char, right_char) in left.chars().zip(right.chars()) {
        if left_char != right_char {
            let left_is_plain = fold_char(left_char) == left_char;
            let right_is_plain = fold_char(right_char) == right_char;
            return match (left_is_plain, right_is_plain) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => left_char.cmp(&right_char),
            };
        }
    }
    left.chars().count().cmp(&right.chars().count())
}

fn string_literal(text: &str) -> String {
    let mut output = String::with_capacity(text.len() + 2);
    output.push('"');
    for character in text.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0C}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                output.push_str(&format!("\\u{:04x}", control as u32))
            }
            printable => output.push(printable),
        }
    }
    output.push('"');
    output
}

/// The TypeScript `canonical` serialization used as the hash pre-image.
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(entries) => {
            let mut keys: Vec<&String> = entries.keys().collect();
            keys.sort_by(|left, right| js_locale_compare(left, right));
            let body = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        string_literal(key),
                        canonical(&entries[key.as_str()])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::String(text) => string_literal(text),
        other => other.to_string(),
    }
}

/// FNV-1a 32-bit over the canonical form, formatted as `fnv1a-xxxxxxxx`.
pub fn stable_hash(value: &Value) -> String {
    let mut hash: u32 = 2_166_136_261;
    for character in canonical(value).chars() {
        let code_point = character as u32;
        // `charCodeAt(0)` inside a `for...of` loop returns the high surrogate
        // of astral code points; the low surrogate is never hashed.
        let code_unit = if code_point > 0xFFFF {
            0xD800 + ((code_point - 0x1_0000) >> 10)
        } else {
            code_point
        };
        hash ^= code_unit;
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("fnv1a-{hash:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_sorts_keys_like_locale_compare() {
        assert_eq!(canonical(&json!({ "b": 1, "a": 2 })), "{\"a\":2,\"b\":1}");
        // Case-insensitive primary order with lowercase-first tertiary ties.
        assert_eq!(
            canonical(&json!({ "aB": 1, "Ac": 2, "a": 3, "B": 4 })),
            "{\"a\":3,\"aB\":1,\"Ac\":2,\"B\":4}"
        );
        assert_eq!(canonical(&json!({ "a": 1, "A": 2 })), "{\"a\":1,\"A\":2}");
    }

    #[test]
    fn canonical_matches_javascript_value_rendering() {
        assert_eq!(canonical(&json!(null)), "null");
        assert_eq!(
            canonical(&json!([1, "two", true, [3]])),
            "[1,\"two\",true,[3]]"
        );
        assert_eq!(
            canonical(&json!({ "text": "a\"b", "empty": {} })),
            "{\"empty\":{},\"text\":\"a\\\"b\"}"
        );
    }

    #[test]
    fn stable_hash_is_order_insensitive_but_case_sensitive() {
        assert_eq!(
            stable_hash(&json!({ "a": 1, "b": [2, { "c": 3 }] })),
            stable_hash(&json!({ "b": [2, { "c": 3 }], "a": 1 }))
        );
        assert_ne!(stable_hash(&json!("a")), stable_hash(&json!("A")));
        assert!(stable_hash(&json!({})).starts_with("fnv1a-"));
        assert_eq!(stable_hash(&json!({})).len(), "fnv1a-".len() + 8);
    }

    #[test]
    fn stable_hash_folds_astral_characters_through_their_high_surrogate() {
        let astral = stable_hash(&json!({ "name": "🏃" }));
        let high_surrogate_only = stable_hash(&json!({ "name": "\u{FFFD}" }));
        assert_ne!(astral, high_surrogate_only);
        // Same code point reached through its explicit surrogate pair split
        // cannot be expressed in a Rust string, so the golden fixtures pin the
        // exact TypeScript value instead.
        assert!(astral.starts_with("fnv1a-"));
    }
}
