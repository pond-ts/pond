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
    { name: 'ok', kind: 'boolean' },
    { name: 'tags', kind: 'array' },
  ] as const,
  rows: [[0, true, ['a']]],
});

// They export with their real types — `toColumns` does not pretend otherwise…
const ok: Array<boolean | null> = mixed.toColumns().columns.ok;
void ok;
// …and that honesty is exactly what makes the bad round trip a compile error.
// @ts-expect-error — fromColumns takes number / string value columns only
TimeSeries.fromColumns(mixed.toColumns());

// Selecting the unsupported columns out restores the round trip.
TimeSeries.fromColumns(mixed.select().toColumns());
