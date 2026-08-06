import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  float64ColumnFromArray,
  withColumnReplaced,
} from '../../columnar/index.js';
import type { SeriesSchema } from '../../schema/index.js';
import { NumericOutput, packedNumericSource } from './numeric-io.js';

/**
 * A cumulative accumulator — a built-in name or a custom fold
 * `(acc, value) => next`. Mirrors `TimeSeries.cumulative`'s spec values.
 */
export type CumulativeReducer =
  | 'sum'
  | 'max'
  | 'min'
  | 'count'
  | ((acc: number, value: number) => number);

function buildApply(
  reducer: CumulativeReducer,
): (acc: number | undefined, value: number) => number {
  if (typeof reducer === 'function') {
    return (acc, v) => (acc === undefined ? v : reducer(acc, v));
  }
  switch (reducer) {
    case 'sum':
      return (acc, v) => (acc ?? 0) + v;
    case 'count':
      return (acc) => (acc ?? 0) + 1;
    case 'max':
      return (acc, v) => (acc === undefined || v > acc ? v : acc);
    case 'min':
      return (acc, v) => (acc === undefined || v < acc ? v : acc);
  }
}

/**
 * **Step 4 — column-native `cumulative` (extracted operator).** Running
 * accumulation per target column, computed straight off the columnar store:
 * read each target's cells (storage-agnostic `read(i)`), fold a running
 * accumulator, replace the column — no `series.events` materialization, no
 * per-row `Event`. Non-target columns + the key axis pass through untouched
 * (`withColumnReplaced` references the unchanged columns + keys zero-copy).
 *
 * Matches the row path's semantics exactly: a defined numeric cell updates
 * the accumulator; a missing / undefined cell **carries** the current
 * accumulator (does not reset it), and the output is `undefined` only until
 * the first defined value (`float64ColumnFromArray` derives validity from the
 * `undefined`s). A stored NaN is a defined number — applied, matching the old
 * `typeof raw === 'number'` check.
 *
 * Returns the reshaped store + the output schema (targets widened to optional
 * `number`). The result-schema cast is the single trust boundary; the
 * `TimeSeries.cumulative` method wraps the store via `#fromTrustedStore`.
 *
 * A non-numeric target name is unreachable through the typed surface
 * (`cumulative<Targets extends NumericColumnNameForSchema<S>>`); it can only
 * arrive by defeating that constraint (`(series as any).cumulative(...)`).
 * On such a type-illegal input the all-`undefined` replacement column is
 * `kind: 'number'`, so `withColumnReplaced`'s kind guard throws a `RangeError`
 * naming the column. This is a deliberate improvement over the old events path,
 * which silently overwrote the column with all-`undefined` — fail-fast beats
 * silent corruption on input the type already forbids.
 */
export function cumulativeOp<
  S extends SeriesSchema,
  OutSchema extends SeriesSchema,
>(
  store: ColumnarStore<S>,
  schema: S,
  spec: Readonly<Record<string, CumulativeReducer>>,
): { store: ColumnarStore<OutSchema>; schema: OutSchema } {
  const entries = Object.entries(spec);
  if (entries.length === 0) {
    throw new Error('cumulative() requires at least one column');
  }
  const targetSet = new Set(entries.map(([name]) => name));
  const outSchema = Object.freeze(
    schema.map((col, i) =>
      i === 0 || !targetSet.has(col.name)
        ? col
        : { ...col, kind: 'number' as const, required: false as const },
    ),
  ) as unknown as OutSchema;

  const n = store.length;
  let result = store as unknown as ColumnarStore<ColumnSchema>;
  for (const [name, reducer] of entries) {
    const col: Column = store.columns.get(name)!;
    const apply = buildApply(reducer);

    // Unboxed path — [PND-BOXFREE]. Walks the source's `Float64Array`
    // and validity bits directly and writes into typed output buffers,
    // instead of `read(i)` into a boxed `Array<number | undefined>` that
    // `float64ColumnFromArray` then traverses twice more. Same fold,
    // same carry-over-gaps semantics; see `numeric-io.ts`.
    const packed = packedNumericSource(col);
    if (packed !== null) {
      // Built-ins get a specialised loop rather than going through
      // `buildApply`'s closure. Removing the boxing alone left
      // `cumulative` at 142 ms of its original 166 ms (1.2×) because the
      // per-cell cost was never the box — it was one closure invocation
      // per element. Inlining the fold is what actually moves it. A
      // custom fold still routes through the closure below: that call is
      // the user's own function and cannot be inlined away.
      //
      // Each branch reproduces `buildApply`'s recurrence exactly. The
      // `seen` flag stands in for `acc === undefined`: a missing cell
      // carries the accumulator rather than resetting it, and output
      // stays undefined only until the first defined value —
      // `NumericOutput` leaves unwritten cells undefined, so that
      // prefix needs no explicit write.
      const { values, bits } = packed;
      const out = new NumericOutput(n);
      let acc = 0;
      let seen = false;
      if (reducer === 'sum') {
        for (let i = 0; i < n; i += 1) {
          if (bits === null || (bits[i >> 3]! & (1 << (i & 7))) !== 0) {
            acc += values[i]!;
            seen = true;
          }
          if (seen) out.set(i, acc);
        }
      } else if (reducer === 'count') {
        for (let i = 0; i < n; i += 1) {
          if (bits === null || (bits[i >> 3]! & (1 << (i & 7))) !== 0) {
            acc += 1;
            seen = true;
          }
          if (seen) out.setFinite(i, acc);
        }
      } else if (reducer === 'max') {
        for (let i = 0; i < n; i += 1) {
          if (bits === null || (bits[i >> 3]! & (1 << (i & 7))) !== 0) {
            const v = values[i]!;
            acc = !seen || v > acc ? v : acc;
            seen = true;
          }
          if (seen) out.set(i, acc);
        }
      } else if (reducer === 'min') {
        for (let i = 0; i < n; i += 1) {
          if (bits === null || (bits[i >> 3]! & (1 << (i & 7))) !== 0) {
            const v = values[i]!;
            acc = !seen || v < acc ? v : acc;
            seen = true;
          }
          if (seen) out.set(i, acc);
        }
      } else {
        // Custom fold: the closure is the caller's own function.
        let a: number | undefined;
        for (let i = 0; i < n; i += 1) {
          if (bits === null || (bits[i >> 3]! & (1 << (i & 7))) !== 0)
            a = apply(a, values[i]!);
          if (a !== undefined) out.set(i, a);
        }
      }
      result = withColumnReplaced(result, name, out.finish());
      continue;
    }

    // Fallback for chunked / non-numeric sources: unchanged.
    const out: (number | undefined)[] = new Array(n);
    let acc: number | undefined;
    for (let i = 0; i < n; i += 1) {
      const raw = col.read(i) as number | undefined;
      if (typeof raw === 'number') acc = apply(acc, raw);
      out[i] = acc;
    }
    result = withColumnReplaced(result, name, float64ColumnFromArray(out));
  }
  return {
    store: result as unknown as ColumnarStore<OutSchema>,
    schema: outSchema,
  };
}
