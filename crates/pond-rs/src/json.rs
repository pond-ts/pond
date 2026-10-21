//! pond-ts's JSON wire format: [`TimeSeries::from_json`] and
//! [`TimeSeries::to_json`], as pond-ts `TimeSeries.fromJSON` / `toJSON`.

use serde_json::Value;

use crate::json_text::{Json, NULL};

use crate::column::{ArrayColumn, BooleanColumn, ColumnData, Float64Column, Scalar, StringColumn};
use crate::error::{PondError, Result};
use crate::series::{
    Column, ColumnDef, ColumnKind, IntervalKeys, Key, Labels, TimeRangeKeys, TimeSeries,
};

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

pub(crate) fn invalid(call: &'static str, message: String) -> PondError {
    PondError::InvalidData { call, message }
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
    /// Also errors, where pond-ts accepts: text holding a lone UTF-16
    /// surrogate (`"\ud800"`), which is not valid Unicode; a time that is
    /// not a whole millisecond (`1.5`), or outside
    /// ±[`MAX_TIME_MS`](crate::MAX_TIME_MS); a missing `name`; an `array`
    /// column (not in pond-rs yet).
    pub fn from_json(text: &str, options: &JsonOptions) -> Result<TimeSeries> {
        read_json(&parse(FROM, text)?, options)
    }

    /// [`TimeSeries::from_json`] from JSON already parsed with
    /// [`serde_json`].
    pub fn from_json_value(value: &Value, options: &JsonOptions) -> Result<TimeSeries> {
        read_json(&Json::from_value(value), options)
    }

    /// Write the series in pond-ts's JSON format (see
    /// [`TimeSeries::from_json`]), as pond-ts `toJSON({ rowFormat })`: the text
    /// [`TimeSeries::from_json`] and pond-ts `fromJSON` read back. Times are
    /// epoch milliseconds; a gap is `null`; numbers are written as
    /// JavaScript writes them (`0.000001`, `1e-7`, `1e+21`, `-0` as `0`).
    ///
    /// The schema holds each column's `name` and `kind`, and
    /// `"required": false` on a value column that allows gaps. pond-ts
    /// writes back the schema it was given, so a schema read with extra
    /// entries (`"required": true`, other properties) comes out without
    /// them here. Object rows list names in schema order; JavaScript puts
    /// names that look like whole numbers (`"1"`) first, so for such a
    /// column pond-ts's text has another order (the JSON means the same).
    ///
    /// An error for a decimal column, which pond-ts has no kind for: convert
    /// it with [`TimeSeries::map_decimals`] first, or write Arrow
    /// ([`TimeSeries::write_ipc`]), which keeps it exact.
    pub fn to_json(&self, format: RowFormat) -> Result<String> {
        refuse_decimals(TO, self.columns())?;
        // Written straight to text: building a `Value` tree first cost
        // several times as much (a map per object row).
        let mut out = Vec::with_capacity(64 + self.len() * 16 * (1 + self.columns().len()));
        out.extend_from_slice(b"{\"name\":");
        push_text(&mut out, self.name());
        out.extend_from_slice(b",\"schema\":");
        push_schema(&mut out, &self.schema());
        out.extend_from_slice(b",\"rows\":[");
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
                push_cell(&mut out, column.data(), i);
            }
            out.push(if object { b'}' } else { b']' });
        }
        out.extend_from_slice(b"]}");
        Ok(String::from_utf8(out).expect("JSON text is UTF-8"))
    }

    /// [`TimeSeries::to_json`] as a [`serde_json::Value`]. Its objects keep
    /// their keys in the order serde_json keeps them: sorted, unless your
    /// build turns on serde_json's `preserve_order` feature (the text from
    /// `to_json` always has schema order).
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

