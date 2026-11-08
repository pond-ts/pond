/**
 * Summary folds — the facts an agent asks for after "what is it now?".
 *
 * The four standard folds answer *latest*, *range*, *rank* and *shape*.
 * Questions about a whole history need more: an average and a spread
 * (Sharpe), a percentile (value at risk), a share of days (how often up),
 * the last time something happened (a golden cross), a list of dates
 * (every RSI dip), an average conditioned on a signal (the return after
 * that dip). A finance MCP server needs all of them, and none is finance:
 * they read one or two numeric columns and return a few numbers.
 *
 * Not pre-registered — see `basic-ops.ts` for why. Opt in with
 * `for (const fold of SUMMARY_FOLDS) registry = registry.define(fold)`.
 *
 * Conventions, matching pond's own reducers so a fact and an `aggregate`
 * agree: `stdev` is the **population** deviation (divide by n), and
 * `percentile` interpolates linearly between ranks, `q` in 0–100. A
 * **signal** is true where it is defined and non-zero, so a `compare`
 * step's 1/0 output feeds these directly. Every answer carries its
 * `count` of defined rows, because an average of three values and an
 * average of three thousand read the same without it.
 */

import { int, num } from './params.js';
import { read, round, stamp } from './folds.js';
import type { FoldDef, Params } from './types.js';

const source = [{ role: 'source' }] as const;

/**
 * One input as a `Float64Array`, a missing cell `NaN` or ±Infinity — the
 * column's own buffer when it is packed (zero-copy, borrowed for this
 * fold only), a filled copy otherwise.
 *
 * The hot folds below loop over this rather than `read()`'s
 * `defined(i)` / `value(i)` pair: on a signal that is true half the time
 * the branchy form ran `shareTrue` at 22 ms per million rows.
 */
function numbers(
  ctx: Parameters<FoldDef['fold']>[0],
  role: string,
): Float64Array {
  const view = ctx.numeric(role);
  if (view !== undefined) return view.values;
  const boxed = ctx.values[role]!;
  const out = new Float64Array(boxed.length);
  for (let i = 0; i < boxed.length; i += 1) out[i] = boxed[i] ?? NaN;
  return out;
}

/** 0 for a present cell, `NaN` for a missing one (`NaN` or ±Infinity). */
const missing = (x: number): number => x - x;

/** Mean and count of the defined cells, or `null` with none. */
function meanOf(ctx: Parameters<FoldDef['fold']>[0]): {
  mean: number | null;
  count: number;
} {
  const v = read(ctx);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < v.length; i += 1) {
    if (!v.defined(i)) continue;
    sum += v.value(i);
    count += 1;
  }
  return { mean: count === 0 ? null : sum / count, count };
}

export const mean: FoldDef = {
  kind: 'fold',
  name: 'mean',
  family: 'summary',
  summary: 'The average of every defined value, with how many there were.',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `mean of ${inputs}`,
  fold: (ctx) => {
    const { mean: m, count } = meanOf(ctx);
    return { value: m === null ? null : round(m), count };
  },
};

export const stdev: FoldDef = {
  kind: 'fold',
  name: 'stdev',
  family: 'summary',
  summary:
    'The population standard deviation of every defined value (divides by n, as pond’s `stdev` reducer does).',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `stdev of ${inputs}`,
  fold: (ctx) => {
    // Welford, as pond's reducer, so this agrees with `aggregate('stdev')`.
    const v = read(ctx);
    let count = 0;
    let m = 0;
    let m2 = 0;
    for (let i = 0; i < v.length; i += 1) {
      if (!v.defined(i)) continue;
      const x = v.value(i);
      count += 1;
      const d = x - m;
      m += d / count;
      m2 += d * (x - m);
    }
    if (count === 0) return { value: null, count };
    return { value: round(Math.sqrt(Math.max(0, m2) / count)), count };
  },
};

export const sum: FoldDef = {
  kind: 'fold',
  name: 'sum',
  family: 'summary',
  summary: 'The total of every defined value, with how many there were.',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `total of ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    let total = 0;
    let count = 0;
    for (let i = 0; i < v.length; i += 1) {
      if (!v.defined(i)) continue;
      total += v.value(i);
      count += 1;
    }
    return { value: count === 0 ? null : round(total), count };
  },
};

export const count: FoldDef = {
  kind: 'fold',
  name: 'count',
  family: 'summary',
  summary:
    'How many rows hold a value, out of how many rows there are. The gap between the two is missing data or warm-up.',
  params: {},
  inputs: source,
  unit: 'rows',
  label: (_p, inputs) => `count of ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    let defined = 0;
    for (let i = 0; i < v.length; i += 1) if (v.defined(i)) defined += 1;
    return { value: defined, rows: v.length };
  },
};

