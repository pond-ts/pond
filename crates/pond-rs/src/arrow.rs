//! Arrow in and out: record batches and IPC files.
//!
//! Field naming follows pond-ts `toArrow` / `fromArrow`:
//!
//! - a time key is one field, by default `time`;
//! - a time-range key is `timeRange` (start) and `timeRangeEnd`;
//! - an interval key (an `aggregate` result) is `interval` (start),
//!   `intervalEnd`, the value columns, then `intervalLabel` last.
//!
//! A file written by either reads in the other: pond-rs with
//! [`ArrowKey`], pond-ts with `fromArrow(table, { keyKind })`. pond-ts reads
//! range and interval keys only under those default names; pond-rs reads any
//! name `<name>`, `<name>End` (and `<name>Label`).
//!
//! Reading takes the IPC file or stream format, uncompressed or with LZ4 /
//! ZSTD buffers; writing is always an uncompressed file, which every
//! reader (apache-arrow JS included) can open.
//!
//! pond-rs keys are whole epoch milliseconds. Written keys are
//! `Timestamp(Millisecond, "UTC")`; a gap in a value column is an Arrow null.
//! Value columns are `Float64`, `Utf8` (or a dictionary of it) and `Boolean`,
//! as pond-ts writes them.

use std::io::{Read, Write};
use std::sync::Arc;

use arrow_array::cast::AsArray;
use arrow_array::types::{
    Float16Type, Float32Type, Float64Type, Int8Type, Int16Type, Int32Type, Int64Type, UInt8Type,
    UInt16Type, UInt32Type, UInt64Type,
};
use arrow_array::{Array, ArrayRef, Float64Array, RecordBatch, TimestampMillisecondArray};
use arrow_buffer::{BooleanBuffer, Buffer, NullBuffer};
use arrow_ipc::convert::fb_to_schema;
use arrow_ipc::reader::{FileDecoder, StreamDecoder, read_footer_length};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};

use crate::column::{BooleanColumn, ColumnData, Float64Column, StringColumn};
use crate::error::{PondError, Result};
use crate::series::{Column, IntervalKeys, Key, Labels, MAX_TIME_MS, TimeRangeKeys, TimeSeries};

const FROM: &str = "TimeSeries::from_arrow";
const TO: &str = "TimeSeries::to_arrow";
const READ: &str = "TimeSeries::read_ipc";

/// Every record batch in an Arrow IPC file held in memory. Uses arrow's
/// `FileDecoder`, which slices the batches out of `bytes` without copying
/// (arrow's `FileReader` copies each buffer: ~38 ms against ~0.1 ms on the
/// 38 MB benchmark file).
///
/// arrow's decoder panics on some corrupt files (buffer offsets past the end
/// of a block, malformed schemas) instead of returning an error. On native
/// targets the panic is caught and returned as an error; on wasm32, where
/// panics abort, a corrupt file still aborts.
fn decode_ipc(bytes: Vec<u8>) -> Result<Vec<RecordBatch>> {
    // The file format starts (and ends) with this magic; a stream does not.
    if bytes.is_empty() {
        return Err(invalid(
            READ,
            "no bytes: an empty Arrow IPC file or stream".into(),
        ));
    }
    let is_file = bytes.starts_with(b"ARROW1");
    std::panic::catch_unwind(move || {
        if is_file {
            decode_ipc_file_unchecked(bytes)
        } else {
            decode_ipc_stream_unchecked(bytes)
        }
    })
    .unwrap_or_else(|_| {
        Err(invalid(
            READ,
            "corrupt Arrow IPC data (arrow's decoder panicked)".into(),
        ))
    })
}

/// Every record batch in Arrow IPC stream-format bytes, sliced out of
/// `bytes` without copying (unless compressed).
fn decode_ipc_stream_unchecked(bytes: Vec<u8>) -> Result<Vec<RecordBatch>> {
    let ipc = |e: arrow_schema::ArrowError| {
        invalid(
            READ,
            format!("not an Arrow IPC file or stream, or a corrupt one: {e}"),
        )
    };
    let mut buffer = Buffer::from_vec(bytes);
    let mut decoder = StreamDecoder::new();
    let mut batches = Vec::new();
    while !buffer.is_empty() {
        if let Some(batch) = decoder.decode(&mut buffer).map_err(ipc)? {
            batches.push(batch);
        }
    }
    decoder.finish().map_err(ipc)?;
    Ok(batches)
}

fn decode_ipc_file_unchecked(bytes: Vec<u8>) -> Result<Vec<RecordBatch>> {
    let ipc = |e: arrow_schema::ArrowError| invalid(READ, e.to_string());
    let not_ipc = || {
        invalid(
            READ,
            "not an Arrow IPC file (too short or no footer)".into(),
        )
    };
    let buffer = Buffer::from_vec(bytes);
    let trailer = buffer.len().checked_sub(10).ok_or_else(not_ipc)?;
    let footer_len =
        read_footer_length(buffer[trailer..].try_into().map_err(|_| not_ipc())?).map_err(ipc)?;
    let footer_start = trailer.checked_sub(footer_len).ok_or_else(not_ipc)?;
    let footer = arrow_ipc::root_as_footer(&buffer[footer_start..trailer])
        .map_err(|e| invalid(READ, format!("bad IPC footer: {e}")))?;
    let schema = footer
        .schema()
        .ok_or_else(|| invalid(READ, "IPC footer has no schema".into()))?;
    let mut decoder = FileDecoder::new(Arc::new(fb_to_schema(schema)), footer.version());
    let block_data = |block: &arrow_ipc::Block| -> Result<Buffer> {
        let offset = usize::try_from(block.offset()).map_err(|_| not_ipc())?;
        let len = usize::try_from(block.metaDataLength()).map_err(|_| not_ipc())?
            + usize::try_from(block.bodyLength()).map_err(|_| not_ipc())?;
        if offset.checked_add(len).is_none_or(|end| end > buffer.len()) {
            return Err(invalid(
                READ,
                "IPC block runs past the end of the file".into(),
            ));
        }
        Ok(buffer.slice_with_length(offset, len))
    };
    for block in footer.dictionaries().iter().flatten() {
        decoder
            .read_dictionary(block, &block_data(block)?)
            .map_err(ipc)?;
    }
    let mut batches = Vec::new();
    for block in footer.recordBatches().iter().flatten() {
        if let Some(batch) = decoder
            .read_record_batch(block, &block_data(block)?)
            .map_err(ipc)?
        {
            batches.push(batch);
        }
    }
    Ok(batches)
}

/// Which fields of an Arrow table hold the key, for
/// [`TimeSeries::from_arrow`]. A plain `&str` or `String` means a time key of
/// that name, so `from_arrow(name, batches, "time")` reads a time-keyed table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArrowKey {
    /// One field of points in time.
    Time(String),
    /// Spans of time: the named field holds each start, `<name>End` each
    /// end. pond-ts writes this with the name `timeRange`.
    TimeRange(String),
    /// Labelled spans, as `aggregate` makes: `<name>` and `<name>End` as for
    /// [`ArrowKey::TimeRange`], plus `<name>Label`, numbers or text with no
    /// nulls. pond-ts writes this with the name `interval`.
    Interval(String),
}

impl ArrowKey {
    /// The name of the field holding the key's start (or its time).
    pub fn name(&self) -> &str {
        match self {
            ArrowKey::Time(n) | ArrowKey::TimeRange(n) | ArrowKey::Interval(n) => n,
        }
    }
}

