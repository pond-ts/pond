/**
 * Type-level contract for the Arrow ingest surface. This file IS type-checked
 * in CI (`tsconfig.types` includes `test-d`), unlike `test/`, so it guards the
 * structural-assignability promise `fromArrow` rests on: a value shaped like a
 * real `apache-arrow` `Table` / `Vector` must satisfy `ArrowTableLike` /
 * `ArrowVectorLike` — including a `Utf8` vector whose `get()` returns `string`.
 * (Regression guard: `get`'s return type once excluded `string`, which would
 * have rejected a real Utf8 vector.)
 */

import type {
  ArrowTableLike,
  ArrowVectorLike,
  ArrowFieldLike,
  FromArrowOptions,
} from '../src/index.js';
import { TimeSeries } from '../src/index.js';

// A Float64-style numeric vector.
const f64Vec: ArrowVectorLike = {
  length: 3,
  nullCount: 0,
  toArray: () => new Float64Array([1, 2, 3]),
  get: (i: number): number | null => (i < 3 ? 1 : null),
};

// A Utf8-style vector: toArray() yields a plain string[], get() returns string.
// This is the shape a real apache-arrow Utf8 Vector presents; it must be
// assignable to ArrowVectorLike (the string in `get`'s return is the point).
const utf8Vec: ArrowVectorLike = {
  length: 2,
  nullCount: 1,
  toArray: () => ['a', null],
  get: (i: number): string | null => (i === 0 ? 'a' : null),
};

// An int64-style vector (BigInt64Array-backed).
const i64Vec: ArrowVectorLike = {
  length: 1,
  nullCount: 0,
  toArray: () => new BigInt64Array([1n]),
  get: (i: number): bigint | null => (i === 0 ? 1n : null),
};

// A field carries name + a type bag with optional typeId/unit.
const field: ArrowFieldLike = {
  name: 'time',
  type: { typeId: 10, unit: 1 },
};

// A table: numRows + schema.fields + getChild.
const table: ArrowTableLike = {
  numRows: 3,
  schema: { fields: [field] },
  getChild: (name: string): ArrowVectorLike | null =>
    name === 'time' ? f64Vec : null,
};

// The whole surface flows through fromArrow, typed as TimeSeries<S>.
const opts: FromArrowOptions = { time: 'time', timeUnit: 'millisecond' };
const series = TimeSeries.fromArrow(table, opts);
// Return type is a TimeSeries; `.length` is a number.
const _len: number = series.length;

// ── The load-bearing check: a REAL apache-arrow Table satisfies the
// structural interface, so `bring your own arrow` type-checks for consumers.
import { Table, vectorFromArray, Float64, Utf8 } from 'apache-arrow';

const realTable = new Table({
  time: vectorFromArray([0, 1000, 2000], new Float64()),
  price: vectorFromArray([1, 2, 3], new Float64()),
  symbol: vectorFromArray(['a', 'b', 'c'], new Utf8()),
});
// If this assignment stops compiling, a real Table no longer satisfies
// ArrowTableLike — the whole `bring your own arrow` premise would be broken.
const asStructural: ArrowTableLike = realTable;
const realSeries = TimeSeries.fromArrow(realTable, { time: 'time' });

// Silence unused-local noise while keeping the assignability checks above.
void utf8Vec;
void i64Vec;
void _len;
void asStructural;
void realSeries;
