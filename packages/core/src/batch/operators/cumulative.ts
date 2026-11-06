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
  | 'increase'
  | 'decrease'
  | ((acc: number, value: number) => number);

/**
 * `increase` / `decrease` with a threshold: a change counts only once the
 * value has moved at least `threshold` from the last value that counted
 * (in either direction). `threshold: 0`, the default, counts every rise
 * (or every fall) between consecutive values.
 */
export type CumulativeChange = {
  readonly using: 'increase' | 'decrease';
  readonly threshold?: number;
};

/** One column's entry in a `cumulative` spec. */
export type CumulativeAccumulator = CumulativeReducer | CumulativeChange;

/**
 * The running rises (`increase`) or falls (`decrease`) of a column, as a
 * stateful step: feed each defined value, read the running total.
 *
 * The first value sets the reference point and the total starts at 0.
 * After that, `d = value − reference`: when `d >= threshold` the rise `d`
 * is added to the increase total and the reference moves to `value`; when
 * `d <= −threshold` the fall `−d` is added to the decrease total and the
 * reference moves. A smaller change leaves both alone, so slow drift is
 * still counted once it adds up to the threshold. Both directions share
 * one reference point, so `increase − decrease` is always the last
 * reference minus the first value.
 */
export class ChangeFold {
  #ref = NaN;
  #up = 0;
  #down = 0;
  readonly #threshold: number;
  readonly #increase: boolean;

  constructor(direction: 'increase' | 'decrease', threshold: number) {
    this.#increase = direction === 'increase';
    this.#threshold = threshold;
  }

  /** Feed one defined (finite) value; returns the running total. */
  step(v: number): number {
    const ref = this.#ref;
    if (ref !== ref) {
      this.#ref = v;
    } else {
      const d = v - ref;
      if (d >= this.#threshold) {
        this.#up += d;
        this.#ref = v;
      } else if (d <= -this.#threshold) {
        this.#down -= d;
        this.#ref = v;
      }
    }
    return this.#increase ? this.#up : this.#down;
  }
}

/**
 * Normalize a `cumulative` spec value: an `increase` / `decrease` entry
 * (either form) becomes `{ change, threshold }`, anything else is
 * returned as the plain reducer. Throws on an unknown name or a bad
 * threshold.
 */
export function resolveCumulative(
  column: string,
  spec: CumulativeAccumulator,
):
  | { readonly change: 'increase' | 'decrease'; readonly threshold: number }
  | { readonly change: null; readonly reducer: CumulativeReducer } {
  if (spec === 'increase' || spec === 'decrease') {
    return { change: spec, threshold: 0 };
  }
  if (typeof spec === 'object' && spec !== null) {
    const { using, threshold = 0 } = spec;
    if (using !== 'increase' && using !== 'decrease') {
      throw new TypeError(
        `cumulative: column '${column}': { using } takes 'increase' or 'decrease', got ${String(using)}`,
      );
    }
    if (
      typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      threshold < 0
    ) {
      throw new RangeError(
        `cumulative: column '${column}': threshold must be a finite number >= 0, got ${String(threshold)}`,
      );
    }
    return { change: using, threshold };
  }
  if (
    typeof spec !== 'function' &&
    spec !== 'sum' &&
    spec !== 'max' &&
    spec !== 'min' &&
    spec !== 'count'
  ) {
    throw new TypeError(
      `cumulative: column '${column}': unknown accumulator ${JSON.stringify(spec)}`,
    );
  }
  return { change: null, reducer: spec };
}

function buildApply(
  reducer: Exclude<CumulativeReducer, 'increase' | 'decrease'>,
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
 * `undefined`s).
 *
 * **A non-finite result means missing** ([PND-NANREP]). A source column
 * cannot hold a non-finite value, but the fold itself can produce one — a
 * `sum` that overflows to `±Infinity`, or a custom fold returning `NaN` /
 * `Infinity`. Such a row is written as **missing** (`NumericOutput.set` /
 * `float64ColumnFromArray` both drop it). The accumulator itself is not
 * reset: an overflowed `sum` stays `±Infinity` (or `NaN`), so a built-in
 * fold reads missing from that row on, and a custom fold receives the
 * non-finite `acc` and may recover.
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
  spec: Readonly<Record<string, CumulativeAccumulator>>,
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
  for (const [name, entry] of entries) {
    const col: Column = store.columns.get(name)!;
    const resolved = resolveCumulative(name, entry);

    if (resolved.change !== null) {
      // `increase` / `decrease`: one loop over the values (a missing cell
      // is `NaN` — [PND-NANREP]), carrying the total over gaps.
      const packed = packedNumericSource(col);
      const values =
        packed !== null
          ? packed.values
          : Float64Array.from({ length: n }, (_, i) => {
              const raw = col.read(i);
              return typeof raw === 'number' ? raw : NaN;
            });
      const out = new NumericOutput(n);
      const up = resolved.change === 'increase';
      const threshold = resolved.threshold;
      let ref = NaN;
      let total = 0;
      for (let i = 0; i < n; i += 1) {
        const v = values[i]!;
        if (v - v === 0) {
          // Inlined `ChangeFold.step`, keeping only this direction's total.
          if (ref !== ref) ref = v;
          else {
            const d = v - ref;
            if (d >= threshold) {
              if (up) total += d;
              ref = v;
            } else if (d <= -threshold) {
              if (!up) total -= d;
              ref = v;
            }
          }
        }
        if (ref === ref) out.set(i, total);
      }
      result = withColumnReplaced(result, name, out.finish());
      continue;
    }

    const reducer = resolved.reducer as Exclude<
      CumulativeReducer,
      'increase' | 'decrease'
    >;
    const apply = buildApply(reducer);

    // Unboxed path — [PND-BOXFREE]. Walks the source's `Float64Array`
    // directly (a missing cell is `NaN` in it — [PND-NANREP]) and writes into typed output buffers,
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
      const { values } = packed;
      const out = new NumericOutput(n);
      let acc = 0;
      let seen = false;
      if (reducer === 'sum') {
        for (let i = 0; i < n; i += 1) {
          const v = values[i]!;
          if (v - v === 0) {
            acc += v;
            seen = true;
          }
          if (seen) out.set(i, acc);
        }
      } else if (reducer === 'count') {
        for (let i = 0; i < n; i += 1) {
          const v = values[i]!;
          if (v - v === 0) {
            acc += 1;
            seen = true;
          }
          if (seen) out.setFinite(i, acc);
        }
      } else if (reducer === 'max') {
        for (let i = 0; i < n; i += 1) {
          const v = values[i]!;
          if (v - v === 0) {
            acc = !seen || v > acc ? v : acc;
            seen = true;
          }
          if (seen) out.set(i, acc);
        }
      } else if (reducer === 'min') {
        for (let i = 0; i < n; i += 1) {
          const v = values[i]!;
          if (v - v === 0) {
            acc = !seen || v < acc ? v : acc;
            seen = true;
          }
          if (seen) out.set(i, acc);
        }
      } else {
        // Custom fold: the closure is the caller's own function.
        let a: number | undefined;
        for (let i = 0; i < n; i += 1) {
          const v = values[i]!;
          if (v - v === 0) a = apply(a, v);
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