impl From<&str> for ArrowKey {
    fn from(name: &str) -> Self {
        ArrowKey::Time(name.to_string())
    }
}

impl From<String> for ArrowKey {
    fn from(name: String) -> Self {
        ArrowKey::Time(name)
    }
}

/// An interval key's labels: text fields as text, any number type as `f64`.
/// A null label is an error (from `with_key`: a text gap, or a number read
/// as NaN).
fn read_labels(batches: &[RecordBatch], c: usize, field: &Field) -> Result<Labels> {
    if is_text(field.data_type()) {
        return Ok(Labels::String(read_strings(batches, c, field.name())?));
    }
    let mut values = Vec::new();
    for batch in batches {
        read_number(batch.column(c), field.name(), &mut values)?;
    }
    Ok(Labels::Number(values))
}

/// Arrow types read as text: `Utf8`, `LargeUtf8`, `Utf8View`, or a dictionary
/// of `Utf8` / `LargeUtf8`.
fn is_text(data_type: &DataType) -> bool {
    match data_type {
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => true,
        DataType::Dictionary(_, values) => matches!(**values, DataType::Utf8 | DataType::LargeUtf8),
        _ => false,
    }
}

fn invalid(call: &'static str, message: String) -> PondError {
    PondError::InvalidData { call, message }
}

impl TimeSeries {
    /// Build a series from Arrow record batches (one table split into
    /// chunks; all batches must share a schema).
    ///
    /// - `key` names the key field. A plain name (`"time"`) is a time key;
    ///   [`ArrowKey::TimeRange`] and [`ArrowKey::Interval`] also read
    ///   `<name>End` and, for an interval, `<name>Label` (numbers of any type,
    ///   read as `f64`, or text; no nulls). Each key field is a `Timestamp` in any unit,
    ///   `Date32` (midnight UTC), `Date64`, or `Int64` or `Float64` epoch
    ///   milliseconds (`Float64` is
    ///   what pond-ts `toArrow` hands over). It must have no nulls, be in
    ///   order, and convert to whole milliseconds; a micro- or nanosecond
    ///   timestamp with a sub-millisecond part is an error rather than being
    ///   silently rounded.
    /// - With a single batch, a `Float64` field with no nulls is used in
    ///   place, sharing Arrow's buffer (and keeping the memory behind it
    ///   alive); every other field is copied.
    /// - Every other field becomes a value column, in field order. Any
    ///   integer or float type is read as `f64`; nulls, `NaN` and infinities
    ///   are gaps. A field Arrow marks nullable becomes an optional column
    ///   (even if it holds no nulls); a non-nullable one becomes required,
    ///   unless it holds `NaN` or infinities, which make it optional.
    /// - Time fields (`Timestamp`, `Date32`, `Date64`, `Time32`, `Time64`,
    ///   `Duration`) become number columns in milliseconds: epoch ms for
    ///   timestamps and dates, a length for the others. A fractional
    ///   millisecond is kept (`Timestamp(us)` 1500 is `1.5`); a value whose
    ///   whole milliseconds pass 2^53 is an error. Also read as numbers: a
    ///   `Float16` field, a `Null` field (all gaps), and a dictionary of
    ///   numbers or times (decoded; a null key or entry is a gap).
    /// - Text fields (`Utf8`, `LargeUtf8`, `Utf8View`, or a dictionary of
    ///   `Utf8` / `LargeUtf8`) become string columns and `Boolean` fields
    ///   true/false columns; nulls are gaps, and a field Arrow marks nullable
    ///   is optional. With a single batch, a `Utf8` field, a
    ///   `Dictionary<Int32, Utf8>` field and a `Boolean` field are used in
    ///   place, without copying; other text types are copied into `Utf8`.
    /// - Any other field type (decimals, binary, lists, structs, …) is an
    ///   error naming it.
    ///   Drop such fields first with [`RecordBatch::project`].
    ///
    /// The key column keeps its Arrow name.
    pub fn from_arrow(
        name: impl Into<String>,
        batches: &[RecordBatch],
        key: impl Into<ArrowKey>,
    ) -> Result<Self> {
        let key = key.into();
        let time_column = key.name();
        let Some(first) = batches.first() else {
            return Err(invalid(FROM, "no record batches given".into()));
        };
        let schema = first.schema();
        if let Some(i) = batches.iter().position(|b| b.schema() != schema) {
            return Err(invalid(
                FROM,
                format!("batch {i} has a different schema from batch 0"),
            ));
        }
        let Ok(time_index) = schema.index_of(time_column) else {
            return Err(PondError::UnknownColumn {
                call: FROM,
                column: time_column.to_string(),
                available: schema.fields().iter().map(|f| f.name().clone()).collect(),
            });
        };

        let rows: usize = batches.iter().map(RecordBatch::num_rows).sum();
        let read_edge = |index: usize, name: &str| -> Result<Vec<i64>> {
            let mut out = Vec::with_capacity(rows);
            for batch in batches {
                read_time(batch.column(index), name, out.len(), &mut out)?;
            }
            Ok(out)
        };
        let field_index = |field: String| -> Result<usize> {
            schema
                .index_of(&field)
                .map_err(|_| PondError::UnknownColumn {
                    call: FROM,
                    column: field,
                    available: schema.fields().iter().map(|f| f.name().clone()).collect(),
                })
        };
        let begin = read_edge(time_index, time_column)?;
        // Field positions that belong to the key, not to value columns.
        let mut key_fields = vec![time_index];
        let key_data = match &key {
            ArrowKey::Time(_) => Key::Time(begin),
            ArrowKey::TimeRange(_) | ArrowKey::Interval(_) => {
                let end_name = format!("{time_column}End");
                let end_index = field_index(end_name.clone())?;
                key_fields.push(end_index);
                let end = read_edge(end_index, &end_name)?;
                if let ArrowKey::Interval(_) = key {
                    let label_index = field_index(format!("{time_column}Label"))?;
                    key_fields.push(label_index);
                    let label = read_labels(batches, label_index, schema.field(label_index))?;
                    Key::Interval(IntervalKeys { label, begin, end })
                } else {
                    Key::TimeRange(TimeRangeKeys { begin, end })
                }
            }
        };

        let mut columns = Vec::with_capacity(schema.fields().len().saturating_sub(1));
        for (c, field) in schema.fields().iter().enumerate() {
            if key_fields.contains(&c) {
                continue;
            }
            let required = |missing: usize| !field.is_nullable() && missing == 0;
            if is_text(field.data_type()) {
                let data = read_strings(batches, c, field.name())?;
                let missing = data.missing_count();
                columns.push(Column::from_data(
                    field.name().clone(),
                    data,
                    required(missing),
                ));
                continue;
            }
            if field.data_type() == &DataType::Boolean {
                let data = match batches {
                    [batch] => BooleanColumn::from_arrow(batch.column(c).as_boolean().clone()),
                    _ => BooleanColumn::from_options(
                        batches.iter().flat_map(|b| b.column(c).as_boolean().iter()),
                    ),
                };
                let missing = data.missing_count();
                columns.push(Column::from_data(
                    field.name().clone(),
                    data,
                    required(missing),
                ));
                continue;
            }
            // One batch of Float64 with no nulls: point at Arrow's buffer,
            // no copy. (Nulls must become NaN, and several batches must be
            // joined, so those cases copy.)
            if let [batch] = batches {
                let array = batch.column(c);
                if array.data_type() == &DataType::Float64 && array.logical_null_count() == 0 {
                    let data = Float64Column::from_buffer(
                        array.as_primitive::<Float64Type>().values().clone(),
                    );
                    let required = !field.is_nullable() && data.all_finite();
                    columns.push(Column::from_data(field.name().clone(), data, required));
                    continue;
                }
            }
            let mut values = Vec::with_capacity(rows);
            for batch in batches {
                read_number(batch.column(c), field.name(), &mut values)?;
            }
            // Arrow's own flag decides: a nullable field is optional even
            // when this file has no nulls, so `to_arrow` → `from_arrow`
            // keeps the schema. A non-nullable float field holding NaN is
            // still optional, since NaN is a gap.
            columns.push(
                if !field.is_nullable() && values.iter().all(|v| v.is_finite()) {
                    Column::required(field.name().clone(), values)
                } else {
                    Column::optional_raw(field.name().clone(), values)
                },
            );
        }

        TimeSeries::with_key(
            FROM,
            name.into(),
            time_column.to_string(),
            key_data,
            columns,
        )
    }

