/**
 * Type tests for `ValueSeries` + `TimeSeries.byValue`. These live in `test-d/`
 * (not `test/`) because `tsconfig.types.json` — the CI `test:type` target —
 * compiles `src` + `test-d` only; the runtime `test/` files are never
 * type-checked, so `@ts-expect-error` assertions there are silently inert.
 * (Codex adversarial review, PR #282.)
 */
import { TimeSeries, ValueSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cumDist', kind: 'number' },
  { name: 'hr', kind: 'number' },
  { name: 'ele', kind: 'number' },
] as const;

const track = new TimeSeries({
  name: 'ride',
  schema,
  rows: [[0, 0, 120, 100]],
});

// --- literal axis: the common path -----------------------------------------
const vs = track.byValue('cumDist');

// axisName is the literal axis name, not an arbitrary string.
const axisName: 'cumDist' = vs.axisName;
void axisName;
// @ts-expect-error — axisName is 'cumDist', not 'hr'
const wrongAxisName: 'hr' = vs.axisName;
void wrongAxisName;

// Surviving value columns are accessible…
vs.column('hr');
vs.column('ele');
// @ts-expect-error — the axis is the key now; dropped from the value columns
vs.column('cumDist');
// @ts-expect-error — not a column at all
vs.column('nope');

// --- gating: calendar / aggregate ops are type-impossible ------------------
// @ts-expect-error — ValueSeries has no aggregate (calendar op)
vs.aggregate;
// @ts-expect-error — ValueSeries has no byColumn (value-axis aggregation is a TimeSeries op)
vs.byColumn;
// @ts-expect-error — ValueSeries has no cumulative
vs.cumulative;
// @ts-expect-error — ValueSeries has no scan
vs.scan;
// @ts-expect-error — ValueSeries cannot re-project (no byValue)
vs.byValue;

// --- union axis: the return DISTRIBUTES (Codex #282) -----------------------
// A generic wrapper that passes a union-typed axis must get a discriminated
// union `ValueSeries<…cumDist> | ValueSeries<…hr>`, NOT one ValueSeries whose
// value columns have *both* possible axes dropped.
declare const unionAxis: 'cumDist' | 'hr';
const uvs = track.byValue(unionAxis);

if (uvs.axisName === 'cumDist') {
  // axis is cumDist → hr + ele remain value columns (not over-dropped).
  uvs.column('hr');
  uvs.column('ele');
  // @ts-expect-error — cumDist is the axis in this branch
  uvs.column('cumDist');
} else {
  // axis is hr → cumDist + ele remain value columns.
  uvs.column('cumDist');
  uvs.column('ele');
  // @ts-expect-error — hr is the axis in this branch
  uvs.column('hr');
}

// --- ingest / export doors -------------------------------------------------
const chainSchema = [
  { name: 'strike', kind: 'value' },
  { name: 'iv', kind: 'number' },
  { name: 'venue', kind: 'string' },
] as const;

const chain = ValueSeries.fromJSON({
  name: 'chain',
  schema: chainSchema,
  rows: [[90, 0.31, 'cme']],
});

// Row cells are typed per column: axis number, then the declared kinds.
const [strike, iv, venue] = chain.toRows()[0]!;
const strikeNum: number = strike;
const ivMaybe: number | undefined = iv;
const venueMaybe: string | undefined = venue;
void strikeNum;
void ivMaybe;
void venueMaybe;
// @ts-expect-error — the axis is a number, not a string
const strikeStr: string = chain.toRows()[0]![0];
void strikeStr;

// Object rows are keyed by column name.
const objectRow = chain.toObjects()[0]!;
const objIv: number | undefined = objectRow.iv;
void objIv;
// @ts-expect-error — 'nope' is not a column
objectRow.nope;

// toJSON narrows on rowFormat: tuples by default…
const jsonArray = chain.toJSON();
const firstTuple: readonly [number, number | null, string | null] =
  jsonArray.rows[0]!;
void firstTuple;
// …objects when asked.
const jsonObjects = chain.toJSON({ rowFormat: 'object' });
const objectVenue: string | null = jsonObjects.rows[0]!.venue;
void objectVenue;
// @ts-expect-error — the object form has no tuple indexing
jsonObjects.rows[0]![0];

// Columnar JSON is typed per column, and feeds straight back in.
const columnar = chain.toColumns();
const strikes: number[] = columnar.columns.strike;
const ivs: Array<number | null> = columnar.columns.iv;
void strikes;
void ivs;
// @ts-expect-error — a string column is not number[]
const venues: number[] = columnar.columns.venue;
void venues;

// The round trips type-check with no cast — that assignability IS the contract.
ValueSeries.fromColumns(chain.toColumns());
ValueSeries.fromJSON(chain.toJSON());
ValueSeries.fromJSON(chain.toJSON({ rowFormat: 'object' }));

// A projected series carrying a boolean column exports fine, but is NOT
// ingestable by fromColumns — the asymmetry is caught at compile time.
const withBool = new TimeSeries({
  name: 'ride',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cumDist', kind: 'number' },
    { name: 'moving', kind: 'boolean' },
  ] as const,
  rows: [[0, 0, false]],
}).byValue('cumDist');
const boolColumn: Array<boolean | null> = withBool.toColumns().columns.moving;
void boolColumn;
// @ts-expect-error — fromColumns takes number / string columns only
ValueSeries.fromColumns(withBool.toColumns());

// The ROW leg is the other way round, and this line is the assertion of that:
// `toJSON` types its boolean cells honestly (it really does emit them), so the
// payload is assignable and this **compiles** — the ingest engine then throws,
// naming the column (pinned in `test/ValueSeries.rows.test.ts`). A
// `@ts-expect-error` here would be the bug: it would fail this type test.
ValueSeries.fromJSON(withBool.toJSON());

// fromArrow requires the axis to be named — there is no 'time' convention.
declare const table: Parameters<typeof ValueSeries.fromArrow>[0];
ValueSeries.fromArrow(table, { axis: 'strike' });
// @ts-expect-error — `axis` is required
ValueSeries.fromArrow(table, {});
// @ts-expect-error — `timeUnit` is a time-door option; an axis has no unit
ValueSeries.fromArrow(table, { axis: 'strike', timeUnit: 'second' });
