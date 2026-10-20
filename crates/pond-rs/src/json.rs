//! pond-ts's JSON wire format: [`TimeSeries::from_json`] and
//! [`TimeSeries::to_json`], as pond-ts `TimeSeries.fromJSON` / `toJSON`.

use serde_json::Value;

use crate::column::{BooleanColumn, ColumnData, Float64Column, StringColumn};
use crate::error::{PondError, Result};
use crate::series::{Column, ColumnKind, IntervalKeys, Key, Labels, TimeRangeKeys, TimeSeries};

/// What [`TimeSeries::from_json`] does when a row's key sorts before the
/// row above it, as pond-ts `fromJSON({ ordering })`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyOrder {
    /// Refuse it (pond-ts `'strict'`, the default).
    #[default]
    Strict,
    /// Sort the rows by key (start, then end), keeping the order of rows
    /// with the same key (pond-ts `'reorder'`).
    Reorder,
    /// Keep the rows where they are and move a backwards time up to the
    /// time above it (pond-ts `'clamp'`). Point-in-time keys only: a time
    /// range or interval is refused, even when it is in order.
    Clamp,
}

/// Options for [`TimeSeries::from_json`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonOptions {
    time_zone: String,
    order: KeyOrder,
}

impl Default for JsonOptions {
    fn default() -> Self {
        Self {
            time_zone: "UTC".into(),
            order: KeyOrder::Strict,
        }
    }
}

impl JsonOptions {
    /// Times as text in UTC, keys in order: the defaults, as in pond-ts.
    pub fn new() -> Self {
        Self::default()
    }

    /// The zone that times written as text without an offset are in
    /// (pond-ts `parse: { timeZone }`): an IANA name (`"Europe/Madrid"`) or
    /// a fixed offset (`"+02:00"`).
    pub fn time_zone(mut self, zone: impl Into<String>) -> Self {
        self.time_zone = zone.into();
        self
    }

    /// What to do with keys out of order; see [`KeyOrder`].
    pub fn order(mut self, order: KeyOrder) -> Self {
        self.order = order;
        self
    }
}

/// How [`TimeSeries::to_json`] writes each row, as pond-ts `toJSON({
/// rowFormat })`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RowFormat {
    /// An array in schema order (pond-ts `'array'`, the default).
    #[default]
    Array,
    /// An object keyed by column name (pond-ts `'object'`).
    Object,
}

const FROM: &str = "from_json";
const TO: &str = "to_json";

fn invalid(message: String) -> PondError {
    PondError::InvalidData {
        call: FROM,
        message,
    }
}

