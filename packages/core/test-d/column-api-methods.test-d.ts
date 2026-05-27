/**
 * Type tests for Phase 4.7 step 8b — the method-level type
 * contract for the column-API surface (per RFC §7.3 / §7.4).
 *
 * Pins that:
 * - Each method exists on the right kind-narrowed class.
 * - Each method's return type matches the RFC's promised shape.
 * - Kind-inappropriate calls fail to compile (`@ts-expect-error`).
 * - Composition stays narrowed (`col.slice(...).min()` returns the
 *   right type).
 * - `series.column('value').method()` chains compile cleanly.
 *
 * `column-api.test-d.ts` (companion file) covers the symbol-level
 * export contract from step 8a; this file covers the method-level
 * contract from step 8b.
 */

import type {
  ArrayColumn,
  BooleanColumn,
  Float64Column,
  StringColumn,
} from '../src/index.js';
import { TimeSeries } from '../src/index.js';

// Side-effect import to install method augmentations on the class
// prototypes that this test references via the public types.
import '../src/column-api.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
  { name: 'active', kind: 'boolean' },
] as const;

const s = new TimeSeries({ name: 's', schema, rows: [] });

// ─── Float64Column methods exist + return the right types ───────

declare const fcol: Float64Column;

// Scalar reductions — numeric returns
const _min: number | undefined = fcol.min();
void _min;
const _max: number | undefined = fcol.max();
void _max;
const _sum: number = fcol.sum();
void _sum;
const _mean: number | undefined = fcol.mean();
void _mean;
const _stdev: number | undefined = fcol.stdev();
void _stdev;
const _median: number | undefined = fcol.median();
void _median;
const _pct: number | undefined = fcol.percentile(95);
void _pct;
const _count: number = fcol.count();
void _count;

// minMax returns the tuple shape
const _mm: [number, number] | undefined = fcol.minMax();
void _mm;

// Predicates
const _hasMissing: boolean = fcol.hasMissing();
void _hasMissing;
const _nullCount: number = fcol.nullCount();
void _nullCount;

// Position-indexed
const _first: number | undefined = fcol.first();
void _first;
const _last: number | undefined = fcol.last();
void _last;
const _firstDef: number | undefined = fcol.firstDefined();
void _firstDef;
const _lastDef: number | undefined = fcol.lastDefined();
void _lastDef;

// Access
const _at: number | undefined = fcol.at(5);
void _at;

// Slice returns Float64Column (composition stays narrowed)
const _slice: Float64Column = fcol.slice(0, 100);
void _slice;
const _slicedMin: number | undefined = fcol.slice(0, 100).min();
void _slicedMin;

// ─── BooleanColumn methods exist + return the right types ───────

declare const bcol: BooleanColumn;

const _all: boolean = bcol.all();
void _all;
const _any: boolean = bcol.any();
void _any;
const _none: boolean = bcol.none();
void _none;
const _bcount: number = bcol.count();
void _bcount;
const _bat: boolean | undefined = bcol.at(0);
void _bat;
const _bslice: BooleanColumn = bcol.slice(0, 10);
void _bslice;
const _bfirst: boolean | undefined = bcol.first();
void _bfirst;
const _blastDef: boolean | undefined = bcol.lastDefined();
void _blastDef;

// ─── StringColumn methods exist + return the right types ────────

declare const scol: StringColumn;

const _uniq: number = scol.uniqueCount();
void _uniq;
const _sat: string | undefined = scol.at(0);
void _sat;
const _sslice: StringColumn = scol.slice(0, 10);
void _sslice;
const _sfirst: string | undefined = scol.first();
void _sfirst;

// ─── ArrayColumn methods exist + return the right types ─────────

declare const acol: ArrayColumn;

const _aat: ReadonlyArray<unknown> | undefined = acol.at(0);
void _aat;
const _aslice: ArrayColumn = acol.slice(0, 10);
void _aslice;

// ─── Cross-call: series.column(name).method() chains ─────────────

