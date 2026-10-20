//! pond-ts's two other JSON shapes: one array per column
//! ([`TimeSeries::from_columns_json`] / [`TimeSeries::to_columns_json`], as
//! pond-ts `fromColumns` / `toColumns`) and wide points for charts
//! ([`TimeSeries::from_points_json`] / [`TimeSeries::to_points_json`], as
//! pond-ts `fromPoints` / `toPoints`).

use serde_json::Value;

use crate::column::{ColumnData, Float64Column, StringColumn};
use crate::error::{PondError, Result};
use crate::json::{
    KeyOrder, LabelCell, RowShape, invalid, parse, push_cell, push_int, push_number, push_schema,
    push_text, read_label, read_name, read_rows, read_schema, read_time, refuse_decimals,
};
use crate::json_text::Json;
use crate::series::{
    Column, ColumnDef, ColumnKind, IntervalKeys, Key, Labels, TimeRangeKeys, TimeSeries,
};

const FROM_COLUMNS: &str = "from_columns_json";
const TO_COLUMNS: &str = "to_columns_json";
const FROM_POINTS: &str = "from_points_json";
const TO_POINTS: &str = "to_points_json";

/// [`TimeSeries::from_columns_json`] on parsed JSON.
fn read_columns(value: &Json, order: KeyOrder) -> Result<TimeSeries> {
    let call = FROM_COLUMNS;
    let name = read_name(call, value)?;
    let schema = read_schema(call, value.get("schema"))?;
    let (key_name, key_kind) = (&schema[0].0, schema[0].1);
    if let Some((col, kind, _)) = schema[1..]
        .iter()
        .find(|(_, kind, _)| !matches!(kind, ColumnKind::Number | ColumnKind::String))
    {
        return Err(invalid(
            call,
            format!(
                "column '{col}' is '{}'; this format takes 'number' and 'string' value columns, as in pond-ts",
                kind.as_str()
            ),
        ));
    }
    check_flat_key_names(
        call,
        key_name,
        key_kind,
        schema[1..].iter().map(|c| c.0.as_str()),
    )?;
    if order == KeyOrder::Clamp && key_kind != ColumnKind::Time {
        return Err(invalid(
            call,
            format!(
                "KeyOrder::Clamp is for point-in-time keys only; this key is '{}' (use KeyOrder::Reorder, or sort the rows first)",
                key_kind.as_str()
            ),
        ));
    }
    let columns = value
        .get("columns")
        .and_then(|v| v.as_object())
        .ok_or_else(|| invalid(call, "expected \"columns\" as an object".into()))?;
    let column = |name: &str| -> Result<&Vec<Json>> {
        columns
            .get(name)
            .and_then(|v| v.as_array())
            .ok_or_else(|| invalid(call, format!("missing column '{name}' (an array)")))
    };

    let begin_cells = column(key_name)?;
    let n = begin_cells.len();
    let same_length = |name: &str, cells: &Vec<Json>| {
        if cells.len() == n {
            Ok(())
        } else {
            Err(invalid(
                call,
                format!(
                    "column '{name}' has {} values; the key column '{key_name}' has {n}",
                    cells.len()
                ),
            ))
        }
    };
    let times = |cells: &Vec<Json>| -> Result<Vec<i64>> {
        cells
            .iter()
            .enumerate()
            .map(|(i, v)| read_time(call, v, i, None))
            .collect()
    };
    let mut begin = times(begin_cells)?;
    let (end_name, label_name) = flat_key_names(key_name, key_kind);
    let mut end = Vec::new();
    if let Some(end_name) = &end_name {
        let cells = column(end_name)?;
        same_length(end_name, cells)?;
        end = times(cells)?;
        if let Some(i) = (0..n).find(|&i| end[i] < begin[i]) {
            return Err(invalid(
                call,
                format!(
                    "the key at row {i} ends ({}) before it starts ({})",
                    end[i], begin[i]
                ),
            ));
        }
    }
    let mut labels: Vec<LabelCell> = Vec::new();
    if let Some(label_name) = &label_name {
        let cells = column(label_name)?;
        same_length(label_name, cells)?;
        for (i, v) in cells.iter().enumerate() {
            labels.push(read_label(call, v, i, labels.first())?);
        }
    }

    // Rows in the order the series will hold them.
    let row_order: Option<Vec<usize>> = match order {
        KeyOrder::Reorder => {
            let mut o: Vec<usize> = (0..n).collect();
            o.sort_by_key(|&i| (begin[i], end.get(i).copied().unwrap_or(0)));
            Some(o)
        }
        KeyOrder::Clamp => {
            for i in 1..n {
                begin[i] = begin[i].max(begin[i - 1]);
            }
            None
        }
        KeyOrder::Strict => None,
    };
    let row_at = |r: usize| row_order.as_ref().map_or(r, |o| o[r]);
    if let Some(o) = &row_order {
        begin = o.iter().map(|&i| begin[i]).collect();
        if !end.is_empty() {
            end = o.iter().map(|&i| end[i]).collect();
        }
    }

    let mut out = Vec::with_capacity(schema.len() - 1);
    for (col_name, kind, required) in &schema[1..] {
        let cells = column(col_name)?;
        same_length(col_name, cells)?;
        let wrong = |r: usize, want: &str| {
            invalid(
                call,
                format!(
                    "column '{col_name}' row {r}: expected {want} or null, got {}",
                    cells[r]
                ),
            )
        };
        let data: ColumnData = if *kind == ColumnKind::Number {
            Float64Column::from_options(
                (0..n)
                    .map(|r| match &cells[row_at(r)] {
                        Json::Null => Ok(None),
                        Json::Number(v) => Ok(v.as_f64()),
                        _ => Err(wrong(row_at(r), "a number")),
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
            .into()
        } else {
            StringColumn::from_options(
                (0..n)
                    .map(|r| match &cells[row_at(r)] {
                        Json::Null => Ok(None),
                        Json::String(v) => Ok(Some(v.as_ref())),
                        _ => Err(wrong(row_at(r), "text")),
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
            .into()
        };
        // pond-ts does not check `required` here; a column with a gap
        // can only be optional.
        let required = *required && data.missing_count() == 0;
        out.push(Column::from_data(col_name.clone(), data, required));
    }

    let key = match key_kind {
        ColumnKind::Time => Key::Time(begin),
        ColumnKind::TimeRange => Key::TimeRange(TimeRangeKeys { begin, end }),
        _ => {
            let label = match labels.first() {
                Some(LabelCell::Number(_)) => Labels::Number(
                    (0..n)
                        .map(|r| match labels[row_at(r)] {
                            LabelCell::Number(v) => v,
                            LabelCell::String(_) => unreachable!("one kind"),
                        })
                        .collect(),
                ),
                _ => Labels::String(StringColumn::from_options((0..n).map(|r| {
                    match &labels[row_at(r)] {
                        LabelCell::String(s) => Some(*s),
                        LabelCell::Number(_) => unreachable!("one kind"),
                    }
                }))),
            };
            Key::Interval(IntervalKeys { label, begin, end })
        }
    };
    TimeSeries::with_key(call, name.to_string(), key_name.clone(), key, out)
}

/// [`TimeSeries::from_points_json`] on parsed JSON.
fn read_points(value: &Json, name: &str, schema: &[ColumnDef]) -> Result<TimeSeries> {
    let call = FROM_POINTS;
    if schema.len() < 2 {
        return Err(invalid(
            call,
            "the schema needs a time key and at least one value column".into(),
        ));
    }
    if schema[0].kind != ColumnKind::Time {
        return Err(invalid(
            call,
            format!(
                "the key must be 'time' (each point has one time, under \"ts\"); got '{}'",
                schema[0].kind.as_str()
            ),
        ));
    }
    for def in &schema[1..] {
        match def.kind {
            ColumnKind::Number | ColumnKind::String | ColumnKind::Boolean => {}
            ColumnKind::Decimal => {
                return Err(PondError::Unsupported {
                    call,
                    message: format!(
                        "column '{}' is a decimal column, which pond-ts's points have no kind for",
                        def.name
                    ),
                });
            }
            other => {
                return Err(invalid(
                    call,
                    format!(
                        "column '{}' has kind '{}'; value columns are 'number', 'string' or 'boolean'",
                        def.name,
                        other.as_str()
                    ),
                ));
            }
        }
        if def.name == "ts" {
            return Err(invalid(
                call,
                "a value column is named 'ts', the name each point gives its time; rename it"
                    .into(),
            ));
        }
    }
    let points = value
        .as_array()
        .ok_or_else(|| invalid(call, "expected an array of points".into()))?;
    let schema: Vec<(String, ColumnKind, bool)> = schema
        .iter()
        .map(|d| (d.name.clone(), d.kind, d.required))
        .collect();
    read_rows(
        call,
        name,
        &schema,
        points,
        RowShape::Points,
        None,
        KeyOrder::Strict,
    )
}

/// The extra columns a two-edged key is written as: `<key>End`, and for an
/// interval `<key>Label` (pond-ts `flat-keys.ts`).
fn flat_key_names(key_name: &str, kind: ColumnKind) -> (Option<String>, Option<String>) {
    match kind {
        ColumnKind::TimeRange => (Some(format!("{key_name}End")), None),
        ColumnKind::Interval => (
            Some(format!("{key_name}End")),
            Some(format!("{key_name}Label")),
        ),
        _ => (None, None),
    }
}

/// Refuse a value column that takes one of the key's extra column names,
/// as pond-ts does on the way in and out.
fn check_flat_key_names<'a>(
    call: &'static str,
    key_name: &str,
    kind: ColumnKind,
    mut value_names: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let (end, label) = flat_key_names(key_name, kind);
    match value_names.find(|n| Some(*n) == end.as_deref() || Some(*n) == label.as_deref()) {
        Some(name) => Err(invalid(
            call,
            format!(
                "value column '{name}' has the name of one of the key's own columns: a '{}' key is written as '{key_name}'{}{}; rename the column",
                kind.as_str(),
                end.map_or(String::new(), |e| format!(" + '{e}'")),
                label.map_or(String::new(), |l| format!(" + '{l}'")),
            ),
        )),
        None => Ok(()),
    }
}

impl TimeSeries {
    /// Read a series written as one JSON array per column, as pond-ts
    /// `TimeSeries.fromColumns`: the text pond-ts `toColumns` and
    /// [`TimeSeries::to_columns_json`] write.
    ///
    /// The shape is `{ "name", "schema", "columns" }`. `schema` is as in
    /// [`TimeSeries::from_json`]; `columns` holds one array per column,
    /// under the column's name, with `null` for a gap. Times are epoch
    /// milliseconds. A time range or interval key is written as more than
    /// one column, named after the key:
    ///
    /// | Key kind    | Columns                                      |
    /// | ----------- | -------------------------------------------- |
    /// | `time`      | `time`                                       |
    /// | `timeRange` | `timeRange` (start), `timeRangeEnd`          |
    /// | `interval`  | `interval` (start), `intervalEnd`, `intervalLabel` |
    ///
    /// ```
    /// # use pond_rs::{KeyOrder, TimeSeries};
    /// let text = r#"{
    ///   "name": "cpu",
    ///   "schema": [
    ///     {"name": "time", "kind": "time"},
    ///     {"name": "load", "kind": "number", "required": false}
    ///   ],
    ///   "columns": {"time": [0, 60000], "load": [0.5, null]}
    /// }"#;
    /// let s = TimeSeries::from_columns_json(text, KeyOrder::Strict)?;
    /// assert_eq!(s.to_columns_json()?, text.split_whitespace().collect::<String>());
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// As in pond-ts, value columns are numbers or text only (a `boolean`
    /// column is an error), names in `columns` that the schema does not
    /// list are ignored, and `order` handles keys out of order as in
    /// [`TimeSeries::from_json`].
    ///
    /// Errors, as in pond-ts: a missing column or one of the wrong length;
    /// a key that is not a number, or ends before it starts; interval
    /// labels that are missing, or not all text or all numbers; a value
    /// column named like one of the key's columns (`timeRangeEnd`); keys out
    /// of order under [`KeyOrder::Strict`].
    ///
    /// Differences from pond-ts:
    ///
    /// - pond-ts ignores `required` here, and keeps a column with gaps
    ///   marked required (so its own `fromJSON` then refuses the series).
    ///   pond-rs marks such a column optional.
    /// - Errors where pond-ts accepts: a cell of the wrong kind (pond-ts
    ///   turns `"5"` in a number column into 5, `true` into 1, and a number
    ///   in a text column into a gap); a key written as text or `true`
    ///   (pond-ts reads `"5"` as 5); a time that is not a whole millisecond,
    ///   or outside ±[`MAX_TIME_MS`](crate::MAX_TIME_MS); a missing `name`;
    ///   a number too large for an `f64` (`1e400`), which JavaScript reads
    ///   as `Infinity` and pond-ts stores as a gap.
    pub fn from_columns_json(text: &str, order: KeyOrder) -> Result<TimeSeries> {
        read_columns(&parse(FROM_COLUMNS, text)?, order)
    }

    /// [`TimeSeries::from_columns_json`] from JSON already parsed with
    /// [`serde_json`].
    pub fn from_columns_value(value: &Value, order: KeyOrder) -> Result<TimeSeries> {
        read_columns(&Json::from_value(value), order)
    }

    /// Write the series as one JSON array per column, as pond-ts
    /// `toColumns`: the text [`TimeSeries::from_columns_json`] and pond-ts
    /// `fromColumns` read back. The layout, key columns included, is in
    /// [`TimeSeries::from_columns_json`]; times are epoch milliseconds, a
    /// gap is `null`, and numbers are written as JavaScript writes them, as
    /// in [`TimeSeries::to_json`].
    ///
    /// Errors, as in pond-ts, when a value column is named like one of the
    /// key's columns (`timeRangeEnd` beside a `timeRange` key), since the
    /// two would share a name. Also errors for a decimal column, as
    /// [`TimeSeries::to_json`] does.
    ///
    /// pond-ts writes true/false columns too, though neither pond-ts nor
    /// pond-rs reads them back from this format.
    ///
    /// Columns are written in schema order. JavaScript puts names that look
    /// like whole numbers (`"1"`) first in an object, so for such a column
    /// pond-ts's text has another order; the JSON means the same.
    pub fn to_columns_json(&self) -> Result<String> {
        let call = TO_COLUMNS;
        refuse_decimals(call, self)?;
        check_flat_key_names(
            call,
            self.key_name(),
            self.key().kind(),
            self.columns().iter().map(Column::name),
        )?;
        let n = self.len();
        let mut out = Vec::with_capacity(64 + n * 12 * (1 + self.columns().len()));
        out.extend_from_slice(b"{\"name\":");
        push_text(&mut out, self.name());
        out.extend_from_slice(b",\"schema\":");
        push_schema(&mut out, self);
        out.extend_from_slice(b",\"columns\":{");
        let (end_name, label_name) = flat_key_names(self.key_name(), self.key().kind());
        let open = |out: &mut Vec<u8>, name: &str, first: bool| {
            if !first {
                out.push(b',');
            }
            push_text(out, name);
            out.extend_from_slice(b":[");
        };
        let ints = |out: &mut Vec<u8>, values: &[i64]| {
            for (i, &v) in values.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                push_int(out, v);
            }
            out.push(b']');
        };
        open(&mut out, self.key_name(), true);
        ints(&mut out, self.key().begin());
        if let (Some(end_name), Some(end)) = (&end_name, self.key().end()) {
            open(&mut out, end_name, false);
            ints(&mut out, end);
        }
        if let (Some(label_name), Key::Interval(k)) = (&label_name, self.key()) {
            open(&mut out, label_name, false);
            for i in 0..n {
                if i > 0 {
                    out.push(b',');
                }
                match &k.label {
                    Labels::Number(v) => push_number(&mut out, v[i]),
                    Labels::String(s) => {
                        push_text(&mut out, s.get(i).expect("labels have no gaps"))
                    }
                }
            }
            out.push(b']');
        }
        for column in self.columns() {
            open(&mut out, column.name(), false);
            for i in 0..n {
                if i > 0 {
                    out.push(b',');
                }
                push_cell(&mut out, column.data(), i);
            }
            out.push(b']');
        }
        out.extend_from_slice(b"}}");
        Ok(String::from_utf8(out).expect("JSON text is UTF-8"))
    }

    /// [`TimeSeries::to_columns_json`] as a [`serde_json::Value`] (object
    /// keys in serde_json's order; see [`TimeSeries::to_json_value`]).
    pub fn to_columns_value(&self) -> Result<Value> {
        Ok(serde_json::from_str(&self.to_columns_json()?).expect("to_columns_json writes JSON"))
    }

    /// Read wide points, as pond-ts `TimeSeries.fromPoints`: a JSON array
    /// of objects, each holding its time under `ts` (epoch milliseconds)
    /// and each value column under its own name — the shape chart
    /// libraries take, and what [`TimeSeries::to_points_json`] writes.
    ///
    /// The points do not carry a schema, so you pass one: the key first
    /// (it must be a `time` key, since `ts` is one time), then at least one
    /// number, text or true/false column. A missing name or `null` is a
    /// gap, allowed only in a column that is not `required`. Names the
    /// schema does not list are ignored. Keys must be in order (pond-ts
    /// has no ordering option here).
    ///
    /// ```
    /// # use pond_rs::{ColumnDef, ColumnKind, TimeSeries};
    /// let schema = [
    ///     ColumnDef { name: "time".into(), kind: ColumnKind::Time, required: true },
    ///     ColumnDef { name: "cpu".into(), kind: ColumnKind::Number, required: false },
    /// ];
    /// let s = TimeSeries::from_points_json(r#"[{"ts": 0, "cpu": 0.5}, {"ts": 1000}]"#, "points", &schema)?;
    /// assert_eq!(s.to_points_json()?, r#"[{"ts":0,"cpu":0.5},{"ts":1000}]"#);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Errors, as in pond-ts: a schema with no value column or a key that is
    /// not `time`; a point with no `ts`, or a `ts` that is not a number
    /// (pond-ts does not read text times here either); a cell of the wrong
    /// kind; a gap in a required column; keys out of order.
    ///
    /// Also errors, where pond-ts accepts: a `ts` that is not a whole
    /// millisecond, or outside ±[`MAX_TIME_MS`](crate::MAX_TIME_MS); a value
    /// column named `ts` (pond-ts reads the time into it too); a decimal
    /// column, which pond-ts does not have.
    pub fn from_points_json(text: &str, name: &str, schema: &[ColumnDef]) -> Result<TimeSeries> {
        read_points(&parse(FROM_POINTS, text)?, name, schema)
    }

    /// [`TimeSeries::from_points_json`] from JSON already parsed with
    /// [`serde_json`].
    pub fn from_points_value(
        value: &Value,
        name: &str,
        schema: &[ColumnDef],
    ) -> Result<TimeSeries> {
        read_points(&Json::from_value(value), name, schema)
    }

    /// Write the series as wide points, as pond-ts `toPoints` written as
    /// JSON: `[{"ts": 0, "cpu": 0.5, ...}, ...]`, one object per row, the
    /// time (the start, for a time range or interval) under `ts` and each
    /// value column under its own name. A gap leaves its name out, as
    /// `JSON.stringify` does with pond-ts's `undefined`; numbers are
    /// written as JavaScript writes them.
    ///
    /// Errors for a decimal column, as [`TimeSeries::to_json`] does, and for
    /// a value column named `ts` (pond-ts writes that column's value over
    /// the time, and drops the time where the column has a gap).
    ///
    /// Names are written `ts` first, then in schema order; as with
    /// [`TimeSeries::to_columns_json`], pond-ts writes names that look like
    /// whole numbers first.
    pub fn to_points_json(&self) -> Result<String> {
        let call = TO_POINTS;
        refuse_decimals(call, self)?;
        if self.columns().iter().any(|c| c.name() == "ts") {
            return Err(invalid(
                call,
                "a value column is named 'ts', the name each point gives its time; rename it first"
                    .into(),
            ));
        }
        let fields: Vec<Vec<u8>> = self
            .columns()
            .iter()
            .map(|c| {
                let mut f = vec![b','];
                push_text(&mut f, c.name());
                f.push(b':');
                f
            })
            .collect();
        let mut out = Vec::with_capacity(2 + self.len() * 16 * (1 + self.columns().len()));
        out.push(b'[');
        for (i, &t) in self.key().begin().iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.extend_from_slice(b"{\"ts\":");
            push_int(&mut out, t);
            for (c, column) in self.columns().iter().enumerate() {
                if column.data().is_present(i) {
                    out.extend_from_slice(&fields[c]);
                    push_cell(&mut out, column.data(), i);
                }
            }
            out.push(b'}');
        }
        out.push(b']');
        Ok(String::from_utf8(out).expect("JSON text is UTF-8"))
    }

    /// [`TimeSeries::to_points_json`] as a [`serde_json::Value`] (object
    /// keys in serde_json's order; see [`TimeSeries::to_json_value`]).
    pub fn to_points_value(&self) -> Result<Value> {
        Ok(serde_json::from_str(&self.to_points_json()?).expect("to_points_json writes JSON"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DecimalColumn;

    fn def(name: &str, kind: ColumnKind, required: bool) -> ColumnDef {
        ColumnDef {
            name: name.into(),
            kind,
            required,
        }
    }

    #[test]
    fn a_column_with_gaps_is_optional_whatever_the_schema_says() {
        let text = r#"{"name":"c","schema":[{"name":"time","kind":"time"},{"name":"v","kind":"number"},{"name":"w","kind":"number"}],"columns":{"time":[0,1],"v":[1,null],"w":[1,2]}}"#;
        let s = TimeSeries::from_columns_json(text, KeyOrder::Strict).unwrap();
        assert!(!s.column("v").unwrap().is_required());
        assert!(s.column("w").unwrap().is_required());
    }

    #[test]
    fn coerced_cells_are_refused() {
        let text = |v: &str| {
            format!(
                r#"{{"name":"c","schema":[{{"name":"time","kind":"time"}},{{"name":"v","kind":"number","required":false}}],"columns":{{"time":[0],"v":[{v}]}}}}"#
            )
        };
        assert!(TimeSeries::from_columns_json(&text("1.5"), KeyOrder::Strict).is_ok());
        for bad in [r#""5""#, "true", "[1]"] {
            assert!(TimeSeries::from_columns_json(&text(bad), KeyOrder::Strict).is_err());
        }
    }

    #[test]
    fn key_columns_cannot_be_shadowed() {
        let s = TimeSeries::from_time_ranges(
            "r",
            TimeRangeKeys {
                begin: vec![0],
                end: vec![5],
            },
            vec![Column::required("timeRangeEnd", vec![1.0])],
        )
        .unwrap();
        assert!(s.to_columns_json().is_err());
        let t = TimeSeries::new("t", vec![0], vec![Column::required("ts", vec![1.0])]).unwrap();
        assert!(t.to_points_json().is_err());
        let schema = [
            def("time", ColumnKind::Time, true),
            def("ts", ColumnKind::Number, false),
        ];
        assert!(TimeSeries::from_points_json(r#"[{"ts":0}]"#, "p", &schema).is_err());
    }

    #[test]
    fn points_read_null_as_a_gap_and_refuse_decimals() {
        let schema = [
            def("time", ColumnKind::Time, true),
            def("v", ColumnKind::Number, false),
        ];
        let s = TimeSeries::from_points_json(r#"[{"ts":0,"v":null},{"ts":1,"v":2}]"#, "p", &schema)
            .unwrap();
        assert_eq!(s.to_points_json().unwrap(), r#"[{"ts":0},{"ts":1,"v":2}]"#);
        let required = [
            def("time", ColumnKind::Time, true),
            def("v", ColumnKind::Number, true),
        ];
        assert!(TimeSeries::from_points_json(r#"[{"ts":0,"v":null}]"#, "p", &required).is_err());
        let d = s
            .with_column(Column::required(
                "d",
                DecimalColumn::from_values(vec![1, 2], 1).unwrap(),
            ))
            .unwrap();
        assert!(d.to_points_json().is_err());
        assert!(d.to_columns_json().is_err());
        let decimal = [
            def("time", ColumnKind::Time, true),
            def("d", ColumnKind::Decimal, false),
        ];
        assert!(TimeSeries::from_points_json("[]", "p", &decimal).is_err());
    }
}