impl TimeSeries {
    /// Read a series written in pond-ts's JSON format, as pond-ts
    /// `TimeSeries.fromJSON`.
    ///
    /// The shape is `{ "name", "schema", "rows" }`. `schema` lists the key
    /// column first (`{"name": "time", "kind": "time"}`), then each value
    /// column (`"number"`, `"string"` or `"boolean"`; `"required": false`
    /// allows gaps). Each row is an array in schema order, or an object
    /// keyed by column name ([`RowFormat`]). A gap is `null` (or, in an
    /// object row, a missing name).
    ///
    /// Keys are written as pond-ts writes them:
    ///
    /// | Key kind    | Array row               | Object row                    |
    /// | ----------- | ----------------------- | ----------------------------- |
    /// | `time`      | `1000`                  | `1000`                        |
    /// | `timeRange` | `[begin, end]`          | `{"start", "end"}`            |
    /// | `interval`  | `[label, begin, end]`   | `{"value", "start", "end"}`   |
    ///
    /// On the way in, every time may also be text, read as
    /// [`parse_time_in`](crate::parse_time_in) reads it in
    /// [`JsonOptions::time_zone`] (UTC unless set), and either key form is
    /// accepted in either row form.
    ///
    /// ```
    /// # use pond_rs::{JsonOptions, RowFormat, TimeSeries};
    /// let text = r#"{
    ///   "name": "cpu",
    ///   "schema": [
    ///     {"name": "time", "kind": "time"},
    ///     {"name": "load", "kind": "number", "required": false}
    ///   ],
    ///   "rows": [["2026-03-29T01:30", 0.5], ["2026-03-29T03:30", null]]
    /// }"#;
    /// let s = TimeSeries::from_json(text, &JsonOptions::new().time_zone("Europe/Madrid"))?;
    /// assert_eq!(s.key().begin(), &[1_774_744_200_000, 1_774_747_800_000]);
    /// assert_eq!(
    ///     s.to_json(RowFormat::Array)?,
    ///     r#"{"name":"cpu","schema":[{"name":"time","kind":"time"},{"name":"load","kind":"number","required":false}],"rows":[[1774744200000,0.5],[1774747800000,null]]}"#
    /// );
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Errors, as in pond-ts: text that is not JSON; a schema whose first column is not
    /// `time`, `timeRange` or `interval`, or whose value kinds are not
    /// `number`, `string` or `boolean`; a row of the wrong length; a cell of
    /// the wrong kind; a gap in a required column; a key that cannot be
    /// read, or that ends before it starts; interval labels that are not all
    /// text or all numbers; keys out of order (see [`KeyOrder`]).
    ///
    /// Also errors, where pond-ts accepts: a time that is not a whole
    /// millisecond (`1.5`), or outside ±[`MAX_TIME_MS`](crate::MAX_TIME_MS);
    /// a missing `name`; an `array` column (not in pond-rs yet).
    pub fn from_json(text: &str, options: &JsonOptions) -> Result<TimeSeries> {
        let value: Value = serde_json::from_str(text)
            .map_err(|e| invalid(format!("the text is not JSON: {e}")))?;
        Self::from_json_value(&value, options)
    }