const _seriesMin: number | undefined = s.column('value').min();
void _seriesMin;
const _seriesUniq: number = s.column('host').uniqueCount();
void _seriesUniq;
const _seriesAny: boolean = s.column('active').any();
void _seriesAny;
const _seriesChain: number | undefined = s.column('value').slice(0, 100).mean();
void _seriesChain;
const _seriesMinMax: [number, number] | undefined = s.column('value').minMax();
void _seriesMinMax;

// ─── Negative cases: kind-inappropriate methods don't compile ───

// @ts-expect-error — StringColumn has no min()
s.column('host').min();

// @ts-expect-error — Float64Column has no uniqueCount()
s.column('value').uniqueCount();

// @ts-expect-error — BooleanColumn has no percentile()
s.column('active').percentile(50);

// @ts-expect-error — StringColumn has no minMax() (numeric-only)
s.column('host').minMax();

// @ts-expect-error — Float64Column has no all()
s.column('value').all();

// @ts-expect-error — BooleanColumn has no median()
s.column('active').median();

// ArrayColumn keeps a deliberately minimal v1 surface; count()
// may land in 8f if a use case earns it.
declare const ac: ArrayColumn;
// @ts-expect-error — ArrayColumn has no count() in current scope
ac.count();

// ─── Schema-narrowed column() — RFC §7.2 negative cases ─────────
//
// The headline narrowing claim from RFC §7.2: typos and key-column
// names fail to compile rather than silently returning `undefined`
// at runtime. These tests pin that contract.

// @ts-expect-error — 'cpu' is not a value column in this schema
s.column('cpu');

// @ts-expect-error — typo on the real 'value' column
s.column('valuue');

// @ts-expect-error — 'time' is the key column; use keyColumn() instead
s.column('time');

// StringColumn.values is ReadonlyArray<string> | Uint32Array, NOT
// Float64Array — Float64Array is only on numeric kinds.
// @ts-expect-error — StringColumn.values isn't a Float64Array
const _stringValuesAsFloat: Float64Array = s.column('host').values;
void _stringValuesAsFloat;

// ─── bin — output type narrows on reducer name ─────────

// Scalar reducers all return Float64Array.
const _binMin: Float64Array = fcol.bin(100, 'min');
const _binMax: Float64Array = fcol.bin(100, 'max');
const _binSum: Float64Array = fcol.bin(100, 'sum');
const _binMean: Float64Array = fcol.bin(100, 'mean');
const _binStdev: Float64Array = fcol.bin(100, 'stdev');
const _binMedian: Float64Array = fcol.bin(100, 'median');
const _binCount: Float64Array = fcol.bin(100, 'count');
const _binP95: Float64Array = fcol.bin(100, 'p95');
const _binP999: Float64Array = fcol.bin(100, 'p99.9');
void _binMin;
void _binMax;
void _binSum;
void _binMean;
void _binStdev;
void _binMedian;
void _binCount;
void _binP95;
void _binP999;

// 'minMax' narrows to the two-channel shape.
const _binMinMax: { lo: Float64Array; hi: Float64Array } = fcol.bin(
  100,
  'minMax',
);
void _binMinMax;
const _binLo: Float64Array = _binMinMax.lo;
const _binHi: Float64Array = _binMinMax.hi;
void _binLo;
void _binHi;

// Cross-call: series.column('value').bin(...) chains.
const _chartBins: { lo: Float64Array; hi: Float64Array } = s
  .column('value')
  .bin(800, 'minMax');
void _chartBins;

// Slice then bin still narrows correctly.
const _slicedBins: Float64Array = s
  .column('value')
  .slice(0, 1000)
  .bin(100, 'mean');
void _slicedBins;

// @ts-expect-error — unknown reducer name
fcol.bin(100, 'cpu');

// @ts-expect-error — invalid percentile prefix (not pNN)
fcol.bin(100, 'xyz');

