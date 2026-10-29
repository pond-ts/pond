//! [`ValueSeries`]: rows keyed by a number that only goes up (distance,
//! strike price, frequency) instead of by time, as pond-ts `ValueSeries`.
//! Built from a time series with [`TimeSeries::by_value`], or read from
//! pond-ts's JSON formats.

use serde_json::Value;

use crate::column::{ColumnData, Float64Column};
use crate::error::{PondError, Result};
use crate::json::{
    KeyOrder, RowFormat, RowShape, invalid, parse, push_cell, push_number, push_schema, push_text,
    read_name, read_schema, refuse_decimals, row_cells, row_columns,
};
use crate::json_columns::columnar_columns;
use crate::json_text::Json;
use crate::series::{Column, ColumnDef, ColumnKind, TimeSeries};

/// A series keyed by a number axis instead of time (pond-ts
/// `ValueSeries`): a cumulative distance, a strike price, a frequency.
/// The axis has no gaps, every value is finite, and it never goes down
/// (repeats are allowed). The value columns are as in a [`TimeSeries`].
///
/// It answers "which row is nearest this distance" ([`nearest_index`])
/// and "the rows between these two distances" ([`slice_by_value`]).
/// Time operations (`aggregate`, `rolling`, …) are not here: an axis is
/// not a clock. To bin or roll along a number column, use
/// [`TimeSeries::by_column`] / [`TimeSeries::rolling_by_column`] on the
/// time series instead.
///
/// [`nearest_index`]: ValueSeries::nearest_index
/// [`slice_by_value`]: ValueSeries::slice_by_value
///
/// ```
/// use pond_rs::{Column, TimeSeries};
/// let run = TimeSeries::new("run", vec![0, 60_000, 120_000, 180_000], vec![
///     Column::required("km", vec![0.0, 0.2, 0.45, 0.7]),
///     Column::required("hr", vec![120.0, 135.0, 142.0, 150.0]),
/// ])?;
/// let by_km = run.by_value("km")?;
/// assert_eq!(by_km.axis(), &[0.0, 0.2, 0.45, 0.7]);
/// assert_eq!(by_km.nearest_index(0.4), Some(2));
/// let first_half = by_km.slice_by_value(0.0, 0.35);
/// assert_eq!(first_half.column("hr")?.numbers()?.values(), &[120.0, 135.0]);
/// # Ok::<(), pond_rs::PondError>(())
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct ValueSeries {
    name: String,
    axis_name: String,
    axis: Float64Column,
    columns: Vec<Column>,
}

const NEW: &str = "ValueSeries::new";
const BY_VALUE: &str = "by_value";
const FROM_JSON: &str = "ValueSeries::from_json";
const TO_JSON: &str = "ValueSeries::to_json";
const FROM_COLUMNS: &str = "ValueSeries::from_columns_json";
const TO_COLUMNS: &str = "ValueSeries::to_columns_json";

impl ValueSeries {
    /// Build a value-keyed series: the axis column `axis_name` holds
    /// `axis`, and `columns` are its value columns, as in
    /// [`TimeSeries::new`]. Every axis value must be finite, and no value
    /// may be below the one before it.
    ///
    /// ```
    /// use pond_rs::{Column, ValueSeries};
    /// let chain = ValueSeries::new("calls", "strike", vec![90.0, 95.0, 100.0], vec![
    ///     Column::required("bid", vec![11.2, 6.9, 3.4]),
    /// ])?;
    /// assert_eq!(chain.axis_name(), "strike");
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn new(
        name: impl Into<String>,
        axis_name: impl Into<String>,
        axis: Vec<f64>,
        columns: Vec<Column>,
    ) -> Result<Self> {
        Self::checked(
            NEW,
            name.into(),
            axis_name.into(),
            Float64Column::from_values(axis),
            columns,
        )
    }

