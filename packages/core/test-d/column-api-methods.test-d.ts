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

const _aat = acol.at(0); // ReadonlyArray<ScalarValue> | undefined
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