    /// [`TimeSeries::from_json`] from JSON already parsed with
    /// [`serde_json`].
    pub fn from_json_value(value: &Value, options: &JsonOptions) -> Result<TimeSeries> {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("expected a \"name\" that is a string".into()))?;
        let schema = read_schema(value.get("schema"))?;
        let rows = value
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("expected \"rows\" as an array".into()))?;
        let (key_name, key_kind) = (&schema[0].0, schema[0].1);
        if options.order == KeyOrder::Clamp && key_kind != ColumnKind::Time {
            return Err(invalid(format!(
                "KeyOrder::Clamp is for point-in-time keys only; this key is '{}' (use KeyOrder::Reorder, or sort the rows first)",
                key_kind.as_str()
            )));
        }
        let read_time = |v: &Value, row: usize| read_time(v, row, &options.time_zone);

        let n = rows.len();
        let mut begin = Vec::with_capacity(n);
        let mut end = Vec::with_capacity(n);
        let mut labels: Vec<LabelCell> = Vec::new();
        let mut cells: Vec<Vec<&Value>> = vec![Vec::with_capacity(n); schema.len() - 1];
        for (i, row) in rows.iter().enumerate() {
            let at = |c: usize| -> Option<&Value> {
                match row {
                    Value::Array(a) => a.get(c),
                    Value::Object(o) => o.get(&schema[c].0),
                    _ => None,
                }
            };
            match row {
                Value::Array(a) if a.len() != schema.len() => {
                    return Err(invalid(format!(
                        "row {i} has {} values; the schema has {} columns",
                        a.len(),
                        schema.len()
                    )));
                }
                Value::Array(_) | Value::Object(_) => {}
                _ => return Err(invalid(format!("row {i} is not an array or an object"))),
            }
            let key = at(0).unwrap_or(&Value::Null);
            match key_kind {
                ColumnKind::Time => {
                    let t = read_time(key, i)?;
                    begin.push(t);
                }
                ColumnKind::TimeRange => {
                    let (b, e) = read_span(key, i, false)?;
                    begin.push(read_time(b, i)?);
                    end.push(read_time(e, i)?);
                }
                _ => {
                    let (b, e) = read_span(key, i, true)?;
                    let label = match key {
                        Value::Array(a) => &a[0],
                        _ => &key["value"],
                    };
                    labels.push(read_label(label, i, labels.first())?);
                    begin.push(read_time(b, i)?);
                    end.push(read_time(e, i)?);
                }
            }
            if let Some(&b) = end.last()
                && b < *begin.last().expect("pushed with end")
            {
                return Err(invalid(format!(
                    "the key at row {i} ends ({b}) before it starts ({})",
                    begin[i]
                )));
            }
            for (c, cells) in cells.iter_mut().enumerate() {
                cells.push(at(c + 1).unwrap_or(&Value::Null));
            }
        }

        // Rows in the order the series will hold them.
        let order: Option<Vec<usize>> = match options.order {
            KeyOrder::Reorder => {
                let mut order: Vec<usize> = (0..n).collect();
                order.sort_by_key(|&i| (begin[i], end.get(i).copied().unwrap_or(0)));
                Some(order)
            }
            KeyOrder::Clamp => {
                for i in 1..n {
                    begin[i] = begin[i].max(begin[i - 1]);
                }
                None
            }
            KeyOrder::Strict => None,
        };
        let pick = |v: &mut Vec<i64>| {
            if let Some(order) = order.as_ref().filter(|_| !v.is_empty()) {
                *v = order.iter().map(|&i| v[i]).collect();
            }
        };
        pick(&mut begin);
        pick(&mut end);
        let row_at = |r: usize| order.as_ref().map_or(r, |o| o[r]);

        let mut columns = Vec::with_capacity(schema.len() - 1);
        for (c, (col_name, kind, required)) in schema.iter().skip(1).enumerate() {
            let cell = |r: usize| cells[c][row_at(r)];
            let wrong = |r: usize, want: &str| {
                invalid(format!(
                    "row {} column '{col_name}': expected {want}, got {}",
                    row_at(r),
                    cells[c][row_at(r)]
                ))
            };
            let data: ColumnData = match kind {
                ColumnKind::Number => Float64Column::from_options(
                    (0..n)
                        .map(|r| match cell(r) {
                            Value::Null => Ok(None),
                            Value::Number(v) => Ok(v.as_f64()),
                            _ => Err(wrong(r, "a number")),
                        })
                        .collect::<Result<Vec<_>>>()?,
                )
                .into(),
                ColumnKind::String => StringColumn::from_options(
                    (0..n)
                        .map(|r| match cell(r) {
                            Value::Null => Ok(None),
                            Value::String(v) => Ok(Some(v.as_str())),
                            _ => Err(wrong(r, "a string")),
                        })
                        .collect::<Result<Vec<_>>>()?,
                )
                .into(),
                _ => BooleanColumn::from_options(
                    (0..n)
                        .map(|r| match cell(r) {
                            Value::Null => Ok(None),
                            Value::Bool(v) => Ok(Some(*v)),
                            _ => Err(wrong(r, "true or false")),
                        })
                        .collect::<Result<Vec<_>>>()?,
                )
                .into(),
            };
            columns.push(Column::from_data(col_name.clone(), data, *required));
        }

        let key = match key_kind {
            ColumnKind::Time => Key::Time(begin),
            ColumnKind::TimeRange => Key::TimeRange(TimeRangeKeys { begin, end }),
            _ => {
                let label = if matches!(labels.first(), Some(LabelCell::Number(_))) {
                    Labels::Number(
                        (0..n)
                            .map(|r| match labels[row_at(r)] {
                                LabelCell::Number(v) => v,
                                LabelCell::String(_) => unreachable!("one kind"),
                            })
                            .collect(),
                    )
                } else {
                    Labels::String(StringColumn::from_options((0..n).map(|r| {
                        match &labels[row_at(r)] {
                            LabelCell::String(s) => Some(*s),
                            LabelCell::Number(_) => unreachable!("one kind"),
                        }
                    })))
                };
                Key::Interval(IntervalKeys { label, begin, end })
            }
        };
        TimeSeries::with_key(FROM, name.to_string(), key_name.clone(), key, columns)
    }

    /// Write the series in pond-ts's JSON format (see
    /// [`TimeSeries::from_json`]), as pond-ts `toJSON({ rowFormat })`: the text
    /// [`TimeSeries::from_json`] and pond-ts `fromJSON` read back. Times are
    /// epoch milliseconds; a gap is `null`; `-0` is written `0`, as
    /// JavaScript writes it.
    ///
    /// An error for a decimal column, which pond-ts has no kind for: convert
    /// it with [`TimeSeries::map_decimals`] first, or write Arrow
    /// ([`TimeSeries::write_ipc`]), which keeps it exact.
    pub fn to_json(&self, format: RowFormat) -> Result<String> {
        if let Some(c) = self
            .columns()
            .iter()
            .find(|c| c.kind() == ColumnKind::Decimal)
        {
            return Err(PondError::Unsupported {
                call: TO,
                message: format!(
                    "column '{}' holds exact decimals, which pond-ts's JSON has no kind for; map it to numbers first, or write Arrow, which keeps it exact",
                    c.name()
                ),
            });
        }
        // Written straight to text: building a `Value` tree first cost
        // several times as much (a map per object row).
        let mut out = Vec::with_capacity(64 + self.len() * 16 * (1 + self.columns().len()));
        out.extend_from_slice(b"{\"name\":");
        push_text(&mut out, self.name());
        out.extend_from_slice(b",\"schema\":[");
        for (i, def) in self.schema().iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.extend_from_slice(b"{\"name\":");
            push_text(&mut out, &def.name);
            out.extend_from_slice(b",\"kind\":");
            push_text(&mut out, def.kind.as_str());
            if i > 0 && !def.required {
                out.extend_from_slice(b",\"required\":false");
            }
            out.push(b'}');
        }
        out.extend_from_slice(b"],\"rows\":[");
        // Each name once, escaped, with its colon: `"cpu":`.
        let field = |name: &str| {
            let mut f = Vec::new();
            push_text(&mut f, name);
            f.push(b':');
            f
        };
        let key_field = field(self.key_name());
        let fields: Vec<Vec<u8>> = self.columns().iter().map(|c| field(c.name())).collect();
        let object = format == RowFormat::Object;
        for i in 0..self.len() {
            if i > 0 {
                out.push(b',');
            }
            out.push(if object { b'{' } else { b'[' });
            if object {
                out.extend_from_slice(&key_field);
            }
            self.push_key(&mut out, i, format);
            for (c, column) in self.columns().iter().enumerate() {
                out.push(b',');
                if object {
                    out.extend_from_slice(&fields[c]);
                }
                match column.data() {
                    ColumnData::Number(v) => match v.get(i) {
                        Some(x) => push_number(&mut out, x),
                        None => out.extend_from_slice(b"null"),
                    },
                    ColumnData::String(v) => match v.get(i) {
                        Some(x) => push_text(&mut out, x),
                        None => out.extend_from_slice(b"null"),
                    },
                    ColumnData::Boolean(v) => out.extend_from_slice(match v.get(i) {
                        Some(true) => b"true",
                        Some(false) => b"false",
                        None => b"null",
                    }),
                    ColumnData::Decimal(_) => unreachable!("refused above"),
                }
            }
            out.push(if object { b'}' } else { b']' });
        }
        out.extend_from_slice(b"]}");
        Ok(String::from_utf8(out).expect("JSON text is UTF-8"))
    }

    /// [`TimeSeries::to_json`] as a [`serde_json::Value`].
    pub fn to_json_value(&self, format: RowFormat) -> Result<Value> {
        Ok(serde_json::from_str(&self.to_json(format)?).expect("to_json writes JSON"))
    }

    fn push_key(&self, out: &mut Vec<u8>, i: usize, format: RowFormat) {
        let begin = self.key().begin()[i];
        let Some(end) = self.key().end() else {
            push_int(out, begin);
            return;
        };
        let object = format == RowFormat::Object;
        out.push(if object { b'{' } else { b'[' });
        if let Key::Interval(k) = self.key() {
            if object {
                out.extend_from_slice(b"\"value\":");
            }
            match &k.label {
                Labels::Number(v) => push_number(out, v[i]),
                Labels::String(s) => push_text(out, s.get(i).expect("labels have no gaps")),
            }
            out.push(b',');
        }
        if object {
            out.extend_from_slice(b"\"start\":");
        }
        push_int(out, begin);
        out.extend_from_slice(if object { b",\"end\":" } else { b"," });
        push_int(out, end[i]);
        out.push(if object { b'}' } else { b']' });
    }
}

