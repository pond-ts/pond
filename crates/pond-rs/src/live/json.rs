//! Rows written as pond-ts JSON, for `push_json` and `from_json`.

use crate::column::Value;
use crate::error::Result;
use crate::json::{
    LabelCell, RowShape, invalid, read_array, read_label, read_span, read_time, row_cells,
};
use crate::json_text::Json;
use crate::query::EventKey;
use crate::series::{ColumnDef, ColumnKind};

/// Each row as a key and its cells. Times may be text, read in UTC. Cells
/// are checked for kind here and for the rest (required columns, order)
/// when pushed.
pub(crate) fn json_rows(
    call: &'static str,
    schema: &[ColumnDef],
    rows: &[Json],
) -> Result<Vec<(EventKey, Vec<Option<Value>>)>> {
    let tuples: Vec<(String, ColumnKind, bool)> = schema
        .iter()
        .map(|c| (c.name.clone(), c.kind, c.required))
        .collect();
    let cells = row_cells(call, &tuples, rows, RowShape::Rows)?;
    let zone = Some("UTC");
    let mut out = Vec::with_capacity(rows.len());
    for (i, &k) in cells[0].iter().enumerate() {
        let key = match schema[0].kind {
            ColumnKind::Time => EventKey::time(read_time(call, k, i, zone)?),
            ColumnKind::TimeRange => {
                let (b, e) = read_span(call, k, i, false)?;
                EventKey::time_range(read_time(call, b, i, zone)?, read_time(call, e, i, zone)?)
                    .map_err(|e| invalid(call, format!("row {i}: {e}")))?
            }
            _ => {
                let (b, e) = read_span(call, k, i, true)?;
                let label = match k {
                    Json::Array(a) => &a[0],
                    _ => k.get("value").unwrap_or(crate::json_text::NULL),
                };
                let label = match read_label(call, label, i, None)? {
                    LabelCell::Number(v) => crate::query::Label::Number(v),
                    LabelCell::String(s) => crate::query::Label::String(s.to_string()),
                };
                EventKey::interval(
                    label,
                    read_time(call, b, i, zone)?,
                    read_time(call, e, i, zone)?,
                )
                .map_err(|e| invalid(call, format!("row {i}: {e}")))?
            }
        };
        let mut values = Vec::with_capacity(schema.len() - 1);
        for (c, def) in schema.iter().enumerate().skip(1) {
            let v = cells[c][i];
            let wrong = |want: &str| {
                invalid(
                    call,
                    format!("row {i} column '{}': expected {want}, got {v}", def.name),
                )
            };
            values.push(match (def.kind, v) {
                (_, Json::Null) => None,
                (ColumnKind::Number, Json::Number(n)) => n.as_f64().map(Value::Number),
                (ColumnKind::Number, _) => return Err(wrong("a number")),
                (ColumnKind::String, Json::String(s)) => Some(Value::String(s.to_string())),
                (ColumnKind::String, _) => return Err(wrong("a string")),
                (ColumnKind::Boolean, Json::Bool(b)) => Some(Value::Boolean(*b)),
                (ColumnKind::Boolean, _) => return Err(wrong("true or false")),
                (_, Json::Array(a)) => Some(Value::Array(read_array(call, a, i, &def.name)?)),
                (_, _) => return Err(wrong("an array")),
            });
        }
        out.push((key, values));
    }
    Ok(out)
}
