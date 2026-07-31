/**
 * Type tests for `TimeSeries.toColumns` — the columnar-JSON door out. These
 * live in `test-d/` (not `test/`) because `tsconfig.types.json` — the CI
 * `test:type` target — compiles `src` + `test-d` only; the runtime `test/`
 * files are never type-checked, so `@ts-expect-error` assertions there are
 * silently inert.
 *
 * The whole point of the precise return type is what the first block asserts:
 * `fromColumns(series.toColumns())` type-checks with no cast, and a column
 * kind the ingest engine can't take back makes it *not* type-check.
 */
import { TimeSeries } from '../src/index.js';
import type { SeriesSchema } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'symbol', kind: 'string' },
] as const;

const bars = new TimeSeries({
  name: 'bars',
  schema,
  rows: [[0, 100, 'AAPL']],
});

// --- the envelope is typed per column ---------------------------------------
const out = bars.toColumns();

const name: string = out.name;
void name;
const time: number[] = out.columns.time;
void time;
const close: Array<number | null> = out.columns.close;
void close;
const symbol: Array<string | null> = out.columns.symbol;
void symbol;

// @ts-expect-error — a string column is not number[]
const wrong: number[] = out.columns.symbol;
void wrong;
// @ts-expect-error — 'nope' is not a column on this schema
out.columns.nope;

// The time key is `number[]`, not `Array<number | null>` — it is the index, so
// it is never a gap. (Asserted in the assignable direction: array types are
// covariant in TypeScript, so `number[] → (number | null)[]` would pass and
// prove nothing.)
declare const maybeNulls: Array<number | null>;
// @ts-expect-error — the key column admits no nulls
const nullableTime: typeof out.columns.time = maybeNulls;
void nullableTime;

// The schema rides along as the literal tuple type, not a widened array.
const keyName: 'time' = out.schema[0].name;
void keyName;

// --- the round trip, which is the reason for the precise type ---------------
TimeSeries.fromColumns(bars.toColumns());

// --- boolean / array columns export, but do not come back -------------------
const mixed = new TimeSeries({
  name: 'mixed',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
    { name: 'ok', kind: 'boolean' },
    { name: 'tags', kind: 'array' },
  ] as const,
  rows: [[0, 0.4, true, ['a']]],
});

// They export with their real types — `toColumns` does not pretend otherwise…
const ok: Array<boolean | null> = mixed.toColumns().columns.ok;
void ok;
// …and that honesty is exactly what makes the bad round trip a compile error.
// @ts-expect-error — fromColumns takes number / string value columns only
TimeSeries.fromColumns(mixed.toColumns());

// Selecting down to the ingestable columns restores the round trip.
TimeSeries.fromColumns(mixed.select('cpu').toColumns());

// --- the type parameter is a cascade workaround, not an API ----------------
// `toColumns<T extends S = S>()` exists only to defer instantiation (see the
// method's doc). The default is the whole story: an explicit `T` is UNCHECKED,
// because on a wide `TimeSeries<SeriesSchema>` the `extends S` bound admits
// any schema — so this compiles while describing a column that does not exist
// at runtime. Pinned so the doc's warning stays true rather than aspirational.
declare const wide: TimeSeries<SeriesSchema>;
const fabricated: Array<number | null> =
  wide.toColumns<
    readonly [
      { name: 'time'; kind: 'time' },
      { name: 'notThere'; kind: 'number' },
    ]
  >().columns.notThere;
void fabricated;

// --- flattened two-edged keys ----------------------------------------------
// A two-edged key contributes MORE columns than the schema lists, and the type
// knows their names because a key column's name always equals its kind.
declare const ranged: TimeSeries<
  readonly [
    { name: 'timeRange'; kind: 'timeRange' },
    { name: 'load'; kind: 'number' },
  ]
>;
const rangedColumns = ranged.toColumns().columns;
const begins: number[] = rangedColumns.timeRange;
const ends: number[] = rangedColumns.timeRangeEnd;
void begins;
void ends;
// @ts-expect-error — a timeRange key has no label column
rangedColumns.timeRangeLabel;

declare const bucketed: TimeSeries<
  readonly [
    { name: 'interval'; kind: 'interval' },
    { name: 'load'; kind: 'number' },
  ]
>;
const bucketedColumns = bucketed.toColumns().columns;
// `string[] | number[]`, not `Array<string | number>` — one label type
// throughout is the runtime rule, and the homogeneous form is what stays
// assignable back into the ingest type.
const labels: string[] | number[] = bucketedColumns.intervalLabel;
void labels;
// Asserted in the assignable direction — array covariance means
// `string[] → (string | number)[]` would pass and prove nothing. A mixed
// array is what the type refuses to BE.
declare const mixedLabels: Array<string | number>;
// @ts-expect-error — labels are all-string or all-number, never mixed
const asLabels: typeof bucketedColumns.intervalLabel = mixedLabels;
void asLabels;

// And both round-trip without a cast — the point of teaching `fromColumns`
// the same convention.
TimeSeries.fromColumns(ranged.toColumns());
TimeSeries.fromColumns(bucketed.toColumns());

// A point key gains nothing: `timeEnd` is not a column on a `time`-keyed
// series, however suggestive the name.
// @ts-expect-error — a point key flattens to nothing
out.columns.timeEnd;