    /// Read a series from an Arrow IPC file or stream (the `.arrow` /
    /// Feather v2 format, or the stream format; compressed or not). See
    /// [`TimeSeries::from_arrow`] for how fields are read.
    /// Reads the whole file into memory, then as
    /// [`TimeSeries::from_ipc_bytes`].
    pub fn read_ipc(
        name: impl Into<String>,
        mut reader: impl Read,
        key: impl Into<ArrowKey>,
    ) -> Result<Self> {
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|e| invalid(READ, e.to_string()))?;
        Self::from_ipc_bytes(name, bytes, key)
    }

    /// Read a series from the bytes of an Arrow IPC file already in memory
    /// (e.g. from `std::fs::read`). A corrupt file is an error, not a panic,
    /// except on wasm32 (see the module notes in `arrow.rs`).
    ///
    /// Reads both IPC layouts: the file format (`.arrow` / Feather v2, which
    /// starts with `ARROW1`) and the stream format (what pyarrow's
    /// `ipc.new_stream` and Arrow-over-HTTP send). Buffers compressed with
    /// LZ4 or ZSTD (pandas `to_feather` uses LZ4 by default) are
    /// decompressed, which copies them.
    ///
    /// Gap-free `Float64` columns in a one-batch file point into `bytes`
    /// instead of copying (see [`TimeSeries::from_arrow`]). The cost: while
    /// any such column is alive (in this series or one derived from it),
    /// the whole of `bytes` stays in memory, including the parts that were
    /// copied. If that matters, read with [`TimeSeries::read_ipc`] from a
    /// smaller file, or drop the series once its results are computed.
    pub fn from_ipc_bytes(
        name: impl Into<String>,
        bytes: Vec<u8>,
        key: impl Into<ArrowKey>,
    ) -> Result<Self> {
        Self::from_arrow(name, &decode_ipc(bytes)?, key)
    }

    /// The series as one Arrow record batch. Value columns are not copied:
    /// each column's buffer is shared with the batch (gaps get a validity
    /// bitmap over it). Key columns are copied.
    ///
    /// Fields: the key (`Timestamp(Millisecond, "UTC")`; a time-range or
    /// interval key adds `<key>End` after it, and an interval key adds
    /// `<key>Label` at the end: `Float64` for number labels, text as for a
    /// text column), then each value
    /// column, nullable unless the column is required, with gaps as nulls:
    /// numbers as `Float64`, text as `Utf8` (or `Dictionary<Int32, Utf8>` if
    /// it was read as one), true/false as `Boolean`. These are the types
    /// pond-ts `toArrow` uses.
    pub fn to_arrow(&self) -> Result<RecordBatch> {
        let key_name = self.key_name().to_string();
        let mut fields = Vec::new();
        let mut arrays: Vec<ArrayRef> = Vec::new();
        let mut push_time = |name: String, ms: &[i64]| {
            fields.push(Field::new(name, timestamp_ms(), false));
            arrays.push(Arc::new(
                TimestampMillisecondArray::from(ms.to_vec()).with_timezone("UTC"),
            ));
        };

        let label = match self.key() {
            Key::Time(t) => {
                push_time(key_name.clone(), t);
                None
            }
            Key::TimeRange(TimeRangeKeys { begin, end }) => {
                push_time(key_name.clone(), begin);
                push_time(format!("{key_name}End"), end);
                None
            }
            Key::Interval(IntervalKeys { label, begin, end }) => {
                push_time(key_name.clone(), begin);
                push_time(format!("{key_name}End"), end);
                Some(label)
            }
        };

        for column in self.columns() {
            // Each column's buffers are shared with the batch, not copied.
            let array: ArrayRef = match column.data() {
                ColumnData::Number(data) => {
                    let nulls = (!data.all_finite()).then(|| {
                        let v = data.values();
                        NullBuffer::new(BooleanBuffer::collect_bool(v.len(), |i| v[i].is_finite()))
                    });
                    Arc::new(Float64Array::new(data.buffer().clone(), nulls))
                }
                ColumnData::String(data) => data.arrow(),
                ColumnData::Boolean(data) => data.arrow(),
            };
            fields.push(Field::new(
                column.name(),
                array.data_type().clone(),
                !column.is_required(),
            ));
            arrays.push(array);
        }

        if let Some(label) = label {
            push_label(&mut fields, &mut arrays, format!("{key_name}Label"), label);
        }

        for (i, field) in fields.iter().enumerate() {
            if fields[..i].iter().any(|f| f.name() == field.name()) {
                return Err(invalid(
                    TO,
                    format!(
                        "field name '{}' would appear twice; a value column clashes with a key field",
                        field.name()
                    ),
                ));
            }
        }

        RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays)
            .map_err(|e| invalid(TO, e.to_string()))
    }

    /// Write the series as an Arrow IPC file (the `.arrow` / Feather v2
    /// format). See [`TimeSeries::to_arrow`] for the fields written.
    pub fn write_ipc(&self, writer: impl Write) -> Result<()> {
        let batch = self.to_arrow()?;
        let ipc = |e: arrow_schema::ArrowError| invalid("TimeSeries::write_ipc", e.to_string());
        let mut file = FileWriter::try_new(writer, &batch.schema()).map_err(ipc)?;
        file.write(&batch).map_err(ipc)?;
        file.finish().map_err(ipc)
    }
}

fn timestamp_ms() -> DataType {
    DataType::Timestamp(TimeUnit::Millisecond, Some("UTC".into()))
}

/// Interval labels as pond-ts writes them: numbers as `Float64`, text as
/// the column's own Arrow array (`Utf8`, or a dictionary if read as one).
fn push_label(fields: &mut Vec<Field>, arrays: &mut Vec<ArrayRef>, name: String, label: &Labels) {
    let array: ArrayRef = match label {
        Labels::Number(v) => Arc::new(Float64Array::from(v.clone())),
        Labels::String(s) => s.arrow(),
    };
    fields.push(Field::new(name, array.data_type().clone(), false));
    arrays.push(array);
}

