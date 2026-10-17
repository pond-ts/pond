//! Arrow in and out: record batches and IPC files.
//!
//! Field naming follows pond-ts `toArrow` / `fromArrow`:
//!
//! - a time key is one field, by default `time`;
//! - an interval key (an `aggregate` result) is `interval` (begin),
//!   `intervalEnd`, the value columns, then `intervalLabel` last.
//!
//! A time-keyed file written by either reads in the other. pond-rs reads
//! time-keyed files only, so an interval-keyed file (pond-rs's own
//! `aggregate` output included) is written but not read back yet; pond-ts
//! reads it with `fromArrow(table, { keyKind: 'interval' })`.
//!
//! pond-rs keys are whole epoch milliseconds. Written keys are
//! `Timestamp(Millisecond, "UTC")`; a gap in a value column is an Arrow null.

use std::io::{Read, Write};
use std::sync::Arc;

use arrow_array::cast::AsArray;
use arrow_array::types::{
    Date64Type, Float32Type, Float64Type, Int8Type, Int16Type, Int32Type, Int64Type,
    TimestampMicrosecondType, TimestampMillisecondType, TimestampNanosecondType,
    TimestampSecondType, UInt8Type, UInt16Type, UInt32Type, UInt64Type,
};
use arrow_array::{Array, ArrayRef, Float64Array, RecordBatch, TimestampMillisecondArray};
use arrow_buffer::{BooleanBuffer, Buffer, NullBuffer};
use arrow_ipc::convert::fb_to_schema;
use arrow_ipc::reader::{FileDecoder, read_footer_length};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema, TimeUnit};