fn push_int(out: &mut Vec<u8>, v: i64) {
    use std::io::Write;
    write!(out, "{v}").expect("writing to a Vec cannot fail");
}

/// Text as a JSON string, escaped as `serde_json` escapes it.
fn push_text(out: &mut Vec<u8>, text: &str) {
    serde_json::to_writer(out, text).expect("writing to a Vec cannot fail");
}

/// A number as JavaScript's `JSON.stringify` writes it: whole numbers
/// without a fraction, `-0` as `0`, and anything not finite as `null`.
fn push_number(out: &mut Vec<u8>, v: f64) {
    // Whole numbers that fit an i64 are exact there (JavaScript writes them
    // without an exponent up to 1e21).
    if v.fract() == 0.0 && v.abs() < 9.2e18 {
        push_int(out, v as i64);
    } else {
        // Shortest round-trip digits; `null` when not finite.
        serde_json::to_writer(out, &v).expect("writing to a Vec cannot fail");
    }
}

/// The schema as (name, kind, required), key first.
fn read_schema(schema: Option<&Value>) -> Result<Vec<(String, ColumnKind, bool)>> {
    let entries = schema
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("expected \"schema\" as an array".into()))?;
    if entries.is_empty() {
        return Err(invalid("the schema needs at least a key column".into()));
    }
    entries
        .iter()
        .enumerate()
        .map(|(c, entry)| {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid(format!("schema column {c} has no \"name\"")))?;
            let kind_text = entry.get("kind").and_then(Value::as_str).unwrap_or("");
            let kind = match (c, kind_text) {
                (0, "time") => ColumnKind::Time,
                (0, "timeRange") => ColumnKind::TimeRange,
                (0, "interval") => ColumnKind::Interval,
                (0, other) => {
                    return Err(invalid(format!(
                        "the first schema column is the key, and must be 'time', 'timeRange' or 'interval'; got '{other}'"
                    )));
                }
                (_, "number") => ColumnKind::Number,
                (_, "string") => ColumnKind::String,
                (_, "boolean") => ColumnKind::Boolean,
                (_, "array") => {
                    return Err(PondError::Unsupported {
                        call: FROM,
                        message: format!(
                            "column '{name}' is an array column, which pond-rs does not have yet"
                        ),
                    });
                }
                (_, other) => {
                    return Err(invalid(format!(
                        "column '{name}' has kind '{other}'; value columns are 'number', 'string' or 'boolean'"
                    )));
                }
            };
            // As in pond-ts, only `required: false` allows gaps.
            let required = entry.get("required") != Some(&Value::Bool(false));
            Ok((name.to_string(), kind, required))
        })
        .collect()
}

