//! Named data sources: a source name plus params a loader fetches by.

use serde_json::{Map, Value};

use crate::js::{encode_uri_component, js_typeof, json_stringify, utf16_cmp};

/// One request for data: which source, with which params.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceRef {
    /// The source's name (`"feed"`).
    pub source: String,
    /// What to load. Key order does not change the id.
    pub params: Map<String, Value>,
}

/// The id of a source request, the same text `sourceId` writes in
/// `@pond-ts/process`: `source:name?key=type%3Ajson&…`, keys sorted.
pub fn source_id(r: &SourceRef) -> String {
    let mut keys: Vec<&String> = r.params.keys().collect();
    keys.sort_by(|a, b| utf16_cmp(a, b));
    let params = keys
        .iter()
        .map(|k| {
            let v = &r.params[k.as_str()];
            format!(
                "{}={}",
                encode_uri_component(k),
                encode_uri_component(&format!("{}:{}", js_typeof(v), json_stringify(v)))
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    let name = encode_uri_component(&r.source);
    if params.is_empty() {
        format!("source:{name}")
    } else {
        format!("source:{name}?{params}")
    }
}