use crate::error::{PondError, Result};
use crate::series::{Column, IntervalKeys, Key, MAX_TIME_MS, TimeSeries};

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
fn decode_ipc_file(bytes: Vec<u8>) -> Result<Vec<RecordBatch>> {
    std::panic::catch_unwind(move || decode_ipc_file_unchecked(bytes)).unwrap_or_else(|_| {
        Err(invalid(
            READ,
            "corrupt Arrow IPC file (arrow's decoder panicked)".into(),
        ))
    })
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

fn invalid(call: &'static str, message: String) -> PondError {
    PondError::InvalidData { call, message }
}

impl TimeSeries {
    /// Build a time-keyed series from Arrow record batches (one table split
    /// into chunks; all batches must share a schema).
    ///
    /// - `time_column` names the key field: a `Timestamp` in any unit,
    ///   `Date64`, or `Int64` or `Float64` epoch milliseconds (`Float64` is
    ///   what pond-ts `toArrow` hands over). It must have no nulls, be in
    ///   order, and convert to whole milliseconds; a micro- or nanosecond
    ///   timestamp with a sub-millisecond part is an error rather than being
    ///   silently rounded.
    /// - Every other field becomes a value column, in field order. Any
    ///   integer or float type is read as `f64`; nulls, `NaN` and infinities
    ///   are gaps. A field Arrow marks nullable becomes an optional column
    ///   (even if it holds no nulls); a non-nullable one becomes required,
    ///   unless it holds `NaN` or infinities, which make it optional.
    /// - Any other field type (strings, lists, …) is an error naming it.
    ///   Drop such fields first with [`RecordBatch::project`].
    ///
    /// The key column keeps its Arrow name.
    pub fn from_arrow(
        name: impl Into<String>,
        batches: &[RecordBatch],
        time_column: &str,
    ) -> Result<Self> {
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
        let mut time = Vec::with_capacity(rows);
        for batch in batches {
            read_time(batch.column(time_index), time_column, time.len(), &mut time)?;
        }

        let mut columns = Vec::with_capacity(schema.fields().len().saturating_sub(1));
        for (c, field) in schema.fields().iter().enumerate() {
            if c == time_index {
                continue;
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
            Key::Time(time),
            columns,
        )
    }

    /// Read a series from an Arrow IPC file (the `.arrow` / Feather v2
    /// format). See [`TimeSeries::from_arrow`] for how fields are read.
    /// Reads the whole file into memory, then as
    /// [`TimeSeries::from_ipc_bytes`].
    pub fn read_ipc(
        name: impl Into<String>,
        mut reader: impl Read,
        time_column: &str,
    ) -> Result<Self> {
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|e| invalid(READ, e.to_string()))?;
        Self::from_ipc_bytes(name, bytes, time_column)
    }

    /// Read a series from the bytes of an Arrow IPC file already in memory
    /// (e.g. from `std::fs::read`). A corrupt file is an error, not a panic,
    /// except on wasm32 (see the module notes in `arrow.rs`). The record batches are views into
    /// `bytes`, not copies; only the conversion into pond columns copies.
    pub fn from_ipc_bytes(
        name: impl Into<String>,
        bytes: Vec<u8>,
        time_column: &str,
    ) -> Result<Self> {
        Self::from_arrow(name, &decode_ipc_file(bytes)?, time_column)
    }

    /// The series as one Arrow record batch. Values are copied.
    ///
    /// Fields: the key (`Timestamp(Millisecond, "UTC")`; an interval key adds
    /// `<key>End` after it and `<key>Label` at the end), then each value
    /// column as `Float64`, nullable unless the column is required, with gaps
    /// as nulls.
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
            Key::Interval(IntervalKeys { label, begin, end }) => {
                push_time(key_name.clone(), begin);
                push_time(format!("{key_name}End"), end);
                Some(label)
            }
        };

        for column in self.columns() {
            let data = column.data();
            let nulls = (!data.all_finite()).then(|| {
                let v = data.values();
                NullBuffer::new(BooleanBuffer::collect_bool(v.len(), |i| v[i].is_finite()))
            });
            fields.push(Field::new(
                column.name(),
                DataType::Float64,
                !column.is_required(),
            ));
            arrays.push(Arc::new(Float64Array::new(
                data.values().to_vec().into(),
                nulls,
            )));
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

fn push_label(fields: &mut Vec<Field>, arrays: &mut Vec<ArrayRef>, name: String, label: &[i64]) {
    fields.push(Field::new(name, timestamp_ms(), false));
    arrays.push(Arc::new(
        TimestampMillisecondArray::from(label.to_vec()).with_timezone("UTC"),
    ));
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
    // (raw values, how many raw units make one millisecond, or how many
    // milliseconds one raw unit is)
    let (raw, per_ms, ms_per): (&[i64], i64, i64) = match array.data_type() {
        DataType::Timestamp(TimeUnit::Second, _) => (
            array.as_primitive::<TimestampSecondType>().values(),
            1,
            1000,
        ),
        DataType::Timestamp(TimeUnit::Millisecond, _) => (
            array.as_primitive::<TimestampMillisecondType>().values(),
            1,
            1,
        ),
        DataType::Timestamp(TimeUnit::Microsecond, _) => (
            array.as_primitive::<TimestampMicrosecondType>().values(),
            1000,
            1,
        ),
        DataType::Timestamp(TimeUnit::Nanosecond, _) => (
            array.as_primitive::<TimestampNanosecondType>().values(),
            1_000_000,
            1,
        ),
        DataType::Date64 => (array.as_primitive::<Date64Type>().values(), 1, 1),
        DataType::Int64 => (array.as_primitive::<Int64Type>().values(), 1, 1),
        other => {
            return Err(invalid(
                FROM,
                format!(
                    "time column '{name}' is {other}; expected a Timestamp, Date64, Int64 or Float64 (epoch ms)"
                ),
            ));
        }
    };
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
}

/// Append one chunk of a value column to `out` as `f64`, nulls as `NaN`.
fn read_number(array: &ArrayRef, name: &str, out: &mut Vec<f64>) -> Result<()> {
    macro_rules! widen {
        ($t:ty) => {{
            let a = array.as_primitive::<$t>();
            out.extend(a.values().iter().map(|&v| v as f64));
        }};
    }
    let start = out.len();
    match array.data_type() {
        DataType::Float64 => out.extend_from_slice(array.as_primitive::<Float64Type>().values()),
        DataType::Float32 => widen!(Float32Type),
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
                    "column '{name}' is {other}; pond-rs reads number columns only (drop it first with RecordBatch::project)"
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
            assert_eq!(bits(x.data()), bits(y.data()), "{}", x.name());
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
        let v = series.column("v").unwrap();
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

        // a string column
        let b = batch(vec![
            ("time", ts(vec![1000])),
            ("s", Arc::new(StringArray::from(vec!["x"])) as ArrayRef),
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
}