    /// Build one, checking every rule.
    pub(crate) fn checked(
        call: &'static str,
        name: String,
        axis_name: String,
        axis: Float64Column,
        columns: Vec<Column>,
    ) -> Result<Self> {
        check_axis(call, &axis_name, axis.values())?;
        TimeSeries::check_columns(call, &axis_name, axis.len(), &columns)?;
        Ok(Self {
            name,
            axis_name,
            axis,
            columns,
        })
    }

    /// The series' name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The axis column's name (`"km"`, `"strike"`).
    pub fn axis_name(&self) -> &str {
        &self.axis_name
    }

    /// Number of rows.
    pub fn len(&self) -> usize {
        self.axis.len()
    }

    /// `true` when there are no rows.
    pub fn is_empty(&self) -> bool {
        self.axis.is_empty()
    }

    /// The axis values, one per row, in order (pond-ts `axisValues()`;
    /// `axis()[i]` is pond-ts `axisAt(i)`).
    pub fn axis(&self) -> &[f64] {
        self.axis.values()
    }

    /// The axis as a column (no gaps).
    pub(crate) fn axis_column(&self) -> &Float64Column {
        &self.axis
    }

    /// The schema: the axis first (kind [`ColumnKind::Value`]), then each
    /// value column in order.
    pub fn schema(&self) -> Vec<ColumnDef> {
        std::iter::once(ColumnDef {
            name: self.axis_name.clone(),
            kind: ColumnKind::Value,
            required: true,
        })
        .chain(self.columns.iter().map(|c| ColumnDef {
            name: c.name().to_string(),
            kind: c.kind(),
            required: c.is_required(),
        }))
        .collect()
    }

    /// The value columns, in schema order.
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// A value column by name; an error naming the columns there are when
    /// there is none.
    pub fn column(&self, name: &str) -> Result<&Column> {
        self.columns
            .iter()
            .find(|c| c.name() == name)
            .ok_or_else(|| PondError::UnknownColumn {
                call: "ValueSeries::column",
                column: name.to_string(),
                available: self.columns.iter().map(|c| c.name().to_string()).collect(),
            })
    }

    /// The row whose axis value is closest to `value` (pond-ts
    /// `nearestIndex`); on a tie, the earlier row. A value past either end
    /// gives the first or last row; `None` when there are no rows. A `NaN`
    /// gives the first row, as in pond-ts.
    pub fn nearest_index(&self, value: f64) -> Option<usize> {
        let ax = self.axis();
        let n = ax.len();
        if n == 0 {
            return None;
        }
        let lo = lower_bound(ax, value);
        Some(if lo == 0 {
            0
        } else if lo == n {
            n - 1
        } else if value - ax[lo - 1] <= ax[lo] - value {
            lo - 1
        } else {
            lo
        })
    }

    /// The rows whose axis value is at least `lo` and below `hi` (pond-ts
    /// `sliceByValue`). Shares the columns' memory. Empty when `lo >= hi`;
    /// a `NaN` bound counts as below every value.
    pub fn slice_by_value(&self, lo: f64, hi: f64) -> ValueSeries {
        let ax = self.axis();
        let from = lower_bound(ax, lo);
        let to = lower_bound(ax, hi).max(from);
        let slice = |data: &ColumnData| data.slice(from..to);
        let ColumnData::Number(axis) = slice(&ColumnData::Number(self.axis.clone())) else {
            unreachable!("a number column slices to a number column")
        };
        ValueSeries {
            name: self.name.clone(),
            axis_name: self.axis_name.clone(),
            axis,
            columns: self
                .columns
                .iter()
                .map(|c| Column::from_data(c.name().to_string(), slice(c.data()), c.is_required()))
                .collect(),
        }
    }

