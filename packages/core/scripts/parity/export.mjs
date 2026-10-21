// An Arrow IPC file written by pond-ts the way its docs say to (see
// `toArrow` in src/batch/operators/to-arrow.ts): every field, the time key
// included, as Float64 from pond's own buffers. pond-rs reads it in
// crates/pond-rs/tests/core_parity.rs and must get the `noisy` input back
// exactly, so Rust is checked against real pond-ts output, not just files
// pond-rs or Python wrote.
import {
  Bool,
  Dictionary,
  Float16,
  Float32,
  Float64,
  Int16,
  Int32,
  Int64,
  RecordBatch,
  Schema,
  Table,
  TimestampMillisecond,
  Uint8,
  Uint32,
  Uint64,
  Utf8,
  makeData,
  makeVector,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import {
  encodeValueSeries,
  labelledSeries,
  mixedSeries,
  noisySeries,
  rangesSeries,
  valueExportSeries,
} from './cases.mjs';

export const EXPORT_FILE = 'parity-export.arrow';

/** [file, input] pairs written by {@link buildTypedArrowExport}. */
export const TYPED_EXPORTS = [
  ['parity-export-mixed.arrow', mixedSeries],
  ['parity-export-ranges.arrow', rangesSeries],
  ['parity-export-labelled.arrow', labelledSeries],
  ['parity-export-value.arrow', valueExportSeries],
];

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

// An input written the same way, with each field in the Arrow type pond-ts's
// `toArrow` names: key edges and numbers as Float64, text as Utf8 or
// Dictionary<Int32, Utf8> (pond-ts's choice per column), true/false as Bool.
// A time-range or interval key is `<key>` + `<key>End` (+ `<key>Label`).
// pond-rs must read back the input exactly. Arrow fields are nullable by
// default; key fields and required pond columns are written non-nullable so
// the reader can keep them required.
export function buildTypedArrowExport(series) {
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

export const VALUE_ARROW_FILE = 'parity-value-arrow.json';

// Arrow tables of many field types, each read by pond-ts
// `ValueSeries.fromArrow(table, { axis })`. pond-rs reads the same bytes
// (`ipc`, hex) and must give the same series, or refuse what pond-ts
// refuses.
export function buildValueArrowCases(pond) {
  const v = (type, values) => vectorFromArray(values, type);
  const table = (columns) => new Table(columns);
  const cases = [
    [
      'int32Axis',
      'x',
      table({
        x: v(new Int32(), [1, 2, 2, 5]),
        y: v(new Float64(), [0.5, null, -0, 3]),
        s: v(new Utf8(), ['a', null, 'b', 'c']),
      }),
    ],
    [
      'int64Axis',
      'x',
      table({
        x: v(new Int64(), [-(2n ** 60n), -1n, 0n, 2n ** 53n + 1n, 2n ** 62n]),
        y: v(new Int16(), [1, 2, null, 4, 5]),
      }),
    ],
    [
      'uint8Axis',
      'x',
      table({ x: v(new Uint8(), [0, 7, 255]), y: v(new Uint32(), [1, 2, 3]) }),
    ],
    [
      'uint64Axis',
      'x',
      table({ x: v(new Uint64(), [1n, 2n ** 63n, 2n ** 64n - 1n]) }),
    ],
    [
      'float32Axis',
      'x',
      table({
        x: v(new Float32(), [0.1, 0.5, 1e30]),
        y: v(new Float32(), [0.2, null, 1]),
      }),
    ],
    ['float16Axis', 'x', table({ x: v(new Float16(), [0.1, 1.5, 2]) })],
    [
      'dictionaryValues',
      'x',
      table({
        x: v(new Float64(), [1, 2, 3]),
        s: v(new Dictionary(new Utf8(), new Int32()), ['a', 'b', 'a']),
      }),
    ],
    ['empty', 'x', table({ x: v(new Float64(), []), y: v(new Float64(), []) })],
    [
      'twoBatches',
      'x',
      table({
        x: v(new Float64(), [1, 2]),
        y: v(new Float64(), [3, null]),
      }).concat(
        table({ x: v(new Float64(), [2, 4]), y: v(new Float64(), [5, 6]) }),
      ),
    ],
    ['nullAxis', 'x', table({ x: v(new Float64(), [1, null, 3]) })],
    // A null whose hidden slot (0) would keep the axis in order.
    ['nullAxisInOrder', 'x', table({ x: v(new Float64(), [0, null, 3]) })],
    ['nanAxis', 'x', table({ x: v(new Float64(), [1, NaN, 3]) })],
    ['infAxis', 'x', table({ x: v(new Float64(), [1, 2, Infinity]) })],
    ['unsorted', 'x', table({ x: v(new Float64(), [1, 3, 2]) })],
    ['textAxis', 'x', table({ x: v(new Utf8(), ['1', '2']) })],
    ['noAxis', 'z', table({ x: v(new Float64(), [1, 2]) })],
    [
      'timestampAxis',
      'x',
      table({ x: v(new TimestampMillisecond(), [1000, 2000]) }),
    ],
    [
      'boolValues',
      'x',
      table({ x: v(new Float64(), [1, 2]), b: v(new Bool(), [true, null]) }),
    ],
  ];
  return cases.map(([id, axis, t]) => {
    const head = {
      id,
      axis,
      ipc: Buffer.from(tableToIPC(t, 'file')).toString('hex'),
    };
    try {
      const vs = pond.ValueSeries.fromArrow(t, { axis, name: 'va' });
      return { ...head, expected: encodeValueSeries(vs) };
    } catch (e) {
      return { ...head, error: { name: e.name, message: e.message } };
    }
  });
}
