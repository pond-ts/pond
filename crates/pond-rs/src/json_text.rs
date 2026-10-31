//! A light JSON tree for the JSON readers: text borrowed from the input
//! where it has no escapes, objects as lists of pairs. Reading straight into
//! it is 2-3 times faster than into [`serde_json::Value`] for pond-ts's
//! row and point shapes, which are many small objects (a `Value` object is a
//! sorted map that owns every key).

use std::borrow::Cow;
use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

/// A JSON value, shaped like [`serde_json::Value`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Json<'a> {
    Null,
    Bool(bool),
    Number(Num),
    String(Cow<'a, str>),
    Array(Vec<Json<'a>>),
    Object(Obj<'a>),
}

/// A JSON number: a whole number that fits `i64`, else an `f64`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Num {
    Int(i64),
    Float(f64),
}

impl Num {
    pub(crate) fn as_i64(self) -> Option<i64> {
        match self {
            Num::Int(v) => Some(v),
            Num::Float(_) => None,
        }
    }

    /// Always `Some`: shaped like `serde_json::Number::as_f64`.
    pub(crate) fn as_f64(self) -> Option<f64> {
        Some(match self {
            Num::Int(v) => v as f64,
            Num::Float(v) => v,
        })
    }
}

impl fmt::Display for Num {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Num::Int(v) => write!(f, "{v}"),
            Num::Float(v) => write!(f, "{}", Value::from(*v)),
        }
    }
}

/// A JSON object, in the order written.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Obj<'a>(Vec<(Cow<'a, str>, Json<'a>)>);

impl<'a> Obj<'a> {
    /// The value of `key`; the last one when it is written twice, as
    /// `JSON.parse` and serde_json do.
    pub(crate) fn get(&self, key: &str) -> Option<&Json<'a>> {
        self.0.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// The names and values, in the order written.
    pub(crate) fn entries(&self) -> &[(Cow<'a, str>, Json<'a>)] {
        &self.0
    }

    pub(crate) fn contains_key(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }
}

/// `null`, for a cell that is not there.
pub(crate) const NULL: &Json<'static> = &Json::Null;

impl<'a> Json<'a> {
    /// The value under `key` of an object; `None` for anything else.
    pub(crate) fn get(&self, key: &str) -> Option<&Json<'a>> {
        match self {
            Json::Object(o) => o.get(key),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&Vec<Json<'a>>> {
        match self {
            Json::Array(a) => Some(a),
            _ => None,
        }
    }

    pub(crate) fn as_object(&self) -> Option<&Obj<'a>> {
        match self {
            Json::Object(o) => Some(o),
            _ => None,
        }
    }

    /// Borrow a parsed [`serde_json::Value`] (its text is not copied).
    pub(crate) fn from_value(value: &'a Value) -> Self {
        match value {
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Number(n) => Json::Number(match n.as_i64() {
                Some(v) => Num::Int(v),
                None => Num::Float(n.as_f64().expect("JSON numbers are finite")),
            }),
            Value::String(s) => Json::String(Cow::Borrowed(s)),
            Value::Array(a) => Json::Array(a.iter().map(Json::from_value).collect()),
            Value::Object(o) => Json::Object(Obj(o
                .iter()
                .map(|(k, v)| (Cow::Borrowed(k.as_str()), Json::from_value(v)))
                .collect())),
        }
    }

    /// As a [`serde_json::Value`], for messages.
    fn to_value(&self) -> Value {
        match self {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(Num::Int(v)) => Value::from(*v),
            Json::Number(Num::Float(v)) => Value::from(*v),
            Json::String(s) => Value::String(s.to_string()),
            Json::Array(a) => Value::Array(a.iter().map(Json::to_value).collect()),
            Json::Object(o) => Value::Object(
                o.0.iter()
                    .map(|(k, v)| (k.to_string(), v.to_value()))
                    .collect(),
            ),
        }
    }
}

impl fmt::Display for Json<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_value())
    }
}

impl<'de> Deserialize<'de> for Json<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(JsonVisitor)
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json<'de>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_unit<E>(self) -> Result<Json<'de>, E> {
        Ok(Json::Null)
    }

    fn visit_bool<E>(self, v: bool) -> Result<Json<'de>, E> {
        Ok(Json::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Json<'de>, E> {
        Ok(Json::Number(Num::Int(v)))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Json<'de>, E> {
        Ok(Json::Number(
            i64::try_from(v).map_or(Num::Float(v as f64), Num::Int),
        ))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Json<'de>, E> {
        Ok(Json::Number(Num::Float(v)))
    }

    fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Json<'de>, E> {
        Ok(Json::String(Cow::Borrowed(v)))
    }

    fn visit_str<E>(self, v: &str) -> Result<Json<'de>, E> {
        Ok(Json::String(Cow::Owned(v.to_owned())))
    }

    fn visit_string<E>(self, v: String) -> Result<Json<'de>, E> {
        Ok(Json::String(Cow::Owned(v)))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json<'de>, A::Error> {
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(v) = seq.next_element()? {
            out.push(v);
        }
        Ok(Json::Array(out))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json<'de>, A::Error> {
        let mut out = Vec::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((k, v)) = map.next_entry::<Key<'de>, Json<'de>>()? {
            out.push((k.0, v));
        }
        Ok(Json::Object(Obj(out)))
    }
}

/// An object key, borrowed when it has no escapes.
struct Key<'a>(Cow<'a, str>);

impl<'de> Deserialize<'de> for Key<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl<'de> Visitor<'de> for KeyVisitor {
            type Value = Key<'de>;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object key")
            }

            fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Borrowed(v)))
            }

            fn visit_str<E>(self, v: &str) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Owned(v.to_owned())))
            }

            fn visit_string<E>(self, v: String) -> Result<Key<'de>, E> {
                Ok(Key(Cow::Owned(v)))
            }
        }
        d.deserialize_str(KeyVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_like_serde_json() {
        for text in [
            r#"{"a":[1,-2,1.5,1e300,18446744073709551615,"x\"y",true,null,{}],"a":3,"b":{"c":"é"}}"#,
            "-0",
            "[]",
            r#""😀""#,
        ] {
            let mine: Json = serde_json::from_str(text).unwrap();
            let theirs: Value = serde_json::from_str(text).unwrap();
            assert_eq!(mine.to_value(), theirs, "{text}");
            assert_eq!(Json::from_value(&theirs).to_value(), theirs, "{text}");
        }
        let o: Json = serde_json::from_str(r#"{"a":1,"a":2}"#).unwrap();
        assert_eq!(o.get("a"), Some(&Json::Number(Num::Int(2))));
    }
}