export const percentile: FoldDef = {
  kind: 'fold',
  name: 'percentile',
  family: 'summary',
  summary:
    'The value below which q percent of the defined values fall (q 5 of daily returns is the one-day 95% value at risk). Linear between ranks.',
  params: {
    q: num({ min: 0, max: 100, suggest: [1, 99], default: 50 }),
  },
  inputs: source,
  unit: 'inherit',
  label: (p: Params, inputs) => `p${String(p['q'])} of ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    // Defined cells straight into a typed buffer: a boxed `number[]` here
    // cost more than the sort itself at 1M rows.
    const buffer = new Float64Array(v.length);
    let n = 0;
    for (let i = 0; i < v.length; i += 1) {
      if (v.defined(i)) buffer[n++] = v.value(i);
    }
    if (n === 0) return { value: null, count: 0 };
    const sorted = buffer.subarray(0, n).sort();
    const rank = ((ctx.params['q'] as number) / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    const value =
      lo === hi
        ? sorted[lo]!
        : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
    return { value: round(value), count: sorted.length };
  },
};

export const shareTrue: FoldDef = {
  kind: 'fold',
  name: 'shareTrue',
  family: 'summary',
  summary:
    'The share of defined rows where a signal is true (non-zero), 0–1. Over a `compare` step it answers "how often was it above…?".',
  params: {},
  inputs: source,
  unit: 'ratio',
  label: (_p, inputs) => `share true of ${inputs}`,
  fold: (ctx) => {
    const v = numbers(ctx, 'source');
    let yes = 0;
    let of = 0;
    for (let i = 0; i < v.length; i += 1) {
      const x = v[i]!;
      // Branch-free: `present` is 1 or 0, and a true cell must be present.
      const present = +(missing(x) === 0);
      of += present;
      yes += present * +(x !== 0);
    }
    return { value: of === 0 ? null : round(yes / of), true: yes, of };
  },
};

export const lastTrue: FoldDef = {
  kind: 'fold',
  name: 'lastTrue',
  family: 'summary',
  summary:
    'When a signal was last true (non-zero), and its value then. Over a crossover column it answers "when was the last golden cross?".',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `last time ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    for (let i = v.length - 1; i >= 0; i -= 1) {
      if (v.defined(i) && v.value(i) !== 0) {
        return { value: round(v.value(i)), at: stamp(ctx.at(i)) };
      }
    }
    return { value: null };
  },
};

export const lastChange: FoldDef = {
  kind: 'fold',
  name: 'lastChange',
  family: 'summary',
  summary:
    'The latest value, when it took that value, and what it was before — "which way is the trend pointing, and since when?". Gaps are skipped, not counted as changes.',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `last change of ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    let i = v.length - 1;
    while (i >= 0 && !v.defined(i)) i -= 1;
    if (i < 0) return { value: null };
    const current = v.value(i);
    let since = i;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (!v.defined(j)) continue;
      if (v.value(j) !== current) {
        return {
          value: round(current),
          since: stamp(ctx.at(since)),
          previous: round(v.value(j)),
        };
      }
      since = j;
    }
    // Never changed: `since` is the first defined row, nothing before it.
    return {
      value: round(current),
      since: stamp(ctx.at(since)),
      previous: null,
    };
  },
};

export const events: FoldDef = {
  kind: 'fold',
  name: 'events',
  family: 'summary',
  summary:
    'The dates where a signal is true (non-zero), oldest first — the most recent `limit` of them, with the total count. Over `compare` it lists every time RSI fell below 30.',
  params: {
    limit: int({ min: 1, max: 400, suggest: [5, 100], default: 50 }),
  },
  inputs: source,
  unit: 'inherit',
  label: (p: Params, inputs) => `dates of ${inputs} (≤${String(p['limit'])})`,
  fold: (ctx) => {
    const v = numbers(ctx, 'source');
    const limit = ctx.params['limit'] as number;
    // Count, then date only the newest `limit`: a token budget for the
    // reader, and no array of every hit on a signal true half the time.
    const isHit = (x: number): boolean => x !== 0 && missing(x) === 0;
    let total = 0;
    for (let i = 0; i < v.length; i += 1) total += +isHit(v[i]!);
    const hits: number[] = [];
    for (let i = v.length - 1; i >= 0 && hits.length < limit; i -= 1) {
      if (isHit(v[i]!)) hits.push(i);
    }
    hits.reverse();
    return {
      count: total,
      shown: hits.length,
      at: hits.map((i) => stamp(ctx.at(i))),
    };
  },
};

export const meanWhere: FoldDef = {
  kind: 'fold',
  name: 'meanWhere',
  family: 'summary',
  summary:
    'The average of `source` over the rows where `when` is true (non-zero) — the average 10-day forward return after RSI fell below 30. Over a 1/0 source it is a hit rate.',
  params: {},
  inputs: [{ role: 'source' }, { role: 'when' }],
  unit: 'inherit',
  label: (_p, inputs) => `mean where: ${inputs}`,
  fold: (ctx) => {
    const v = numbers(ctx, 'source');
    const w = numbers(ctx, 'when');
    let total = 0;
    let count = 0;
    let signals = 0;
    for (let i = 0; i < v.length; i += 1) {
      const c = w[i]!;
      if (c === 0 || missing(c) !== 0) continue;
      signals += 1;
      // A signal whose outcome is missing (a forward return past the end of
      // the data) is counted apart, not averaged in as zero.
      const x = v[i]!;
      if (missing(x) !== 0) continue;
      total += x;
      count += 1;
    }
    return {
      value: count === 0 ? null : round(total / count),
      count,
      signals,
    };
  },
};

export const change: FoldDef = {
  kind: 'fold',
  name: 'change',
  family: 'summary',
  summary:
    'The first and last defined values with their dates, the change between them, and that change in percent — "what was the total return?".',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `change in ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    let first = -1;
    for (let i = 0; i < v.length; i += 1) {
      if (v.defined(i)) {
        first = i;
        break;
      }
    }
    if (first === -1) return { first: null, last: null };
    let last = v.length - 1;
    while (!v.defined(last)) last -= 1;
    const a = v.value(first);
    const b = v.value(last);
    return {
      first: { value: round(a), at: stamp(ctx.at(first)) },
      last: { value: round(b), at: stamp(ctx.at(last)) },
      change: round(b - a),
      percent: a === 0 ? null : round((b / a - 1) * 100),
    };
  },
};

/** Every summary fold, for registering in one loop. */
export const SUMMARY_FOLDS: readonly FoldDef[] = [
  mean,
  stdev,
  sum,
  count,
  percentile,
  shareTrue,
  lastTrue,
  lastChange,
  events,
  meanWhere,
  change,
];