/// A time: epoch milliseconds, or text read in `zone`.
fn read_time(v: &Value, row: usize, zone: &str) -> Result<i64> {
    match v {
        Value::Number(n) => {
            if let Some(t) = n.as_i64() {
                return Ok(t);
            }
            let f = n.as_f64().unwrap_or(f64::NAN);
            // Whole numbers written as floats (`1000.0`, `2e3`) are fine.
            if f.fract() == 0.0 && f.abs() < 9.3e18 {
                return Ok(f as i64);
            }
            Err(invalid(format!(
                "row {row}: the time {n} is not a whole number of milliseconds (pond-rs times are whole milliseconds)"
            )))
        }
        Value::String(text) => {
            crate::parse_time_in(text, zone).map_err(|e| invalid(format!("row {row}: {e}")))
        }
        other => Err(invalid(format!(
            "row {row}: expected a time as a number of milliseconds or as text, got {other}"
        ))),
    }
}

/// The start and end of a time range (`[begin, end]` / `{start, end}`) or
/// an interval (`[label, begin, end]` / `{value, start, end}`).
fn read_span(v: &Value, row: usize, interval: bool) -> Result<(&Value, &Value)> {
    match v {
        Value::Array(a) if !interval && a.len() == 2 => Ok((&a[0], &a[1])),
        Value::Array(a) if interval && a.len() == 3 => Ok((&a[1], &a[2])),
        Value::Object(o)
            if o.contains_key("start")
                && o.contains_key("end")
                && o.contains_key("value") == interval =>
        {
            Ok((&o["start"], &o["end"]))
        }
        _ if interval => Err(invalid(format!(
            "row {row}: expected an interval as [label, start, end] or {{\"value\", \"start\", \"end\"}}, got {v}"
        ))),
        _ => Err(invalid(format!(
            "row {row}: expected a time range as [start, end] or {{\"start\", \"end\"}}, got {v}"
        ))),
    }
}