/// [`TimeSeries::from_json`] on parsed JSON.
fn read_json(value: &Json, options: &JsonOptions) -> Result<TimeSeries> {
    let name = read_name(FROM, value)?;
    let schema = read_schema(FROM, value.get("schema"))?;
    let rows = value
        .get("rows")
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid(FROM, "expected \"rows\" as an array".into()))?;
    read_rows(
        FROM,
        name,
        &schema,
        rows,
        RowShape::Rows,
        Some(&options.time_zone),
        options.order,
    )
}

/// How each row of [`read_rows`] is laid out.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RowShape {
    /// pond-ts `fromJSON` rows: an array in schema order or an object keyed
    /// by column name.
    Rows,
    /// pond-ts `fromPoints`: an object with the time under `ts`.
    Points,
}

/// Build a series from row-shaped JSON. `zone` is `None` where pond-ts takes
/// times only as numbers.
pub(crate) fn read_rows(
    call: &'static str,
    name: &str,
    schema: &[(String, ColumnKind, bool)],
    rows: &[Json],
    shape: RowShape,
    zone: Option<&str>,
    order: KeyOrder,
) -> Result<TimeSeries> {
    let (key_name, key_kind) = (&schema[0].0, schema[0].1);
    if order == KeyOrder::Clamp && key_kind != ColumnKind::Time {
        return Err(invalid(
            call,
            format!(
                "KeyOrder::Clamp is for point-in-time keys only; this key is '{}' (use KeyOrder::Reorder, or sort the rows first)",
                key_kind.as_str()
            ),
        ));
    }
    if key_kind == ColumnKind::Value {
        return Err(invalid(
            call,
            format!("the key '{key_name}' is a 'value' axis: read it with ValueSeries::from_json"),
        ));
    }
    let read_time = |v: &Json, row: usize| read_time(call, v, row, zone);

    let cells = row_cells(call, schema, rows, shape)?;
    let n = rows.len();
    let mut begin = Vec::with_capacity(n);
    let mut end = Vec::with_capacity(n);
    let mut labels: Vec<LabelCell> = Vec::new();
    for (i, &key) in cells[0].iter().enumerate() {
        match key_kind {
            ColumnKind::Time => {
                let t = read_time(key, i)?;
                begin.push(t);
            }
            ColumnKind::TimeRange => {
                let (b, e) = read_span(call, key, i, false)?;
                begin.push(read_time(b, i)?);
                end.push(read_time(e, i)?);
            }
            _ => {
                let (b, e) = read_span(call, key, i, true)?;
                let label = match key {
                    Json::Array(a) => &a[0],
                    _ => key.get("value").unwrap_or(NULL),
                };
                labels.push(read_label(call, label, i, labels.first())?);
                begin.push(read_time(b, i)?);
                end.push(read_time(e, i)?);
            }
        }
        if let Some(&b) = end.last()
            && b < *begin.last().expect("pushed with end")
        {
            return Err(invalid(
                call,
                format!(
                    "the key at row {i} ends ({b}) before it starts ({})",
                    begin[i]
                ),
            ));
        }
    }

    // Rows in the order the series will hold them.
    let order: Option<Vec<usize>> = match order {
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

    let columns = row_columns(call, &schema[1..], &cells[1..], n, &row_at)?;

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
    TimeSeries::with_key(call, name.to_string(), key_name.clone(), key, columns)
}

/// Each row's cells, column by column (`cells[c][i]`, key first). A row is
/// an array in schema order or an object keyed by column name; a point is
/// an object with the key under `ts`. A name an object row leaves out is a
/// `null`.
pub(crate) fn row_cells<'b, 'a>(
    call: &'static str,
    schema: &[(String, ColumnKind, bool)],
    rows: &'b [Json<'a>],
    shape: RowShape,
) -> Result<Vec<Vec<&'b Json<'a>>>> {
    let n = rows.len();
    let mut cells: Vec<Vec<&Json>> = vec![Vec::with_capacity(n); schema.len()];
    // Where each name in an object row goes. Points hold the time under
    // "ts".
    let names: Vec<&str> = std::iter::once(match shape {
        RowShape::Points => "ts",
        RowShape::Rows => schema[0].0.as_str(),
    })
    .chain(schema[1..].iter().map(|c| c.0.as_str()))
    .collect();
    let mut column_of: std::collections::HashMap<&str, usize> = Default::default();
    for (c, name) in names.iter().enumerate().rev() {
        column_of.insert(name, c);
    }
    let mut slots: Vec<&Json> = vec![NULL; schema.len()];
    for (i, row) in rows.iter().enumerate() {
        match row {
            Json::Object(o) => {
                // A later entry with the same name wins, as in JSON.parse.
                slots.fill(NULL);
                for (p, (k, v)) in o.entries().iter().enumerate() {
                    // Rows usually list names in schema order: check that
                    // before hashing.
                    let c = match names.get(p) {
                        Some(name) if *name == k.as_ref() => Some(p),
                        _ => column_of.get(k.as_ref()).copied(),
                    };
                    if let Some(c) = c {
                        slots[c] = v;
                    }
                }
            }
            _ if shape == RowShape::Points => {
                return Err(invalid(call, format!("point {i} is not an object")));
            }
            Json::Array(a) if a.len() != schema.len() => {
                return Err(invalid(
                    call,
                    format!(
                        "row {i} has {} values; the schema has {} columns",
                        a.len(),
                        schema.len()
                    ),
                ));
            }
            Json::Array(a) => {
                for (slot, v) in slots.iter_mut().zip(a) {
                    *slot = v;
                }
            }
            _ => {
                return Err(invalid(
                    call,
                    format!("row {i} is not an array or an object"),
                ));
            }
        }
        for (cells, v) in cells.iter_mut().zip(&slots) {
            cells.push(v);
        }
    }
    Ok(cells)
}