    /// Read a value series written in pond-ts's JSON row format, as
    /// pond-ts `ValueSeries.fromJSON`: `{ "name", "schema", "rows" }`, with
    /// the axis first in the schema (`{"name": "km", "kind": "value"}`) and
    /// `number` or `string` value columns. Each row is an array in schema
    /// order or an object keyed by column name; a gap is `null` (or a
    /// missing name). Every axis cell must be a number. `order` says what to
    /// do with an axis value below the one before it ([`KeyOrder`]; `Clamp`
    /// raises it to that value).
    ///
    /// ```
    /// use pond_rs::{KeyOrder, RowFormat, ValueSeries};
    /// let text = r#"{"name": "calls",
    ///   "schema": [{"name": "strike", "kind": "value"}, {"name": "bid", "kind": "number"}],
    ///   "rows": [[100, 3.4], [90, 11.2], {"strike": 95, "bid": 6.9}]}"#;
    /// let chain = ValueSeries::from_json(text, KeyOrder::Reorder)?;
    /// assert_eq!(chain.axis(), &[90.0, 95.0, 100.0]);
    /// assert_eq!(
    ///     chain.to_json(RowFormat::Array)?,
    ///     r#"{"name":"calls","schema":[{"name":"strike","kind":"value"},{"name":"bid","kind":"number"}],"rows":[[90,11.2],[95,6.9],[100,3.4]]}"#
    /// );
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Errors, as in pond-ts: text that is not JSON; a first schema column
    /// that is not `value`; a value column that is not `number` or `string`
    /// (pond-ts reads neither true/false nor array columns here, though
    /// [`TimeSeries::by_value`] keeps them and `to_json` writes them); a row
    /// of the wrong length; an axis cell that is not a number; a cell of the
    /// wrong kind; a gap in a required column; a value column named like
    /// the axis; the axis out of order under [`KeyOrder::Strict`]. Also
    /// errors where pond-ts accepts: a missing `name`.
    pub fn from_json(text: &str, order: KeyOrder) -> Result<ValueSeries> {
        read_json(&parse(FROM_JSON, text)?, order)
    }

    /// [`ValueSeries::from_json`] from JSON already parsed with
    /// [`serde_json`].
    pub fn from_json_value(value: &Value, order: KeyOrder) -> Result<ValueSeries> {
        read_json(&Json::from_value(value), order)
    }