enum LabelCell<'a> {
    Number(f64),
    String(&'a str),
}

/// An interval label: text or a number, the same kind as the first row's.
fn read_label<'a>(v: &'a Value, row: usize, first: Option<&LabelCell>) -> Result<LabelCell<'a>> {
    let label = match v {
        Value::String(s) => LabelCell::String(s),
        Value::Number(n) => LabelCell::Number(n.as_f64().expect("JSON numbers are finite")),
        other => {
            return Err(invalid(format!(
                "row {row}: an interval label must be text or a number, got {other}"
            )));
        }
    };
    match (first, &label) {
        (Some(LabelCell::Number(_)), LabelCell::String(_))
        | (Some(LabelCell::String(_)), LabelCell::Number(_)) => Err(invalid(format!(
            "row {row}: interval labels must all be text or all numbers; this one is {v}, unlike row 0's"
        ))),
        _ => Ok(label),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time_series(rows: &str) -> String {
        format!(
            r#"{{"name":"t","schema":[{{"name":"time","kind":"time"}},{{"name":"v","kind":"number","required":false}}],"rows":{rows}}}"#
        )
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        let text = |v: f64| {
            let mut out = Vec::new();
            push_number(&mut out, v);
            String::from_utf8(out).unwrap()
        };
        assert_eq!(text(-0.0), "0");
        assert_eq!(text(2.0), "2");
        assert_eq!(text(0.1), "0.1");
        assert_eq!(text(f64::INFINITY), "null");
        assert_eq!(text(f64::NAN), "null");
        assert_eq!(text(1e300), "1e+300"); // as JavaScript
        assert_eq!(text(2f64.powi(53)), "9007199254740992");
        assert_eq!(text(1e-7), "1e-7");
    }

    #[test]
    fn clamp_and_reorder() {
        let text = time_series("[[3000,1],[1000,2],[1000,3]]");
        assert!(TimeSeries::from_json(&text, &JsonOptions::new()).is_err());
        let s = TimeSeries::from_json(&text, &JsonOptions::new().order(KeyOrder::Clamp)).unwrap();
        assert_eq!(s.key().begin(), &[3000, 3000, 3000]);
        let s = TimeSeries::from_json(&text, &JsonOptions::new().order(KeyOrder::Reorder)).unwrap();
        assert_eq!(s.key().begin(), &[1000, 1000, 3000]);
        let v = s.column("v").unwrap().numbers().unwrap();
        assert_eq!(
            (v.get(0), v.get(1), v.get(2)),
            (Some(2.0), Some(3.0), Some(1.0))
        );
    }

    #[test]
    fn round_trips_and_refuses_fractions_and_decimals() {
        let text = time_series("[[0,1.5],[1000,null]]");
        let s = TimeSeries::from_json(&text, &JsonOptions::new()).unwrap();
        assert_eq!(s.to_json(RowFormat::Array).unwrap(), text);
        assert!(TimeSeries::from_json(&time_series("[[1.5,1]]"), &JsonOptions::new()).is_err());
        assert!(TimeSeries::from_json("{", &JsonOptions::new()).is_err());
        let d = s
            .with_column(Column::required(
                "d",
                crate::DecimalColumn::from_values(vec![1, 2], 1).unwrap(),
            ))
            .unwrap();
        assert!(d.to_json(RowFormat::Object).is_err());
    }
}