/// Append one chunk of the key column to `out` as epoch milliseconds.
fn read_time(array: &ArrayRef, name: &str, offset: usize, out: &mut Vec<i64>) -> Result<()> {
    if let Some(i) = array
        .logical_nulls()
        .and_then(|n| n.iter().position(|v| !v))
    {
        return Err(invalid(
            FROM,
            format!("time column '{name}' is null at row {}", offset + i),
        ));
    }
    // pond-ts `toArrow` hands its key over as Float64 epoch milliseconds
    // (that is what pond-ts holds), and its documented recipe writes it so.
    if let DataType::Float64 = array.data_type() {
        for (i, &v) in array
            .as_primitive::<Float64Type>()
            .values()
            .iter()
            .enumerate()
        {
            // Range-checked here so the cast is exact; NaN fails `contains`.
            if v.fract() != 0.0 || !(-MAX_TIME_MS as f64..=MAX_TIME_MS as f64).contains(&v) {
                return Err(invalid(
                    FROM,
                    format!(
                        "time column '{name}' at row {} is {v}; Float64 times must be whole epoch milliseconds within ±{MAX_TIME_MS}",
                        offset + i
                    ),
                ));
            }
            out.push(v as i64);
        }
        return Ok(());
    }
    let unit = match array.data_type() {
        DataType::Timestamp(..) | DataType::Date32 | DataType::Date64 => {
            time_unit(array.data_type())
        }
        DataType::Int64 => Some((1, 1)),
        _ => None,
    };
    let Some((per_ms, ms_per)) = unit else {
        return Err(invalid(
            FROM,
            format!(
                "time column '{name}' is {}; expected a Timestamp, Date32, Date64, Int64 or Float64 (epoch ms)",
                array.data_type()
            ),
        ));
    };
    with_raw_i64(array, |raw| {
        if (per_ms, ms_per) == (1, 1) {
            out.extend_from_slice(raw);
            return Ok(());
        }
        for (i, &v) in raw.iter().enumerate() {
            if v % per_ms != 0 {
                return Err(invalid(
                    FROM,
                    format!(
                        "time column '{name}' at row {} has a sub-millisecond part; pond keys are whole milliseconds",
                        offset + i
                    ),
                ));
            }
            let ms = (v / per_ms).checked_mul(ms_per).ok_or_else(|| {
                invalid(
                    FROM,
                    format!("time column '{name}' at row {} is out of range", offset + i),
                )
            })?;
            out.push(ms);
        }
        Ok(())
    })
}

/// How an Arrow time type maps to milliseconds: (raw units per millisecond,
/// milliseconds per raw unit). `None` for anything that is not a time.
fn time_unit(data_type: &DataType) -> Option<(i64, i64)> {
    let of = |unit: &TimeUnit| match unit {
        TimeUnit::Second => (1, 1000),
        TimeUnit::Millisecond => (1, 1),
        TimeUnit::Microsecond => (1000, 1),
        TimeUnit::Nanosecond => (1_000_000, 1),
    };
    match data_type {
        DataType::Timestamp(unit, _)
        | DataType::Time32(unit)
        | DataType::Time64(unit)
        | DataType::Duration(unit) => Some(of(unit)),
        DataType::Date32 => Some((1, 86_400_000)),
        DataType::Date64 => Some((1, 1)),
        _ => None,
    }
}

/// Calls `f` with a 32- or 64-bit integer-backed array's raw values as
/// `i64`: borrowed when they already are, widened into a copy when not.
fn with_raw_i64<R>(array: &ArrayRef, f: impl FnOnce(&[i64]) -> R) -> R {
    let data = array.to_data();
    let len = array.len();
    match data.data_type().primitive_width() {
        Some(8) => f(&data.buffer::<i64>(0)[..len]),
        Some(4) => {
            let wide: Vec<i64> = data.buffer::<i32>(0)[..len]
                .iter()
                .map(|&v| i64::from(v))
                .collect();
            f(&wide)
        }
        other => unreachable!("time types are 32 or 64 bits wide, not {other:?}"),
    }
}

/// The largest whole number an `f64` holds exactly, 2^53.
const MAX_EXACT_F64: i64 = 1 << 53;

/// Append a time-typed value column as milliseconds (an epoch time for
/// timestamps and dates, a length for times of day and durations). Nulls
/// become NaN. Unlike a key, a value may have a fractional millisecond
/// (`Timestamp(us)` 1.5 ms reads as `1.5`): the whole milliseconds are
/// exact; the fraction is computed as an `f64` and then added, so the
/// result can be one unit in the last place from the nearest `f64`.
fn read_time_values(
    array: &ArrayRef,
    name: &str,
    (per_ms, ms_per): (i64, i64),
    out: &mut Vec<f64>,
) -> Result<()> {
    let start = out.len();
    let nulls = array.logical_nulls();
    with_raw_i64(array, |raw| {
        for (i, &v) in raw.iter().enumerate() {
            if nulls.as_ref().is_some_and(|n| n.is_null(i)) {
                out.push(f64::NAN);
                continue;
            }
            // per_ms > 1 only when ms_per == 1, so the fraction is
            // rem / per_ms of one millisecond.
            let whole = v
                .div_euclid(per_ms)
                .checked_mul(ms_per)
                .filter(|ms| ms.abs() <= MAX_EXACT_F64)
                .ok_or_else(|| {
                    invalid(
                        FROM,
                        format!(
                            "column '{name}' at row {} is too large to hold exactly in milliseconds",
                            start + i
                        ),
                    )
                })?;
            let rem = v.rem_euclid(per_ms);
            out.push(whole as f64 + rem as f64 / per_ms as f64);
        }
        Ok(())
    })
}

/// A text field across all batches. One `Utf8` or `Dictionary<Int32, Utf8>`
/// batch is kept as it is; anything else is copied into one `Utf8` array.
fn read_strings(batches: &[RecordBatch], c: usize, name: &str) -> Result<StringColumn> {
    if let [batch] = batches {
        let array = batch.column(c);
        if array.data_type() == &DataType::Utf8 {
            return Ok(StringColumn::plain(array.as_string::<i32>().clone()));
        }
        if let Some(dict) = array.as_dictionary_opt::<Int32Type>() {
            if let Some(column) = StringColumn::dictionary(dict.clone()) {
                return Ok(column);
            }
        }
    }
    let mut values: Vec<Option<&str>> = Vec::new();
    for batch in batches {
        let array = batch.column(c);
        match array.data_type() {
            DataType::Utf8 => values.extend(array.as_string::<i32>().iter()),
            DataType::LargeUtf8 => values.extend(array.as_string::<i64>().iter()),
            DataType::Utf8View => values.extend(array.as_string_view().iter()),
            DataType::Dictionary(..) => {
                let dict = array.as_any_dictionary();
                let keys = dict.normalized_keys();
                let words: Vec<Option<&str>> = match dict.values().data_type() {
                    DataType::Utf8 => dict.values().as_string::<i32>().iter().collect(),
                    _ => dict.values().as_string::<i64>().iter().collect(),
                };
                values.extend(keys.iter().enumerate().map(|(i, &k)| {
                    if dict.keys().is_valid(i) {
                        words[k]
                    } else {
                        None
                    }
                }));
            }
            other => unreachable!("read_strings called on {other} for '{name}'"),
        }
    }
    // Utf8 offsets are 32-bit: more text than that would overflow them.
    let bytes: usize = values.iter().flatten().map(|s| s.len()).sum();
    if bytes > i32::MAX as usize {
        return Err(PondError::Unsupported {
            call: FROM,
            message: format!(
                "text column '{name}' holds {bytes} bytes; pond-rs keeps text as Utf8, which holds at most {} bytes per column",
                i32::MAX
            ),
        });
    }
    Ok(StringColumn::from_options(values))
}