    /// Write the series in pond-ts's JSON row format (see
    /// [`ValueSeries::from_json`]), as pond-ts `toJSON({ rowFormat })`.
    /// Numbers are written as JavaScript writes them, as in
    /// [`TimeSeries::to_json`]; a gap is `null`. An error for a decimal
    /// column, which pond-ts has no kind for.
    pub fn to_json(&self, format: RowFormat) -> Result<String> {
        refuse_decimals(TO_JSON, &self.columns)?;
        let mut out = Vec::with_capacity(64 + self.len() * 16 * (1 + self.columns.len()));
        self.push_head(&mut out);
        out.extend_from_slice(b",\"rows\":[");
        let field = |name: &str| {
            let mut f = Vec::new();
            push_text(&mut f, name);
            f.push(b':');
            f
        };
        let axis_field = field(&self.axis_name);
        let fields: Vec<Vec<u8>> = self.columns.iter().map(|c| field(c.name())).collect();
        let object = format == RowFormat::Object;
        for (i, &x) in self.axis().iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.push(if object { b'{' } else { b'[' });
            if object {
                out.extend_from_slice(&axis_field);
            }
            push_number(&mut out, x);
            for (c, column) in self.columns.iter().enumerate() {
                out.push(b',');
                if object {
                    out.extend_from_slice(&fields[c]);
                }
                push_cell(&mut out, column.data(), i);
            }
            out.push(if object { b'}' } else { b']' });
        }
        out.extend_from_slice(b"]}");
        Ok(String::from_utf8(out).expect("JSON text is UTF-8"))
    }

    /// [`ValueSeries::to_json`] as a [`serde_json::Value`] (object keys in
    /// serde_json's order; see [`TimeSeries::to_json_value`]).
    pub fn to_json_value(&self, format: RowFormat) -> Result<Value> {
        Ok(serde_json::from_str(&self.to_json(format)?).expect("to_json writes JSON"))
    }

    /// Read pond-ts's one-array-per-column JSON, as pond-ts
    /// `ValueSeries.fromColumns`: `{ "name", "schema", "columns" }`, where
    /// `columns` holds an array per schema column, the axis included,
    /// under its name. `number` and `string` value columns; a gap is
    /// `null`, and a column with a gap is optional whatever the schema says
    /// (pond-ts keeps it marked required). `order` as in
    /// [`ValueSeries::from_json`].
    ///
    /// Errors, as in pond-ts: a missing column, columns of different
    /// lengths, an axis cell that is not a number, the axis out of order
    /// under [`KeyOrder::Strict`]. Also errors where pond-ts reads it as
    /// something else: a cell of the wrong kind (pond-ts reads `"5"` in a
    /// number column as a gap, and in the axis as 5), a missing `name`.
    pub fn from_columns_json(text: &str, order: KeyOrder) -> Result<ValueSeries> {
        read_columns(&parse(FROM_COLUMNS, text)?, order)
    }

    /// [`ValueSeries::from_columns_json`] from JSON already parsed with
    /// [`serde_json`].
    pub fn from_columns_value(value: &Value, order: KeyOrder) -> Result<ValueSeries> {
        read_columns(&Json::from_value(value), order)
    }

    /// Write the series as pond-ts's one-array-per-column JSON (see
    /// [`ValueSeries::from_columns_json`]), as pond-ts `toColumns`. Gaps
    /// are `null`. An error for a decimal column. pond-ts writes true/false
    /// and array columns too, though neither reads them back.
    pub fn to_columns_json(&self) -> Result<String> {
        refuse_decimals(TO_COLUMNS, &self.columns)?;
        let n = self.len();
        let mut out = Vec::with_capacity(64 + n * 12 * (1 + self.columns.len()));
        self.push_head(&mut out);
        out.extend_from_slice(b",\"columns\":{");
        push_text(&mut out, &self.axis_name);
        out.extend_from_slice(b":[");
        for (i, &x) in self.axis().iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_number(&mut out, x);
        }
        out.push(b']');
        for column in &self.columns {
            out.push(b',');
            push_text(&mut out, column.name());
            out.extend_from_slice(b":[");
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

    /// [`ValueSeries::to_columns_json`] as a [`serde_json::Value`].
    pub fn to_columns_value(&self) -> Result<Value> {
        Ok(serde_json::from_str(&self.to_columns_json()?).expect("to_columns_json writes JSON"))
    }

    /// `{"name":…,"schema":[…]`, the start of both JSON shapes.
    fn push_head(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(b"{\"name\":");
        push_text(out, &self.name);
        out.extend_from_slice(b",\"schema\":");
        push_schema(out, &self.schema());
    }
}

impl TimeSeries {
    /// Key the rows by the number column `axis` instead of time (pond-ts
    /// `byValue(axis)`): a run keyed by distance, say. `axis` becomes the
    /// key and leaves the value columns; the time key is dropped and the
    /// other columns are kept as they are, sharing their memory.
    ///
    /// `axis` must have no gaps and never go down, since it becomes the
    /// key; an error otherwise, naming the first row that breaks the rule.
    /// Also an error when `axis` is not a number column (a decimal column
    /// too; map it to numbers first), unless the series has no rows (as
    /// pond-ts, which checks each row's value). See [`ValueSeries`].
    pub fn by_value(&self, axis: &str) -> Result<ValueSeries> {
        let c = self.column_index(BY_VALUE, axis)?;
        let column = &self.columns()[c];
        let ColumnData::Number(values) = column.data() else {
            // pond-ts checks each row's value, so with no rows any column
            // will do.
            if self.is_empty() {
                let mut columns = self.columns().to_vec();
                columns.remove(c);
                return Ok(ValueSeries {
                    name: self.name().to_string(),
                    axis_name: axis.to_string(),
                    axis: Float64Column::from_values(Vec::new()),
                    columns,
                });
            }
            return Err(PondError::WrongKind {
                call: BY_VALUE,
                column: axis.to_string(),
                kind: column.kind().as_str(),
                reason: "the axis must be a number column".into(),
            });
        };
        check_axis(BY_VALUE, axis, values.values())?;
        let mut columns = self.columns().to_vec();
        columns.remove(c);
        Ok(ValueSeries {
            name: self.name().to_string(),
            axis_name: axis.to_string(),
            axis: values.clone(),
            columns,
        })
    }
}

