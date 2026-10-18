// An Arrow IPC file written by pond-ts the way its docs say to (see
// `toArrow` in src/batch/operators/to-arrow.ts): every field, the time key
// included, as Float64 from pond's own buffers. pond-rs reads it in
// crates/pond-rs/tests/core_parity.rs and must get the `noisy` input back
// exactly, so Rust is checked against real pond-ts output, not just files
// pond-rs or Python wrote.
import {
  Bool,
  Dictionary,
  Float64,
  Int32,
  RecordBatch,
  Schema,
  Table,
  Utf8,
  makeData,
  makeVector,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import { mixedSeries, noisySeries } from './cases.mjs';

export const EXPORT_FILE = 'parity-export.arrow';
export const MIXED_EXPORT_FILE = 'parity-export-mixed.arrow';

/** The IPC bytes; `pond` is the pond-ts module (built or source). */
export function buildArrowExport(pond) {
  const { fields } = noisySeries(pond).toArrow();
  const columns = {};
  for (const f of fields) {
    if (f.type !== 'float64' && f.type !== 'timestamp') throw new Error(f.type);
    columns[f.name] = makeVector(
      makeData({
        type: new Float64(),
        length: f.length,
        nullCount: f.nullCount,
        nullBitmap: f.nullBitmap,
        data: f.values,
      }),
    );
  }
  return tableToIPC(new Table(columns), 'file');
}

// The `mixed` input written the same way, with each field in the Arrow type
// pond-ts's `toArrow` names: the time key and numbers as Float64, text as
// Utf8 or Dictionary<Int32, Utf8> (pond-ts's choice per column), true/false
// as Bool. pond-rs must read back the `mixed` input exactly.
// Arrow fields are nullable by default; a required pond column is written
// as a non-nullable field so the reader can keep it required.
export function buildMixedArrowExport(pond) {
  const series = mixedSeries(pond);
  const { fields } = series.toArrow();
  const optional = new Set(
    series.schema.filter((c) => c.required === false).map((c) => c.name),
  );
  const columns = {};
  for (const f of fields) {
    const base = {
      length: f.length,
      nullCount: f.nullCount,
      nullBitmap: f.nullBitmap,
    };
    switch (f.type) {
      case 'float64':
      case 'timestamp':
        columns[f.name] = makeVector(
          makeData({ type: new Float64(), ...base, data: f.values }),
        );
        break;
      case 'bool':
        columns[f.name] = makeVector(
          makeData({ type: new Bool(), ...base, data: f.values }),
        );
        break;
      case 'utf8':
        columns[f.name] = vectorFromArray(f.values, new Utf8());
        break;
      case 'dictionary':
        columns[f.name] = makeVector(
          makeData({
            type: new Dictionary(new Utf8(), new Int32()),
            ...base,
            data: f.values,
            dictionary: vectorFromArray(f.dictionary, new Utf8()),
          }),
        );
        break;
      default:
        throw new Error(f.type);
    }
  }
  const table = new Table(columns);
  const schema = new Schema(
    table.schema.fields.map((f) => f.clone({ nullable: optional.has(f.name) })),
  );
  return tableToIPC(
    new Table(
      schema,
      table.batches.map((b) => new RecordBatch(schema, b.data)),
    ),
    'file',
  );
}