/// The value columns of row-shaped JSON, as [`row_cells`] splits it:
/// `schema` and `cells` without the key. Row `r` of the result is row
/// `row_at(r)` of the input. A gap in a required column is refused when
/// the series is built.
pub(crate) fn row_columns(
    call: &'static str,
    schema: &[(String, ColumnKind, bool)],
    cells: &[Vec<&Json>],
    n: usize,
    row_at: &dyn Fn(usize) -> usize,
) -> Result<Vec<Column>> {
    let mut columns = Vec::with_capacity(schema.len());
    for (c, (col_name, kind, required)) in schema.iter().enumerate() {
        let cell = |r: usize| cells[c][row_at(r)];
        let wrong = |r: usize, want: &str| {
            invalid(
                call,
                format!(
                    "row {} column '{col_name}': expected {want}, got {}",
                    row_at(r),
                    cells[c][row_at(r)]
                ),
            )
        };
        let data: ColumnData = match kind {
            ColumnKind::Number => Float64Column::from_options(
                (0..n)
                    .map(|r| match cell(r) {
                        Json::Null => Ok(None),
                        Json::Number(v) => Ok(v.as_f64()),
                        _ => Err(wrong(r, "a number")),
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
            .into(),
            ColumnKind::String => StringColumn::from_options(
                (0..n)
                    .map(|r| match cell(r) {
                        Json::Null => Ok(None),
                        Json::String(v) => Ok(Some(v.as_ref())),
                        _ => Err(wrong(r, "a string")),
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
            .into(),
            ColumnKind::Array => ArrayColumn::from_options(
                (0..n)
                    .map(|r| match cell(r) {
                        Json::Null => Ok(None),
                        Json::Array(a) => read_array(call, a, row_at(r), col_name).map(Some),
                        _ => Err(wrong(r, "an array")),
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
            .into(),
            _ => BooleanColumn::from_options(
                (0..n)
                    .map(|r| match cell(r) {
                        Json::Null => Ok(None),
                        Json::Bool(v) => Ok(Some(*v)),
                        _ => Err(wrong(r, "true or false")),
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
            .into(),
        };
        columns.push(Column::from_data(col_name.clone(), data, *required));
    }
    Ok(columns)
}

/// The schema as pond-ts writes it.
pub(crate) fn push_schema(out: &mut Vec<u8>, schema: &[ColumnDef]) {
    out.push(b'[');
    for (i, def) in schema.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(b"{\"name\":");
        push_text(out, &def.name);
        out.extend_from_slice(b",\"kind\":");
        push_text(out, def.kind.as_str());
        if i > 0 && !def.required {
            out.extend_from_slice(b",\"required\":false");
        }
        out.push(b'}');
    }
    out.push(b']');
}

/// One value cell; `null` for a gap. Not for decimal columns.
pub(crate) fn push_cell(out: &mut Vec<u8>, data: &ColumnData, i: usize) {
    match data {
        ColumnData::Number(v) => match v.get(i) {
            Some(x) => push_number(out, x),
            None => out.extend_from_slice(b"null"),
        },
        ColumnData::String(v) => match v.get(i) {
            Some(x) => push_text(out, x),
            None => out.extend_from_slice(b"null"),
        },
        ColumnData::Boolean(v) => out.extend_from_slice(match v.get(i) {
            Some(true) => b"true",
            Some(false) => b"false",
            None => b"null",
        }),
        ColumnData::Array(v) => match v.get(i) {
            Some(x) => push_array(out, x),
            None => out.extend_from_slice(b"null"),
        },
        ColumnData::Decimal(_) => unreachable!("decimals are refused first"),
    }
}

/// One array cell, as `JSON.stringify` writes it (`-0` as `0`).
pub(crate) fn push_array(out: &mut Vec<u8>, cell: &[Scalar]) {
    out.push(b'[');
    for (i, e) in cell.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        match e {
            Scalar::Number(x) => push_number(out, *x),
            Scalar::String(x) => push_text(out, x),
            Scalar::Boolean(x) => out.extend_from_slice(if *x { b"true" } else { b"false" }),
        }
    }
    out.push(b']');
}

/// pond-ts has no kind for exact decimals.
pub(crate) fn refuse_decimals(call: &'static str, columns: &[Column]) -> Result<()> {
    match columns.iter().find(|c| c.kind() == ColumnKind::Decimal) {
        Some(c) => Err(PondError::Unsupported {
            call,
            message: format!(
                "column '{}' holds exact decimals, which pond-ts's JSON has no kind for; map it to numbers first, or write Arrow, which keeps it exact",
                c.name()
            ),
        }),
        None => Ok(()),
    }
}

pub(crate) fn push_int(out: &mut Vec<u8>, v: i64) {
    use std::io::Write;
    write!(out, "{v}").expect("writing to a Vec cannot fail");
}

/// Text as a JSON string, escaped as `serde_json` escapes it.
pub(crate) fn push_text(out: &mut Vec<u8>, text: &str) {
    serde_json::to_writer(out, text).expect("writing to a Vec cannot fail");
}

/// A number as JavaScript's `JSON.stringify` writes it (ECMAScript
/// `Number::toString`): the shortest digits that read back to the same
/// number, written out in full from 1e-6 up to 1e21 and with an exponent
/// (`1e-7`, `1.5e+21`) outside that; `-0` as `0`; `null` when not finite.
pub(crate) fn push_number(out: &mut Vec<u8>, v: f64) {
    if !v.is_finite() {
        out.extend_from_slice(b"null");
        return;
    }
    if v == 0.0 {
        out.push(b'0');
        return;
    }
    // Below 2^53 a whole number's exact digits are its shortest ones.
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        push_int(out, v as i64); // the common case
        return;
    }
    // The shortest digits, from zmij (which serde_json writes numbers
    // with): `1.5`, `0.001`, `1e-7`, `1.2345e+20`. Read them as
    // 0.d1..dk × 10^n.
    let mut buffer = zmij::Buffer::new();
    let text = buffer.format_finite(v.abs()).as_bytes();
    let (mantissa, exp10) = match text.iter().position(|&b| b == b'e') {
        Some(i) => (
            &text[..i],
            std::str::from_utf8(&text[i + 1..])
                .ok()
                .and_then(|e| e.parse::<i32>().ok())
                .expect("zmij writes a whole exponent"),
        ),
        None => (text, 0),
    };
    let point = mantissa
        .iter()
        .position(|&b| b == b'.')
        .unwrap_or(mantissa.len());
    let mut all = [0u8; 40];
    let mut len = 0;
    for &b in mantissa.iter().filter(|b| **b != b'.') {
        all[len] = b;
        len += 1;
    }
    let lead = all[..len].iter().take_while(|&&b| b == b'0').count();
    let mut end = len;
    while end > lead + 1 && all[end - 1] == b'0' {
        end -= 1;
    }
    let digits = &mut all[lead..end];
    let n = point as i32 - lead as i32 + exp10;
    js_tie_to_even(v.abs(), digits, n);
    let digits: &[u8] = digits;
    let k = digits.len() as i32;
    if v < 0.0 {
        out.push(b'-');
    }
    if k <= n && n <= 21 {
        out.extend_from_slice(digits);
        out.extend(std::iter::repeat_n(b'0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.extend_from_slice(&digits[..n as usize]);
        out.push(b'.');
        out.extend_from_slice(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.extend_from_slice(b"0.");
        out.extend(std::iter::repeat_n(b'0', (-n) as usize));
        out.extend_from_slice(digits);
    } else {
        out.push(digits[0]);
        if k > 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..]);
        }
        out.push(b'e');
        out.push(if n - 1 < 0 { b'-' } else { b'+' });
        push_int(out, i64::from((n - 1).abs()));
    }
}

/// When the number lies exactly halfway between two shortest candidates
/// (`…095.25` between `…095.2` and `…095.3`), JavaScript takes the one
/// ending in an even digit; Rust's formatter rounds up. That needs the
/// number's exact decimal value to have one more significant digit than
/// the shortest form, ending in 5, which [`exact_digits`] finds cheaply.
/// `digits` is `0.d1..dk × 10^n`.
fn js_tie_to_even(v: f64, digits: &mut [u8], n: i32) {
    let k = digits.len();
    let Some(exact) = exact_digits(v, k + 1) else {
        return;
    };
    if exact.len() != k + 1 || exact[k] != b'5' {
        return;
    }
    // The two candidates: the exact digits cut to k, and one up from that.
    let lower = &exact[..k];
    let mut upper = lower.to_vec();
    let mut i = k;
    loop {
        if i == 0 {
            return; // 99…9 + 1 changes length; not a tie between k digits
        }
        i -= 1;
        if upper[i] == b'9' {
            upper[i] = b'0';
        } else {
            upper[i] += 1;
            break;
        }
    }
    let even: &[u8] = if lower[k - 1] % 2 == 0 { lower } else { &upper };
    if *digits == *even {
        return;
    }
    let mut text = String::from("0.");
    text.push_str(std::str::from_utf8(even).expect("digits"));
    if format!("{text}e{n}").parse::<f64>() == Ok(v) {
        digits.copy_from_slice(even);
    }
}

/// The significant digits of `v`'s exact decimal value (`v` > 0), or
/// `None` when there are more than `most`. A double is `m × 2^e`; with `m`
/// odd, the exact value has the digits of `m × 5^-e` (for `e < 0`) or of
/// `m × 2^e` (for `e ≥ 0`), so this is integer arithmetic.
fn exact_digits(v: f64, most: usize) -> Option<Vec<u8>> {
    let bits = v.to_bits();
    let raw_exp = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (mut m, mut e) = if raw_exp == 0 {
        (frac, -1074)
    } else {
        (frac | (1u64 << 52), raw_exp - 1075)
    };
    let zeros = m.trailing_zeros();
    m >>= zeros;
    e += zeros as i32;
    let value: u128 = if e >= 0 {
        // Past u128 the number has well over `most` digits... unless it is
        // a short digit run followed by zeros, which cannot be odd-halfway
        // for the doubles this path sees (they are whole and ≥ 2^53, where
        // every candidate is a whole number). Leave those alone.
        if e as u32 + (64 - m.leading_zeros()) > 127 {
            return None;
        }
        u128::from(m) << e
    } else {
        // m × 5^n has more than 18 digits once n > 26.
        if -e > 26 {
            return None;
        }
        u128::from(m) * 5u128.pow((-e) as u32)
    };
    let text = value.to_string();
    let significant = text.trim_end_matches('0');
    (significant.len() <= most).then(|| significant.as_bytes().to_vec())
}

/// Parse JSON text.
pub(crate) fn parse<'a>(call: &'static str, text: &'a str) -> Result<Json<'a>> {
    serde_json::from_str(text).map_err(|e| invalid(call, format!("the text is not JSON: {e}")))
}

/// The `name` of a JSON series.
pub(crate) fn read_name<'a>(call: &'static str, value: &'a Json<'_>) -> Result<&'a str> {
    value
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid(call, "expected a \"name\" that is a string".into()))
}

/// One array cell's elements: numbers, text and true/false values only.
pub(crate) fn read_array(
    call: &'static str,
    cell: &[Json],
    row: usize,
    column: &str,
) -> Result<Vec<Scalar>> {
    cell.iter()
        .enumerate()
        .map(|(e, v)| match v {
            Json::Number(x) => Ok(Scalar::Number(x.as_f64().expect("always a number"))),
            Json::String(x) => Ok(Scalar::String(x.to_string())),
            Json::Bool(x) => Ok(Scalar::Boolean(*x)),
            _ => Err(invalid(
                call,
                format!(
                    "row {row} column '{column}': array element {e} must be a finite number, string, or boolean, got {v}"
                ),
            )),
        })
        .collect()
}

/// The schema as (name, kind, required), key first.
pub(crate) fn read_schema(
    call: &'static str,
    schema: Option<&Json>,
) -> Result<Vec<(String, ColumnKind, bool)>> {
    let entries = schema
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid(call, "expected \"schema\" as an array".into()))?;
    if entries.is_empty() {
        return Err(invalid(
            call,
            "the schema needs at least a key column".into(),
        ));
    }
    entries
        .iter()
        .enumerate()
        .map(|(c, entry)| {
            let name = entry
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| invalid(call, format!("schema column {c} has no \"name\"")))?;
            let kind_text = entry.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let kind = match (c, kind_text) {
                (0, "time") => ColumnKind::Time,
                (0, "timeRange") => ColumnKind::TimeRange,
                (0, "interval") => ColumnKind::Interval,
                (0, "value") => ColumnKind::Value,
                (0, other) => {
                    return Err(invalid(call, format!(
                        "the first schema column is the key, and must be 'time', 'timeRange', 'interval' or (for a ValueSeries) 'value'; got '{other}'"
                    )));
                }
                (_, "number") => ColumnKind::Number,
                (_, "string") => ColumnKind::String,
                (_, "boolean") => ColumnKind::Boolean,
                (_, "array") => ColumnKind::Array,
                (_, other) => {
                    return Err(invalid(call, format!(
                        "column '{name}' has kind '{other}'; value columns are 'number', 'string', 'boolean' or 'array'"
                    )));
                }
            };
            // As in pond-ts, only `required: false` allows gaps.
            let required = entry.get("required") != Some(&Json::Bool(false));
            Ok((name.to_string(), kind, required))
        })
        .collect()
}

/// A time: epoch milliseconds, or text read in `zone` (refused when `zone`
/// is `None`).
pub(crate) fn read_time(
    call: &'static str,
    v: &Json,
    row: usize,
    zone: Option<&str>,
) -> Result<i64> {
    match v {
        Json::Number(n) => {
            if let Some(t) = n.as_i64() {
                return Ok(t);
            }
            let f = n.as_f64().unwrap_or(f64::NAN);
            // Whole numbers written as floats (`1000.0`, `2e3`) are fine.
            if f.fract() == 0.0 && f.abs() < 9.3e18 {
                return Ok(f as i64);
            }
            Err(invalid(
                call,
                format!(
                    "row {row}: the time {n} is not a whole number of milliseconds (pond-rs times are whole milliseconds)"
                ),
            ))
        }
        Json::String(text) if let Some(zone) = zone => {
            crate::parse_time_in(text, zone).map_err(|e| invalid(call, format!("row {row}: {e}")))
        }
        other if zone.is_some() => Err(invalid(
            call,
            format!(
                "row {row}: expected a time as a number of milliseconds or as text, got {other}"
            ),
        )),
        other => Err(invalid(
            call,
            format!("row {row}: expected a time as a number of milliseconds, got {other}"),
        )),
    }
}

/// The start and end of a time range (`[begin, end]` / `{start, end}`) or
/// an interval (`[label, begin, end]` / `{value, start, end}`).
fn read_span<'a>(
    call: &'static str,
    v: &'a Json<'a>,
    row: usize,
    interval: bool,
) -> Result<(&'a Json<'a>, &'a Json<'a>)> {
    match v {
        Json::Array(a) if !interval && a.len() == 2 => Ok((&a[0], &a[1])),
        Json::Array(a) if interval && a.len() == 3 => Ok((&a[1], &a[2])),
        Json::Object(o)
            if o.contains_key("start")
                && o.contains_key("end")
                && o.contains_key("value") == interval =>
        {
            Ok((o.get("start").unwrap_or(NULL), o.get("end").unwrap_or(NULL)))
        }
        _ if interval => Err(invalid(
            call,
            format!(
                "row {row}: expected an interval as [label, start, end] or {{\"value\", \"start\", \"end\"}}, got {v}"
            ),
        )),
        _ => Err(invalid(
            call,
            format!(
                "row {row}: expected a time range as [start, end] or {{\"start\", \"end\"}}, got {v}"
            ),
        )),
    }
}

pub(crate) enum LabelCell<'a> {
    Number(f64),
    String(&'a str),
}

/// An interval label: text or a number, the same kind as the first row's.
pub(crate) fn read_label<'a>(
    call: &'static str,
    v: &'a Json<'_>,
    row: usize,
    first: Option<&LabelCell>,
) -> Result<LabelCell<'a>> {
    let label = match v {
        Json::String(s) => LabelCell::String(s.as_ref()),
        Json::Number(n) => LabelCell::Number(n.as_f64().expect("JSON numbers are finite")),
        other => {
            return Err(invalid(
                call,
                format!("row {row}: an interval label must be text or a number, got {other}"),
            ));
        }
    };
    match (first, &label) {
        (Some(LabelCell::Number(_)), LabelCell::String(_))
        | (Some(LabelCell::String(_)), LabelCell::Number(_)) => Err(invalid(
            call,
            format!(
                "row {row}: interval labels must all be text or all numbers; this one is {v}, unlike row 0's"
            ),
        )),
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
        assert_eq!(text(1e-6), "0.000001");
        assert_eq!(text(-1.5e-6), "-0.0000015");
        assert_eq!(text(1e19), "10000000000000000000");
        assert_eq!(text(1.2345678901234568e20), "123456789012345680000");
        assert_eq!(text(1e21), "1e+21");
        assert_eq!(text(-1.5e21), "-1.5e+21");
        assert_eq!(text(5e-324), "5e-324");
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