/// The axis rules: every value finite, none below the one before.
fn check_axis(call: &'static str, name: &str, axis: &[f64]) -> Result<()> {
    if let Some(i) = axis.iter().position(|v| !v.is_finite()) {
        let what = if axis[i].is_nan() {
            "missing".to_string()
        } else {
            axis[i].to_string()
        };
        return Err(invalid(
            call,
            format!(
                "axis '{name}' must be a finite number at every row to be the key; row {i} is {what}"
            ),
        ));
    }
    if let Some(i) = (1..axis.len()).find(|&i| axis[i] < axis[i - 1]) {
        return Err(invalid(
            call,
            format!(
                "axis '{name}' must never go down; row {i} ({}) is below row {} ({}) (KeyOrder::Reorder sorts the rows)",
                axis[i],
                i - 1,
                axis[i - 1]
            ),
        ));
    }
    Ok(())
}

/// The first row whose axis value is not below `target`.
fn lower_bound(axis: &[f64], target: f64) -> usize {
    axis.partition_point(|&v| v < target)
}

/// The schema of a JSON value series: the axis first, then `number` and
/// `string` value columns, as pond-ts's ingest takes.
fn read_value_schema(call: &'static str, value: &Json) -> Result<Vec<(String, ColumnKind, bool)>> {
    let schema = read_schema(call, value.get("schema"))?;
    let (axis_name, kind) = (&schema[0].0, schema[0].1);
    if kind != ColumnKind::Value {
        return Err(invalid(
            call,
            format!(
                "the first schema column is the axis, and must be 'value'; '{axis_name}' is '{}'",
                kind.as_str()
            ),
        ));
    }
    if let Some((col, kind, _)) = schema[1..]
        .iter()
        .find(|(_, kind, _)| !matches!(kind, ColumnKind::Number | ColumnKind::String))
    {
        return Err(invalid(
            call,
            format!(
                "column '{col}' is '{}'; a ValueSeries reads 'number' and 'string' value columns, as in pond-ts",
                kind.as_str()
            ),
        ));
    }
    Ok(schema)
}

/// One axis cell: a finite number.
fn read_axis(call: &'static str, name: &str, v: &Json, row: usize) -> Result<f64> {
    match v {
        Json::Number(n) if n.as_f64().is_some_and(f64::is_finite) => {
            Ok(n.as_f64().unwrap_or_default())
        }
        other => Err(invalid(
            call,
            format!("row {row}: axis '{name}' must be a finite number; got {other}"),
        )),
    }
}

/// Put the axis in order as `order` says. Returns the row order to read the
/// value columns in when the rows move (`Reorder`).
fn order_axis(axis: &mut Vec<f64>, order: KeyOrder) -> Option<Vec<usize>> {
    match order {
        KeyOrder::Strict => None,
        KeyOrder::Reorder => {
            // A stable sort; every value is finite, and -0 and 0 are equal,
            // as in JavaScript's `a - b`.
            let mut rows: Vec<usize> = (0..axis.len()).collect();
            rows.sort_by(|&a, &b| axis[a].partial_cmp(&axis[b]).expect("finite"));
            *axis = rows.iter().map(|&i| axis[i]).collect();
            Some(rows)
        }
        KeyOrder::Clamp => {
            // A value below the one before takes that value; others stay
            // (so -0 after 0 stays -0, as in pond-ts).
            for i in 1..axis.len() {
                if axis[i] < axis[i - 1] {
                    axis[i] = axis[i - 1];
                }
            }
            None
        }
    }
}

