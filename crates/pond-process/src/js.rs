//! The few JavaScript text rules ids and messages are built from.
//!
//! An id is a cache key and a column name, and a message is what a caller
//! reads, so both have to come out letter for letter as `@pond-ts/process`
//! writes them. These helpers copy what the JavaScript built-ins do for the
//! values a JSON plan can hold.

use std::cmp::Ordering;

use pond_rs::js_number;
use serde_json::{Map, Value};

/// JavaScript's `String(v)`.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        // `Array.prototype.join`: null and undefined become empty.
        Value::Array(items) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JavaScript's `typeof v`.
pub fn js_typeof(v: &Value) -> &'static str {
    match v {
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
    }
}

/// JavaScript's `JSON.stringify(v)`: numbers as `String(n)` writes them
/// (`1`, not `1.0`), keys in the order they were written.
pub fn json_stringify(v: &Value) -> String {
    let mut out = String::new();
    write_json(v, &mut out);
    out
}

fn write_json(v: &Value, out: &mut String) {
    match v {
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x.is_finite() {
                out.push_str(&js_number(x));
            } else {
                out.push_str("null");
            }
        }
        Value::String(s) => out.push_str(&quote(s)),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&quote(k));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
        Value::Null | Value::Bool(_) => out.push_str(&v.to_string()),
    }
}

/// A string as `JSON.stringify` quotes it. serde_json escapes the same set
/// of characters the same way (`\n`, `\u001f` in lower case), and a Rust
/// string cannot hold the lone surrogates where the two could differ.
fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serialises")
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// How JavaScript orders two strings: by UTF-16 code unit, which differs
/// from Rust's byte order for characters above U+FFFF.
/// An object's keys in the order JavaScript's `Object.keys` gives them:
/// array-index keys (`"0"`, `"7"`, `"10"`, below 2^32 - 1) first and
/// ascending, then the rest in the order they were written.
pub fn js_keys(map: &Map<String, Value>) -> Vec<&String> {
    let index = |k: &str| -> Option<u32> {
        let canonical = k == "0" || (!k.starts_with('0') && k.bytes().all(|b| b.is_ascii_digit()));
        if !canonical || k.is_empty() {
            return None;
        }
        k.parse::<u32>().ok().filter(|n| *n != u32::MAX)
    };
    let mut indexed: Vec<(u32, &String)> = map
        .keys()
        .filter_map(|k| index(k).map(|n| (n, k)))
        .collect();
    indexed.sort_by_key(|(n, _)| *n);
    let mut out: Vec<&String> = indexed.into_iter().map(|(_, k)| k).collect();
    out.extend(map.keys().filter(|k| index(k).is_none()));
    out
}

pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {

    #[test]
    fn keys_in_object_keys_order() {
        let m: Map<String, Value> =
            serde_json::from_str(r#"{"b":0,"10":0,"2":0,"02":0,"a":0,"0":0,"4294967295":0}"#)
                .unwrap();
        let keys: Vec<&str> = js_keys(&m).into_iter().map(String::as_str).collect();
        // "02" is not canonical and 2^32 - 1 is not an array index.
        assert_eq!(keys, ["0", "2", "10", "b", "02", "a", "4294967295"]);
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn string_and_typeof_follow_javascript() {
        assert_eq!(js_string(&json!(1e21)), "1e+21");
        assert_eq!(js_string(&json!(1.0)), "1");
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&json!({"x": 1})), "[object Object]");
        assert_eq!(js_typeof(&json!(null)), "object");
        assert_eq!(
            json_stringify(&json!({"b": [1.5, "x\n"], "a": true})),
            r#"{"b":[1.5,"x\n"],"a":true}"#
        );
    }

    #[test]
    fn uri_component_and_utf16_order() {
        assert_eq!(encode_uri_component("a b/c?é"), "a%20b%2Fc%3F%C3%A9");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        // U+FF61 sorts after U+1F600 in UTF-16, before it in UTF-8.
        assert_eq!(utf16_cmp("\u{1F600}", "\u{FF61}"), Ordering::Less);
    }
}