/// Append one chunk of a value column to `out` as `f64`, nulls as `NaN`.
fn read_number(array: &ArrayRef, name: &str, out: &mut Vec<f64>) -> Result<()> {
    macro_rules! widen {
        ($t:ty) => {{
            let a = array.as_primitive::<$t>();
            out.extend(a.values().iter().map(|&v| v as f64));
        }};
    }
    if let Some(unit) = time_unit(array.data_type()) {
        return read_time_values(array, name, unit, out);
    }
    let start = out.len();
    match array.data_type() {
        DataType::Float64 => out.extend_from_slice(array.as_primitive::<Float64Type>().values()),
        DataType::Float32 => widen!(Float32Type),
        DataType::Float16 => out.extend(
            array
                .as_primitive::<Float16Type>()
                .values()
                .iter()
                .map(|v| v.to_f64()),
        ),
        // An all-empty column (pyarrow writes one for a column of Nones).
        DataType::Null => out.extend(std::iter::repeat_n(f64::NAN, array.len())),
        // A dictionary of numbers (or times): decode each row's entry.
        // Null keys are marked below; text dictionaries never reach here.
        DataType::Dictionary(..) => {
            let dict = array.as_any_dictionary();
            let mut entries = Vec::new();
            read_number(dict.values(), name, &mut entries)?;
            out.extend(
                dict.normalized_keys()
                    .iter()
                    .map(|&k| entries.get(k).copied().unwrap_or(f64::NAN)),
            );
        }
        DataType::Int8 => widen!(Int8Type),
        DataType::Int16 => widen!(Int16Type),
        DataType::Int32 => widen!(Int32Type),
        DataType::Int64 => widen!(Int64Type),
        DataType::UInt8 => widen!(UInt8Type),
        DataType::UInt16 => widen!(UInt16Type),
        DataType::UInt32 => widen!(UInt32Type),
        DataType::UInt64 => widen!(UInt64Type),
        other => {
            return Err(PondError::Unsupported {
                call: FROM,
                message: format!(
                    "column '{name}' is {other}; pond-rs reads number, time, text and true/false columns only (drop it first with RecordBatch::project)"
                ),
            });
        }
    }
    if let Some(nulls) = array.logical_nulls() {
        // 64 validity bits at a time; only words with a null are walked.
        let slots = &mut out[start..];
        let chunks = nulls.inner().bit_chunks();
        let words = chunks.iter().chain(std::iter::once(
            // the tail: bits past the end read as valid
            chunks.remainder_bits() | (!0u64 << chunks.remainder_len()),
        ));
        for (w, word) in words.enumerate() {
            let mut missing = !word;
            while missing != 0 {
                slots[w * 64 + missing.trailing_zeros() as usize] = f64::NAN;
                missing &= missing - 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::{Int32Array, StringArray, TimestampMicrosecondArray};

    fn sample() -> TimeSeries {
        TimeSeries::new(
            "s",
            vec![0, 1000, 2000],
            vec![
                Column::required("a", vec![1.0, -0.0, 3.5]),
                Column::optional("b", [Some(2.0), None, Some(4.0)]),
            ],
        )
        .unwrap()
    }

    fn bits(c: &crate::Float64Column) -> Vec<Option<u64>> {
        c.iter().map(|v| v.map(f64::to_bits)).collect()
    }

    #[test]
    fn round_trips_through_ipc() {
        let series = sample();
        let mut bytes = Vec::new();
        series.write_ipc(&mut bytes).unwrap();
        let back = TimeSeries::read_ipc("s", std::io::Cursor::new(bytes), "time").unwrap();
        assert_eq!(back.key(), series.key());
        assert_eq!(back.schema(), series.schema());
        for (x, y) in back.columns().iter().zip(series.columns()) {
            assert_eq!(
                bits(x.numbers().unwrap()),
                bits(y.numbers().unwrap()),
                "{}",
                x.name()
            );
        }
    }

    #[test]
    fn writes_gaps_as_nulls_and_interval_keys_flattened() {
        let batch = sample().to_arrow().unwrap();
        assert_eq!(batch.column(2).null_count(), 1);
        assert!(batch.column(2).is_null(1));
        assert!(!batch.schema().field(1).is_nullable());

        let agg = sample()
            .aggregate(
                &crate::Sequence::every("2s").unwrap(),
                &[crate::Agg::of("a", crate::Reducer::Sum)],
            )
            .unwrap();
        let batch = agg.to_arrow().unwrap();
        let names: Vec<_> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();
        assert_eq!(names, ["interval", "intervalEnd", "a", "intervalLabel"]);
    }

    #[test]
    fn reads_units_ints_and_nulls() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("v", DataType::Int32, true),
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Microsecond, None),
                false,
            ),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int32Array::from(vec![Some(7), None])),
                Arc::new(TimestampMicrosecondArray::from(vec![1_000_000, 2_000_000])),
            ],
        )
        .unwrap();
        let series = TimeSeries::from_arrow("x", &[batch.clone(), batch.slice(1, 1)], "ts");
        // the second batch repeats time 2000, which is allowed
        let series = series.unwrap();
        assert_eq!(series.key_name(), "ts");
        assert_eq!(series.key(), &Key::Time(vec![1000, 2000, 2000]));
        let v = series.column("v").unwrap().numbers().unwrap();
        assert_eq!(v.iter().collect::<Vec<_>>(), [Some(7.0), None, None]);
        assert!(!series.schema()[1].required);
    }

    #[test]
    fn nullable_fields_stay_optional_without_nulls() {
        // An optional column with no gaps is still optional after a round
        // trip: the Arrow field's nullability carries it.
        let s = TimeSeries::new(
            "s",
            vec![0, 1],
            vec![
                Column::optional("o", [Some(1.0), Some(2.0)]),
                Column::required("r", vec![1.0, 2.0]),
            ],
        )
        .unwrap();
        let back = TimeSeries::from_arrow("s", &[s.to_arrow().unwrap()], "time").unwrap();
        assert_eq!(back.schema(), s.schema());
        // A non-nullable float field holding NaN is optional (NaN is a gap).
        let b = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("time", DataType::Int64, false),
                Field::new("v", DataType::Float64, false),
            ])),
            vec![
                Arc::new(arrow_array::Int64Array::from(vec![0, 1])),
                Arc::new(arrow_array::Float64Array::from(vec![1.0, f64::NAN])),
            ],
        )
        .unwrap();
        let s = TimeSeries::from_arrow("s", &[b], "time").unwrap();
        assert!(!s.schema()[1].required);
    }

    #[test]
    fn gap_free_float64_is_shared_not_copied() {
        let s =
            TimeSeries::new("s", vec![0, 1], vec![Column::required("v", vec![1.0, 2.0])]).unwrap();
        let batch = s.to_arrow().unwrap();
        let written = batch.column(1).as_primitive::<Float64Type>().values();
        // Writing hands the series' own buffer to Arrow ...
        assert_eq!(
            written.as_ptr(),
            s.column("v").unwrap().numbers().unwrap().values().as_ptr()
        );
        // ... and reading it back points at Arrow's buffer.
        let back = TimeSeries::from_arrow("s", std::slice::from_ref(&batch), "time").unwrap();
        assert_eq!(
            back.column("v")
                .unwrap()
                .numbers()
                .unwrap()
                .values()
                .as_ptr(),
            written.as_ptr()
        );
        // With a gap the values are copied (the null must become NaN).
        let g = TimeSeries::new(
            "g",
            vec![0, 1],
            vec![Column::optional("v", [Some(1.0), None])],
        )
        .unwrap();
        let batch = g.to_arrow().unwrap();
        let back = TimeSeries::from_arrow("g", std::slice::from_ref(&batch), "time").unwrap();
        assert_ne!(
            back.column("v")
                .unwrap()
                .numbers()
                .unwrap()
                .values()
                .as_ptr(),
            batch
                .column(1)
                .as_primitive::<Float64Type>()
                .values()
                .as_ptr()
        );
        assert_eq!(back.column("v").unwrap().numbers().unwrap().get(1), None);
    }

    #[test]
    fn ipc_file_columns_point_into_the_file() {
        let s =
            TimeSeries::new("s", vec![0, 1], vec![Column::required("v", vec![1.0, 2.0])]).unwrap();
        let mut bytes = Vec::new();
        s.write_ipc(&mut bytes).unwrap();
        let file = bytes.as_ptr_range();
        let (start, end) = (file.start as usize, file.end as usize);
        let back = TimeSeries::from_ipc_bytes("s", bytes, "time").unwrap();
        let v = back
            .column("v")
            .unwrap()
            .numbers()
            .unwrap()
            .values()
            .as_ptr() as usize;
        assert!(start <= v && v < end, "column was copied out of the file");
    }

    #[test]
    fn reads_float64_times_when_whole_milliseconds() {
        let read = |times: Vec<f64>| {
            let b = RecordBatch::try_from_iter(vec![(
                "time",
                Arc::new(arrow_array::Float64Array::from(times)) as ArrayRef,
            )])
            .unwrap();
            TimeSeries::from_arrow("x", &[b], "time")
        };
        let s = read(vec![-1000.0, 0.0, 1000.0]).unwrap();
        assert_eq!(s.key(), &Key::Time(vec![-1000, 0, 1000]));
        for bad in [0.5, f64::NAN, f64::INFINITY, 9e15, -9e15] {
            assert!(read(vec![bad]).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_what_it_cannot_read() {
        let ts = |v: Vec<i64>| -> ArrayRef { Arc::new(TimestampMicrosecondArray::from(v)) };
        let batch = |cols: Vec<(&str, ArrayRef)>| RecordBatch::try_from_iter(cols).unwrap();

        // sub-millisecond time
        let b = batch(vec![("time", ts(vec![1500]))]);
        let e = TimeSeries::from_arrow("x", &[b], "time").unwrap_err();
        assert!(e.to_string().contains("sub-millisecond"), "{e}");

        // out of order
        let b = batch(vec![("time", ts(vec![2000, 1000]))]);
        assert!(TimeSeries::from_arrow("x", &[b], "time").is_err());

        // a binary column (bytes, not text)
        let b = batch(vec![
            ("time", ts(vec![1000])),
            (
                "s",
                Arc::new(arrow_array::BinaryArray::from(vec![b"x".as_ref()])) as ArrayRef,
            ),
        ]);
        let e = TimeSeries::from_arrow("x", &[b], "time").unwrap_err();
        assert!(e.to_string().contains("'s'"), "{e}");

        // missing time column, no batches
        let b = batch(vec![("t", ts(vec![1000]))]);
        assert!(TimeSeries::from_arrow("x", &[b], "time").is_err());
        assert!(TimeSeries::from_arrow("x", &[], "time").is_err());
    }

    #[test]
    fn corrupt_ipc_is_an_error_not_a_panic() {
        let mut good = Vec::new();
        sample().write_ipc(&mut good).unwrap();
        // Every single-byte change and every truncation must return Ok or
        // Err; a panic fails the test.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // keep caught panics quiet
        let mut errors = 0;
        for i in 0..good.len() {
            for flip in [0x01u8, 0x80, 0xff] {
                let mut bad = good.clone();
                bad[i] ^= flip;
                errors += usize::from(TimeSeries::from_ipc_bytes("x", bad, "time").is_err());
            }
            errors +=
                usize::from(TimeSeries::from_ipc_bytes("x", good[..i].to_vec(), "time").is_err());
        }
        std::panic::set_hook(prev);
        assert!(errors > 0);
    }

    #[test]
    fn rejects_a_value_column_named_like_a_key_field() {
        let series = sample()
            .aggregate(
                &crate::Sequence::every("2s").unwrap(),
                &[crate::Agg::new("intervalEnd", "a", crate::Reducer::Sum)],
            )
            .unwrap();
        assert!(series.to_arrow().is_err());
    }

    #[test]
    fn reads_range_and_interval_keys() {
        let ts = |v: Vec<i64>| -> ArrayRef {
            Arc::new(TimestampMillisecondArray::from(v).with_timezone("UTC"))
        };
        let batch = |cols: Vec<(&str, ArrayRef)>| RecordBatch::try_from_iter(cols).unwrap();
        let ranges = batch(vec![
            ("span", ts(vec![0, 0])),
            ("spanEnd", ts(vec![1000, 3000])),
            ("v", Arc::new(Float64Array::from(vec![1.0, 2.0]))),
        ]);
        let s = TimeSeries::from_arrow("r", &[ranges], ArrowKey::TimeRange("span".into())).unwrap();
        assert_eq!(
            s.key(),
            &Key::TimeRange(TimeRangeKeys {
                begin: vec![0, 0],
                end: vec![1000, 3000]
            })
        );
        assert_eq!(s.columns().len(), 1, "the end edge is not a value column");
        // Integer labels read as numbers; text labels as text.
        let interval = |label: ArrayRef| {
            batch(vec![
                ("interval", ts(vec![0, 1000])),
                ("intervalEnd", ts(vec![1000, 2000])),
                ("intervalLabel", label),
            ])
        };
        let key = || ArrowKey::Interval("interval".into());
        let s = TimeSeries::from_arrow(
            "i",
            &[interval(Arc::new(Int32Array::from(vec![7, 9])))],
            key(),
        )
        .unwrap();
        let Key::Interval(k) = s.key() else { panic!() };
        assert_eq!(k.label, Labels::Number(vec![7.0, 9.0]));
        let text: ArrayRef = Arc::new(StringArray::from(vec!["mon", "mon"]));
        let s = TimeSeries::from_arrow("i", &[interval(text)], key()).unwrap();
        let Key::Interval(k) = s.key() else { panic!() };
        assert_eq!(k.label, vec!["mon", "mon"].into());

        // A null label (text or number) is an error, and so is no label field.
        for label in [
            Arc::new(StringArray::from(vec![Some("mon"), None])) as ArrayRef,
            Arc::new(Int32Array::from(vec![Some(1), None])) as ArrayRef,
        ] {
            let e = TimeSeries::from_arrow("i", &[interval(label)], key()).unwrap_err();
            assert!(e.to_string().contains("label at row 1"), "{e}");
        }
        let no_label = batch(vec![
            ("interval", ts(vec![0])),
            ("intervalEnd", ts(vec![5])),
        ]);
        let e = TimeSeries::from_arrow("i", &[no_label], key()).unwrap_err();
        assert!(e.to_string().contains("intervalLabel"), "{e}");

        // A missing end, a null end, and an end before its begin.
        let no_end = batch(vec![("timeRange", ts(vec![0]))]);
        let range_key = || ArrowKey::TimeRange("timeRange".into());
        assert!(TimeSeries::from_arrow("r", &[no_end], range_key()).is_err());
        let null_end: ArrayRef =
            Arc::new(TimestampMillisecondArray::from(vec![Some(5), None]).with_timezone("UTC"));
        let b = batch(vec![
            ("timeRange", ts(vec![0, 1])),
            ("timeRangeEnd", null_end),
        ]);
        let e = TimeSeries::from_arrow("r", &[b], range_key()).unwrap_err();
        assert!(e.to_string().contains("timeRangeEnd"), "{e}");
        let b = batch(vec![
            ("timeRange", ts(vec![10])),
            ("timeRangeEnd", ts(vec![5])),
        ]);
        let e = TimeSeries::from_arrow("r", &[b], range_key()).unwrap_err();
        assert!(e.to_string().contains("before it begins"), "{e}");
    }

    #[test]
    fn reads_compressed_streams_and_date_keys() {
        use arrow_array::{Date32Array, DurationSecondArray};
        use arrow_ipc::writer::{IpcWriteOptions, StreamWriter};
        // A zstd-compressed stream written by arrow-rs reads back exactly.
        let batch = sample().to_arrow().unwrap();
        for compression in [
            arrow_ipc::CompressionType::LZ4_FRAME,
            arrow_ipc::CompressionType::ZSTD,
        ] {
            let options = IpcWriteOptions::default()
                .try_with_compression(Some(compression))
                .unwrap();
            let mut bytes = Vec::new();
            let mut w =
                StreamWriter::try_new_with_options(&mut bytes, &batch.schema(), options).unwrap();
            w.write(&batch).unwrap();
            w.finish().unwrap();
            drop(w);
            let back = TimeSeries::from_ipc_bytes("s", bytes, "time").unwrap();
            assert_eq!(back.key(), sample().key(), "{compression:?}");
            assert_eq!(
                bits(back.column("a").unwrap().numbers().unwrap()),
                bits(sample().column("a").unwrap().numbers().unwrap())
            );
        }
        // Neither layout: an error, not a panic.
        let e = TimeSeries::from_ipc_bytes("x", b"hello".to_vec(), "time").unwrap_err();
        assert!(
            e.to_string().contains("not an Arrow IPC file or stream"),
            "{e}"
        );

        // A Date32 key is midnight UTC of each day.
        let b = RecordBatch::try_from_iter([(
            "day",
            Arc::new(Date32Array::from(vec![0, 1, 2])) as ArrayRef,
        )])
        .unwrap();
        let s = TimeSeries::from_arrow("d", &[b], "day").unwrap();
        assert_eq!(s.key().begin(), [0, 86_400_000, 172_800_000]);

        // A time value too large to hold exactly in f64 milliseconds.
        let b = RecordBatch::try_from_iter([
            (
                "time",
                Arc::new(TimestampMillisecondArray::from(vec![0])) as ArrayRef,
            ),
            (
                "v",
                Arc::new(DurationSecondArray::from(vec![i64::MAX / 1000])) as ArrayRef,
            ),
        ])
        .unwrap();
        let e = TimeSeries::from_arrow("x", &[b], "time").unwrap_err();
        assert!(e.to_string().contains("too large"), "{e}");
    }

    #[test]
    fn time_values_read_from_slices_and_several_batches() {
        use arrow_array::{Date32Array, DurationMicrosecondArray};
        let time = |v: Vec<i64>| Arc::new(TimestampMillisecondArray::from(v)) as ArrayRef;
        // The null slot holds i64::MAX, which must be a gap, not a range error.
        let nulls = NullBuffer::from(vec![true, false, true, true]);
        let durations: ArrayRef = Arc::new(DurationMicrosecondArray::new(
            vec![-1_500, i64::MAX, 2_000, 7].into(),
            Some(nulls),
        ));
        let days: ArrayRef = Arc::new(Date32Array::from(vec![Some(1), Some(-1), None, Some(2)]));
        let whole = RecordBatch::try_from_iter([
            ("time", time(vec![0, 1, 2, 3])),
            ("d", durations),
            ("day", days),
        ])
        .unwrap();
        // Two batches that each start mid-buffer.
        let batches = [whole.slice(1, 2), whole.slice(3, 1)];
        let s = TimeSeries::from_arrow("x", &batches, "time").unwrap();
        let col = |s: &TimeSeries, n: &str| -> Vec<Option<f64>> {
            s.column(n).unwrap().numbers().unwrap().iter().collect()
        };
        assert_eq!(col(&s, "d"), [None, Some(2.0), Some(0.007)]);
        assert_eq!(
            col(&s, "day"),
            [Some(-86_400_000.0), None, Some(172_800_000.0)]
        );
        // One batch, cut short.
        let s = TimeSeries::from_arrow("x", &[whole.slice(0, 2)], "time").unwrap();
        assert_eq!(col(&s, "d"), [Some(-1.5), None]);
        assert_eq!(col(&s, "day"), [Some(86_400_000.0), Some(-86_400_000.0)]);
        // Empty bytes say so.
        let e = TimeSeries::from_ipc_bytes("x", vec![], "time").unwrap_err();
        assert!(e.to_string().contains("no bytes"), "{e}");
    }

    #[test]
    fn number_dictionaries_decode_with_gaps_from_keys_and_values() {
        use arrow_array::{DictionaryArray, Int8Array};
        let values = Arc::new(Float64Array::from(vec![Some(2.5), None]));
        let keys = Int8Array::from(vec![Some(0), Some(1), None, Some(0)]);
        let dict: ArrayRef = Arc::new(DictionaryArray::try_new(keys, values).unwrap());
        let b = RecordBatch::try_from_iter([
            (
                "time",
                Arc::new(TimestampMillisecondArray::from(vec![0, 1, 2, 3])) as ArrayRef,
            ),
            ("v", dict),
        ])
        .unwrap();
        let s = TimeSeries::from_arrow("x", &[b], "time").unwrap();
        let v: Vec<_> = s.column("v").unwrap().numbers().unwrap().iter().collect();
        assert_eq!(v, [Some(2.5), None, None, Some(2.5)]);
    }

    #[test]
    fn aggregate_results_round_trip_through_ipc() {
        // Number labels written as Float64 must read back as the same labels.
        let out = sample()
            .aggregate(
                &crate::Sequence::every("2s").unwrap(),
                &[crate::Agg::new("a_sum", "a", crate::Reducer::Sum)],
            )
            .unwrap();
        let mut bytes = Vec::new();
        out.write_ipc(&mut bytes).unwrap();
        let back =
            TimeSeries::from_ipc_bytes("s", bytes, ArrowKey::Interval("interval".into())).unwrap();
        assert_eq!(back.key(), out.key());
        assert_eq!(back.schema(), out.schema());
        assert_eq!(
            bits(back.column("a_sum").unwrap().numbers().unwrap()),
            bits(out.column("a_sum").unwrap().numbers().unwrap())
        );
    }

    #[test]
    fn writes_range_and_interval_keys_as_pond_ts_does() {
        let a = || vec![Column::required("a", vec![1.0, 2.0])];
        let types = |s: &TimeSeries| -> Vec<(String, DataType)> {
            let b = s.to_arrow().unwrap();
            b.schema()
                .fields()
                .iter()
                .map(|f| (f.name().clone(), f.data_type().clone()))
                .collect()
        };
        let ranges = TimeSeries::from_time_ranges(
            "r",
            TimeRangeKeys {
                begin: vec![0, 0],
                end: vec![5, 9],
            },
            a(),
        )
        .unwrap();
        assert_eq!(
            types(&ranges),
            vec![
                ("timeRange".into(), timestamp_ms()),
                ("timeRangeEnd".into(), timestamp_ms()),
                ("a".into(), DataType::Float64),
            ]
        );
        let keys = |label: Labels| IntervalKeys {
            label,
            begin: vec![0, 5],
            end: vec![5, 9],
        };
        let numbered = TimeSeries::from_intervals("i", keys(vec![1.5, 2.0].into()), a()).unwrap();
        assert_eq!(
            types(&numbered)[3],
            ("intervalLabel".into(), DataType::Float64)
        );
        let named = TimeSeries::from_intervals("i", keys(vec!["x", "y"].into()), a()).unwrap();
        assert_eq!(types(&named)[3], ("intervalLabel".into(), DataType::Utf8));
    }

    fn mixed() -> TimeSeries {
        TimeSeries::new(
            "m",
            vec![0, 1000, 2000],
            vec![
                Column::optional("host", [Some("a"), None, Some("")]),
                Column::required("up", vec![true, false, true]),
                Column::optional("ok", [None, Some(false), Some(true)]),
            ],
        )
        .unwrap()
    }

    #[test]
    fn text_and_booleans_round_trip_without_copying() {
        let s = mixed();
        let batch = s.to_arrow().unwrap();
        let types: Vec<_> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| (f.data_type().clone(), f.is_nullable()))
            .collect();
        assert_eq!(
            types[1..],
            [
                (DataType::Utf8, true),
                (DataType::Boolean, false),
                (DataType::Boolean, true)
            ]
        );
        // The text buffer is the series' own.
        let text = |b: &RecordBatch| b.column(1).as_string::<i32>().values().as_ptr();
        assert_eq!(text(&batch), text(&s.to_arrow().unwrap()));
        let back = TimeSeries::from_arrow("m", std::slice::from_ref(&batch), "time").unwrap();
        assert_eq!(back, s);
        assert_eq!(text(&back.to_arrow().unwrap()), text(&batch));

        let mut bytes = Vec::new();
        s.write_ipc(&mut bytes).unwrap();
        assert_eq!(TimeSeries::from_ipc_bytes("m", bytes, "time").unwrap(), s);
    }

    #[test]
    fn reads_every_text_layout_to_the_same_values() {
        use arrow_array::types::Int8Type;
        use arrow_array::{DictionaryArray, LargeStringArray, StringViewArray};
        let want = [Some("x"), None, Some("y"), Some("x")];
        let layouts: Vec<ArrayRef> = vec![
            Arc::new(StringArray::from(want.to_vec())),
            Arc::new(LargeStringArray::from(want.to_vec())),
            Arc::new(StringViewArray::from(want.to_vec())),
            Arc::new(want.iter().copied().collect::<DictionaryArray<Int32Type>>()),
            Arc::new(want.iter().copied().collect::<DictionaryArray<Int8Type>>()),
        ];
        for array in layouts {
            let kind = array.data_type().clone();
            let b = RecordBatch::try_from_iter(vec![
                (
                    "time",
                    Arc::new(arrow_array::Int64Array::from(vec![0, 1, 2, 3])) as ArrayRef,
                ),
                ("s", array),
            ])
            .unwrap();
            for batches in [vec![b.clone()], vec![b.slice(0, 2), b.slice(2, 2)]] {
                let s = TimeSeries::from_arrow("x", &batches, "time").unwrap();
                let col = s.column("s").unwrap().strings().unwrap();
                assert_eq!(col.iter().collect::<Vec<_>>(), want, "{kind}");
                // Only one Dictionary<Int32, Utf8> batch stays a dictionary.
                let stays = batches.len() == 1
                    && kind
                        == DataType::Dictionary(
                            Box::new(DataType::Int32),
                            Box::new(DataType::Utf8),
                        );
                assert_eq!(col.is_dictionary(), stays, "{kind}");
                assert!(!s.schema()[1].required);
            }
        }
    }

    #[test]
    fn a_dictionary_column_is_written_back_as_one() {
        let dict: arrow_array::DictionaryArray<Int32Type> =
            vec!["a", "b", "a"].into_iter().collect();
        let b = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("time", DataType::Int64, false),
                Field::new("s", dict.data_type().clone(), false),
            ])),
            vec![
                Arc::new(arrow_array::Int64Array::from(vec![0, 1, 2])),
                Arc::new(dict),
            ],
        )
        .unwrap();
        let s = TimeSeries::from_arrow("x", &[b], "time").unwrap();
        assert!(s.schema()[1].required);
        let out = s.to_arrow().unwrap();
        assert_eq!(
            out.schema().field(1).data_type(),
            &DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8))
        );
        let mut bytes = Vec::new();
        s.write_ipc(&mut bytes).unwrap();
        assert_eq!(TimeSeries::from_ipc_bytes("x", bytes, "time").unwrap(), s);
        // first / last keep the dictionary (the rows point into the same
        // list of strings).
        let last = s
            .rolling("1s", &[crate::Agg::of("s", crate::Reducer::Last)])
            .unwrap();
        let col = last.column("s").unwrap().strings().unwrap();
        assert!(col.is_dictionary());
        // Equal to the same values held as plain text.
        assert_eq!(
            col,
            &crate::StringColumn::from_options(["a", "b", "a"].map(Some))
        );
        assert_eq!(
            col.iter().collect::<Vec<_>>(),
            [Some("a"), Some("b"), Some("a")]
        );
    }

    /// Text and true/false read from several batches, or a slice of one, go
    /// through `rolling` the same as when built directly.
    #[test]
    fn sliced_and_split_text_rolls_like_direct_text() {
        let host = [Some("a"), None, Some("b"), Some("c"), None, Some("d")];
        let up = [Some(true), Some(false), None, Some(true), None, Some(false)];
        let direct = TimeSeries::new(
            "s",
            (0..6).map(|i| i * 1000).collect(),
            vec![Column::optional("host", host), Column::optional("up", up)],
        )
        .unwrap();
        let aggs = [
            crate::Agg::new("f", "host", crate::Reducer::First),
            crate::Agg::new("l", "up", crate::Reducer::Last),
            crate::Agg::new("n", "host", crate::Reducer::Count),
        ];
        let want = direct.rolling("2s", &aggs).unwrap();
        let batch = direct.to_arrow().unwrap();
        for batches in [
            vec![batch.slice(0, 2), batch.slice(2, 4)],
            vec![batch.slice(0, 1), batch.slice(1, 3), batch.slice(4, 2)],
        ] {
            let back = TimeSeries::from_arrow("s", &batches, "time").unwrap();
            assert_eq!(back.rolling("2s", &aggs).unwrap(), want);
        }
        // One batch that is itself a slice: used in place, offsets kept.
        let tail = TimeSeries::from_arrow("s", &[batch.slice(2, 4)], "time").unwrap();
        assert_eq!(
            tail.column("host")
                .unwrap()
                .strings()
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            host[2..]
        );
        assert_eq!(
            tail.column("up")
                .unwrap()
                .booleans()
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            up[2..]
        );
    }
}