// bin isn't on StringColumn / BooleanColumn / ArrayColumn
// (no declare-module augmentation in column-api.ts), so the call
// fails with "Property 'bin' does not exist." The
// inaccessibility comes from the missing augmentation, not from
// any narrowing on the binned signature itself — if v1 adds
// bin to other kinds (per RFC §11 step 6), these expect-
// error directives will become unused and the test:type CI step
// will flag them as a heads-up to refresh this section.

// @ts-expect-error — StringColumn has no bin in v1
s.column('host').bin(100, 'count');
// @ts-expect-error — BooleanColumn has no bin in v1
s.column('active').bin(100, 'count');

// ─── KeyColumn — schema-narrowed return + at / slice (step 8d) ──

import type {
  IntervalKeyColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
} from '../src/index.js';

// time-keyed schema → series.keyColumn() narrows to TimeKeyColumn.
// .at(i) returns `number | undefined` (raw begin timestamp).
const _kt: TimeKeyColumn = s.keyColumn();
void _kt;
const _ktAt: number | undefined = s.keyColumn().at(0);
void _ktAt;
const _ktSlice: TimeKeyColumn = s.keyColumn().slice(0, 10);
void _ktSlice;
// Chained: slice then at, the hover/tooltip pattern.
const _ktChain: number | undefined = s.keyColumn().slice(0, 10).at(5);
void _ktChain;

// timeRange-keyed schema → series.keyColumn() narrows to
// TimeRangeKeyColumn. .at(i) returns `{ begin, end } | undefined`.
const sTimeRange = new TimeSeries({
  name: 'tr',
  schema: [
    { name: 'timeRange', kind: 'timeRange' },
    { name: 'load', kind: 'number' },
  ] as const,
  rows: [],
});
const _ktr: TimeRangeKeyColumn = sTimeRange.keyColumn();
void _ktr;
const _ktrAt: { readonly begin: number; readonly end: number } | undefined =
  sTimeRange.keyColumn().at(0);
void _ktrAt;
const _ktrSlice: TimeRangeKeyColumn = sTimeRange.keyColumn().slice(0, 10);
void _ktrSlice;

// interval-keyed schema → series.keyColumn() narrows to
// IntervalKeyColumn. .at(i) returns `{ begin, end, label } |
// undefined` where label is `string | number`.
const sInterval = new TimeSeries({
  name: 'iv',
  schema: [
    { name: 'interval', kind: 'interval' },
    { name: 'level', kind: 'number' },
  ] as const,
  rows: [],
});
const _kiv: IntervalKeyColumn = sInterval.keyColumn();
void _kiv;
const _kivAt:
  | {
      readonly begin: number;
      readonly end: number;
      readonly label: string | number;
    }
  | undefined = sInterval.keyColumn().at(0);
void _kivAt;
const _kivSlice: IntervalKeyColumn = sInterval.keyColumn().slice(0, 10);
void _kivSlice;

// Negative case: TimeKeyColumn.at returns a number, not an object
// with .begin — that shape is for range/interval keys only.
// @ts-expect-error — number has no .begin
const _ktAtBegin: number = s.keyColumn().at(0)?.begin;
void _ktAtBegin;

// Negative case: the slice return type narrows on the variant —
// can't assign IntervalKeyColumn to a TimeKeyColumn binding.
// @ts-expect-error — IntervalKeyColumn isn't a TimeKeyColumn
const _wrongSliceType: TimeKeyColumn = sInterval.keyColumn().slice(0, 10);
void _wrongSliceType;

// Codex finding: KeyColumnForSchema must distribute over a broad
// schema's first-column kind union. For `TimeSeries<SeriesSchema>`
// where `S[0]['kind']` is the full union, `keyColumn()` should
// return the full key-column union — NOT collapse to `never`.
import type { SeriesSchema } from '../src/schema/index.js';
declare const sBroad: TimeSeries<SeriesSchema>;
const _kBroad: TimeKeyColumn | TimeRangeKeyColumn | IntervalKeyColumn =
  sBroad.keyColumn();
void _kBroad;
