/**
 * Type tests for `ValueSeries` + `TimeSeries.byValue`. These live in `test-d/`
 * (not `test/`) because `tsconfig.types.json` — the CI `test:type` target —
 * compiles `src` + `test-d` only; the runtime `test/` files are never
 * type-checked, so `@ts-expect-error` assertions there are silently inert.
 * (Codex adversarial review, PR #282.)
 */
import { TimeSeries } from '../src/index.js';

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