/// [`ValueSeries::from_json`] on parsed JSON.
fn read_json(value: &Json, order: KeyOrder) -> Result<ValueSeries> {
    let call = FROM_JSON;
    let name = read_name(call, value)?;
    let schema = read_value_schema(call, value)?;
    let rows = value
        .get("rows")
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid(call, "expected \"rows\" as an array".into()))?;
    let cells = row_cells(call, &schema, rows, RowShape::Rows)?;
    let axis_name = &schema[0].0;
    let mut axis = cells[0]
        .iter()
        .enumerate()
        .map(|(i, v)| read_axis(call, axis_name, v, i))
        .collect::<Result<Vec<f64>>>()?;
    let rows_order = order_axis(&mut axis, order);
    let row_at = |r: usize| rows_order.as_ref().map_or(r, |o| o[r]);
    let columns = row_columns(call, &schema[1..], &cells[1..], axis.len(), &row_at)?;
    ValueSeries::checked(
        call,
        name.to_string(),
        axis_name.clone(),
        Float64Column::from_values(axis),
        columns,
    )
}

/// [`ValueSeries::from_columns_json`] on parsed JSON.
fn read_columns(value: &Json, order: KeyOrder) -> Result<ValueSeries> {
    let call = FROM_COLUMNS;
    let name = read_name(call, value)?;
    let schema = read_value_schema(call, value)?;
    let axis_name = &schema[0].0;
    let columns = value
        .get("columns")
        .and_then(|v| v.as_object())
        .ok_or_else(|| invalid(call, "expected \"columns\" as an object".into()))?;
    let cells = columns
        .get(axis_name)
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid(call, format!("missing column '{axis_name}' (an array)")))?;
    let mut axis = cells
        .iter()
        .enumerate()
        .map(|(i, v)| read_axis(call, axis_name, v, i))
        .collect::<Result<Vec<f64>>>()?;
    let rows_order = order_axis(&mut axis, order);
    let row_at = |r: usize| rows_order.as_ref().map_or(r, |o| o[r]);
    let out = columnar_columns(call, axis_name, &schema[1..], columns, axis.len(), &row_at)?;
    ValueSeries::checked(
        call,
        name.to_string(),
        axis_name.clone(),
        Float64Column::from_values(axis),
        out,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> TimeSeries {
        TimeSeries::new(
            "t",
            vec![0, 1, 2, 3],
            vec![
                Column::required("d", vec![-0.0, 0.0, 1.0, 1.0]),
                Column::optional("v", vec![Some(1.0), None, Some(3.0), Some(4.0)]),
                Column::required("s", vec!["a", "b", "c", "d"]),
            ],
        )
        .unwrap()
    }

    #[test]
    fn by_value_keys_by_the_axis_and_drops_it() {
        let v = track().by_value("d").unwrap();
        assert_eq!(v.axis_name(), "d");
        assert_eq!(v.axis()[0].to_bits(), (-0.0f64).to_bits());
        let names: Vec<&str> = v.columns().iter().map(Column::name).collect();
        assert_eq!(names, ["v", "s"]);
        assert!(v.column("d").is_err());
        assert!(!v.column("v").unwrap().is_required());
    }

    #[test]
    fn by_value_refuses_what_pond_ts_refuses() {
        let s = track();
        assert!(s.by_value("v").is_err()); // a gap
        assert!(s.by_value("s").is_err()); // text
        assert!(s.by_value("time").is_err()); // the key is not a column
        assert!(s.by_value("nope").is_err());
        let down =
            TimeSeries::new("t", vec![0, 1], vec![Column::required("d", vec![1.0, 0.5])]).unwrap();
        assert!(down.by_value("d").is_err());
    }

    #[test]
    fn nearest_and_slice() {
        let v = ValueSeries::new("v", "x", vec![0.0, 1.0, 1.0, 3.0], vec![]).unwrap();
        assert_eq!(v.nearest_index(0.5), Some(0)); // a tie takes the earlier row
        assert_eq!(v.nearest_index(0.6), Some(1));
        assert_eq!(v.nearest_index(2.0), Some(2));
        assert_eq!(v.nearest_index(-5.0), Some(0));
        assert_eq!(v.nearest_index(9.0), Some(3));
        assert_eq!(v.nearest_index(f64::NAN), Some(0));
        assert_eq!(v.slice_by_value(1.0, 3.0).axis(), &[1.0, 1.0]);
        assert_eq!(v.slice_by_value(3.0, 1.0).len(), 0);
        assert_eq!(v.slice_by_value(f64::NAN, 2.0).len(), 3);
        let empty = ValueSeries::new("v", "x", vec![], vec![]).unwrap();
        assert_eq!(empty.nearest_index(1.0), None);
    }

    #[test]
    fn new_checks_the_axis_and_columns() {
        assert!(ValueSeries::new("v", "x", vec![1.0, f64::NAN], vec![]).is_err());
        assert!(ValueSeries::new("v", "x", vec![1.0, 0.0], vec![]).is_err());
        assert!(
            ValueSeries::new("v", "x", vec![1.0], vec![Column::required("x", vec![1.0])]).is_err()
        );
        assert!(
            ValueSeries::new(
                "v",
                "x",
                vec![1.0],
                vec![Column::required("y", Vec::<f64>::new())]
            )
            .is_err()
        );
    }

    #[test]
    fn json_round_trips_and_orders() {
        let v = track().by_value("d").unwrap();
        for format in [RowFormat::Array, RowFormat::Object] {
            let back =
                ValueSeries::from_json(&v.to_json(format).unwrap(), KeyOrder::Strict).unwrap();
            // JSON has no -0.
            assert_eq!(back.axis(), &[0.0, 0.0, 1.0, 1.0]);
            assert_eq!(back.columns(), v.columns());
        }
        let back = ValueSeries::from_columns_json(&v.to_columns_json().unwrap(), KeyOrder::Strict)
            .unwrap();
        assert_eq!(back.columns(), v.columns());

        let text = r#"{"name":"x","schema":[{"name":"d","kind":"value"},{"name":"v","kind":"number"}],"rows":[[2,1],[1,2],[3,3]]}"#;
        assert!(ValueSeries::from_json(text, KeyOrder::Strict).is_err());
        let clamped = ValueSeries::from_json(text, KeyOrder::Clamp).unwrap();
        assert_eq!(clamped.axis(), &[2.0, 2.0, 3.0]);
        assert_eq!(
            clamped.column("v").unwrap().numbers().unwrap().values(),
            &[1.0, 2.0, 3.0]
        );
        let sorted = ValueSeries::from_json(text, KeyOrder::Reorder).unwrap();
        assert_eq!(
            sorted.column("v").unwrap().numbers().unwrap().values(),
            &[2.0, 1.0, 3.0]
        );
        // -0 and 0 are equal: a sort keeps their order, and a clamp keeps
        // -0 after 0 (JSON.parse reads "-0" as -0, as serde_json does).
        let zeros = r#"{"name":"x","schema":[{"name":"d","kind":"value"}],"rows":[[0],[-0],[0]]}"#;
        let bits = |v: &ValueSeries| v.axis().iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        let want = [0.0f64.to_bits(), (-0.0f64).to_bits(), 0.0f64.to_bits()];
        for order in [KeyOrder::Strict, KeyOrder::Reorder, KeyOrder::Clamp] {
            assert_eq!(
                bits(&ValueSeries::from_json(zeros, order).unwrap()),
                want,
                "{order:?}"
            );
        }
        // A time series reader refuses a value axis, and the other way round.
        assert!(TimeSeries::from_json(text, &crate::JsonOptions::new()).is_err());
        assert!(
            ValueSeries::from_json(
                &track().to_json(RowFormat::Array).unwrap(),
                KeyOrder::Strict
            )
            .is_err()
        );
    }
}
