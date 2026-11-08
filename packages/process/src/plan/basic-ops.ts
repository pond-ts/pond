/**
 * Basic column steps — arithmetic, shifts, comparisons, running totals.
 *
 * Every finance question past "what is RSI now?" needs one of these: a
 * percent distance from an average is a subtract and a divide, a breakout
 * is a shift and a compare, a forward return is a negative shift, a
 * drawdown is a running maximum. Before this file each consumer wrote its
 * own (the process demo carries `delta` and `scale`), so every MCP server
 * built on this package would have re-written the same dozen ops.
 *
 * They are **not** pre-registered by `createRegistry()`: adding names to
 * every registry would change what `describe()` and `toJsonSchema()` hand
 * an existing consumer's model. Opt in with
 * `for (const op of BASIC_OPS) registry = registry.define(op)`.
 *
 * ## Shared rules
 *
 * - A gap in any input is a gap in the output. Nothing is guessed. The
 *   one exception is `hold`, whose job is to carry a value over gaps.
 * - A non-finite result (`1 / 0`) is a gap, because a column cannot hold
 *   one ([PND-PROCCOL] packs non-finite cells as missing).
 * - A **signal** is a number read as true when it is defined and non-zero.
 *   Comparisons write `1` or `0`, so they chain into `and` / `or` and into
 *   the `shareTrue` / `events` / `meanWhere` folds.
 */

import { Float64Column } from 'pond-ts';
import type { Column } from 'pond-ts';
import { columnView } from '../column.js';
import { choice, int, num } from './params.js';
import type { OpContext, OpDef } from './types.js';

/** One input column as a dense `Float64Array`, gaps as `NaN`. */
export function readNumbers(ctx: OpContext, role: string): Float64Array {
  const column = ctx.series.column(ctx.inputs[role]!) as unknown as Column;
  const view = columnView(column);
  if (view !== undefined) return view.values;
  const length = (column as unknown as { length: number }).length;
  const out = new Float64Array(length);
  const read = (column as unknown as { read(i: number): unknown }).read;
  for (let i = 0; i < length; i += 1) {
    const v = read.call(column, i);
    // A boolean column reads as 1/0, as the folds read it — otherwise
    // `compare(flag)` saw every cell as a gap while `shareTrue(flag)` counted it.
    out[i] =
      typeof v === 'number' && Number.isFinite(v)
        ? v
        : typeof v === 'boolean'
          ? +v
          : NaN;
  }
  return out;
}

/**
 * Hands a filled buffer to the graph as a column, without the copy and
 * finite-scan `packColumn` would do on a bare array. A non-finite cell is
 * already a missing one ([PND-NANREP]); `allFinite` stays `false`, which
 * is always correct and only forgoes a reducer fast path.
 */
function seal(out: Float64Array): Float64Column {
  return new Float64Column(out, out.length);
}

const both = [{ role: 'left' }, { role: 'right' }] as const;
const one = [{ role: 'source' }] as const;
const none = (): number => 0;

const TESTS = ['above', 'below', 'atLeast', 'atMost', 'equal'] as const;

type Binary =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'and'
  | 'or'
  | (typeof TESTS)[number];

/**
 * `left ∘ right` per row; a gap on either side is a gap.
 *
 * One loop per case rather than one loop calling a passed-in function:
 * a shared loop sees every op's callback, goes megamorphic, and ran a
 * comparison at 21 ms per million rows against 10 ms for these.
 * Arithmetic needs no gap test — `NaN` propagates through `+ − × ÷` on
 * its own — but a comparison or a logical op must mask, because
 * `NaN > x` is a defined `false`. A missing cell is `NaN` or ±Infinity
 * ([PND-NANREP]).
 */
function binary(ctx: OpContext, how: Binary): Float64Column {
  const a = readNumbers(ctx, 'left');
  const b = readNumbers(ctx, 'right');
  const n = a.length;
  const out = new Float64Array(n);
  // `x - x` is 0 for a finite `x` and `NaN` for `NaN` or ±Infinity (a
  // missing cell), so adding both to a 0/1 result passes it through when
  // both sides are present and turns it into a gap when either is not —
  // with no branch, which matters on real data where a comparison's
  // outcome is a coin flip the CPU cannot predict.
  const mask = (i: number): number => a[i]! - a[i]! + (b[i]! - b[i]!);
  switch (how) {
    case 'add':
      for (let i = 0; i < n; i += 1) out[i] = a[i]! + b[i]!;
      break;
    case 'subtract':
      for (let i = 0; i < n; i += 1) out[i] = a[i]! - b[i]!;
      break;
    case 'multiply':
      for (let i = 0; i < n; i += 1) out[i] = a[i]! * b[i]!;
      break;
    case 'divide':
      for (let i = 0; i < n; i += 1) out[i] = a[i]! / b[i]!;
      break;
    case 'above':
      for (let i = 0; i < n; i += 1) out[i] = +(a[i]! > b[i]!) + mask(i);
      break;
    case 'below':
      for (let i = 0; i < n; i += 1) out[i] = +(a[i]! < b[i]!) + mask(i);
      break;
    case 'atLeast':
      for (let i = 0; i < n; i += 1) out[i] = +(a[i]! >= b[i]!) + mask(i);
      break;
    case 'atMost':
      for (let i = 0; i < n; i += 1) out[i] = +(a[i]! <= b[i]!) + mask(i);
      break;
    case 'equal':
      for (let i = 0; i < n; i += 1) out[i] = +(a[i]! === b[i]!) + mask(i);
      break;
    case 'and':
      for (let i = 0; i < n; i += 1)
        out[i] = +(a[i]! !== 0) * +(b[i]! !== 0) + mask(i);
      break;
    case 'or':
      for (let i = 0; i < n; i += 1)
        out[i] = +(+(a[i]! !== 0) + +(b[i]! !== 0) !== 0) + mask(i);
      break;
  }
  return seal(out);
}

/** `source ∘ value` per row for a comparison; a gap is a gap. */
function against(ctx: OpContext, test: string, value: number): Float64Column {
  const v = readNumbers(ctx, 'source');
  const n = v.length;
  const out = new Float64Array(n);
  switch (test) {
    case 'above':
      for (let i = 0; i < n; i += 1)
        out[i] = +(v[i]! > value) + (v[i]! - v[i]!);
      break;
    case 'below':
      for (let i = 0; i < n; i += 1)
        out[i] = +(v[i]! < value) + (v[i]! - v[i]!);
      break;
    case 'atLeast':
      for (let i = 0; i < n; i += 1)
        out[i] = +(v[i]! >= value) + (v[i]! - v[i]!);
      break;
    case 'atMost':
      for (let i = 0; i < n; i += 1)
        out[i] = +(v[i]! <= value) + (v[i]! - v[i]!);
      break;
    default:
      for (let i = 0; i < n; i += 1)
        out[i] = +(v[i]! === value) + (v[i]! - v[i]!);
  }
  return seal(out);
}

export const add: OpDef = {
  name: 'add',
  family: 'arithmetic',
  summary: 'left + right, row by row. Carries the left input’s unit.',
  params: {},
  inputs: both,
  outputs: [{ id: '', unit: 'inherit' }],
  lookback: none,
  label: (_p, inputs) => `sum of ${inputs}`,
  run: (ctx) => binary(ctx, 'add'),
};

export const subtract: OpDef = {
  name: 'subtract',
  family: 'arithmetic',
  summary:
    'left − right, row by row (a spread, or a price minus its average). Carries the left input’s unit.',
  params: {},
  inputs: both,
  outputs: [{ id: '', unit: 'inherit' }],
  lookback: none,
  label: (_p, inputs) => `difference of ${inputs}`,
  run: (ctx) => binary(ctx, 'subtract'),
};

export const multiply: OpDef = {
  name: 'multiply',
  family: 'arithmetic',
  summary:
    'left × right, row by row (price × volume, or a return × a position). Carries the left input’s unit.',
  params: {},
  inputs: both,
  outputs: [{ id: '', unit: 'inherit' }],
  lookback: none,
  label: (_p, inputs) => `product of ${inputs}`,
  run: (ctx) => binary(ctx, 'multiply'),
};

export const divide: OpDef = {
  name: 'divide',
  family: 'arithmetic',
  summary:
    'left ÷ right, row by row (a pair ratio, or ATR as a share of price). Division by zero is a gap.',
  params: {},
  inputs: both,
  outputs: [{ id: '', unit: 'ratio' }],
  lookback: none,
  label: (_p, inputs) => `ratio of ${inputs}`,
  run: (ctx) => binary(ctx, 'divide'),
};

export const scale: OpDef = {
  name: 'scale',
  family: 'arithmetic',
  summary:
    'source × factor + offset. ×100 turns a ratio into percent; offset −1 turns a ratio into a change; factor √252 annualises a daily figure. Keeps the input’s unit label, which it cannot know the factor changes.',
  params: {
    factor: num({ default: 1, suggest: [-100, 100] }),
    offset: num({ default: 0, suggest: [-100, 100] }),
  },
  inputs: one,
  outputs: [{ id: '', unit: 'inherit' }],
  lookback: none,
  label: (p, inputs) =>
    `${inputs} × ${String(p['factor'])} + ${String(p['offset'])}`,
  run: (ctx) => {
    const v = readNumbers(ctx, 'source');
    const factor = ctx.params['factor'] as number;
    const offset = ctx.params['offset'] as number;
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i += 1) out[i] = v[i]! * factor + offset;
    return seal(out);
  },
};

export const shift: OpDef = {
  name: 'shift',
  family: 'arithmetic',
  summary:
    'Moves values by `periods` rows. Positive reads the past (yesterday’s close is periods 1); negative reads the future (the close 10 bars ahead is periods −10), for asking what happened after a signal.',
  params: {
    periods: int({ min: -5000, max: 5000, suggest: [-20, 20], default: 1 }),
  },
  inputs: one,
  outputs: [{ id: '', unit: 'inherit' }],
  // Only the backward half is history. A negative shift reads rows AFTER
  // each row, which a lookback cannot describe — see the README.
  lookback: (p) => Math.max(0, p['periods'] as number),
  label: (p, inputs) => {
    const n = p['periods'] as number;
    return n >= 0
      ? `${inputs} ${n} rows earlier`
      : `${inputs} ${-n} rows later`;
  },
  run: (ctx) => {
    const v = readNumbers(ctx, 'source');
    const n = ctx.params['periods'] as number;
    const out = new Float64Array(v.length).fill(NaN);
    for (let i = 0; i < v.length; i += 1) {
      const j = i - n;
      if (j >= 0 && j < v.length) out[i] = v[j]!;
    }
    return seal(out);
  },
};

export const compare: OpDef = {
  name: 'compare',
  family: 'logic',
  summary:
    'Tests source against a fixed value: 1 where the test holds, 0 where not (RSI below 30, a change above 2).',
  params: {
    test: choice({ of: TESTS, default: 'above' }),
    value: num({ default: 0 }),
  },
  inputs: one,
  outputs: [{ id: '', unit: 'signal' }],
  lookback: none,
  label: (p, inputs) => `${inputs} ${String(p['test'])} ${String(p['value'])}`,
  run: (ctx) =>
    against(ctx, ctx.params['test'] as string, ctx.params['value'] as number),
};

export const compareColumns: OpDef = {
  name: 'compareColumns',
  family: 'logic',
  summary:
    'Tests left against right, row by row: 1 where the test holds, 0 where not (close above its 200-bar average).',
  params: { test: choice({ of: TESTS, default: 'above' }) },
  inputs: both,
  outputs: [{ id: '', unit: 'signal' }],
  lookback: none,
  label: (p, inputs) => `${String(p['test'])} test of ${inputs}`,
  run: (ctx) => binary(ctx, ctx.params['test'] as Binary),
};

export const and: OpDef = {
  name: 'and',
  family: 'logic',
  summary: '1 where both signals are true (non-zero), 0 where not.',
  params: {},
  inputs: both,
  outputs: [{ id: '', unit: 'signal' }],
  lookback: none,
  label: (_p, inputs) => `all of ${inputs}`,
  run: (ctx) => binary(ctx, 'and'),
};

export const or: OpDef = {
  name: 'or',
  family: 'logic',
  summary: '1 where either signal is true (non-zero), 0 where neither is.',
  params: {},
  inputs: both,
  outputs: [{ id: '', unit: 'signal' }],
  lookback: none,
  label: (_p, inputs) => `any of ${inputs}`,
  run: (ctx) => binary(ctx, 'or'),
};

export const cumulative: OpDef = {
  name: 'cumulative',
  family: 'arithmetic',
  summary:
    'Running total from the first row: sum, product (compounding growth factors), max (the running peak, for drawdowns) or min. A gap row stays a gap and does not reset the total.',
  params: {
    how: choice({ of: ['sum', 'product', 'max', 'min'], default: 'sum' }),
  },
  inputs: one,
  outputs: [{ id: '', unit: 'inherit' }],
  // No finite lookback: every row depends on all rows before it. Left
  // undeclared so `requiredHistory` reports "unknown" instead of a number
  // a caller would slice against.
  label: (p, inputs) => `running ${String(p['how'])} of ${inputs}`,
  run: (ctx) => {
    const v = readNumbers(ctx, 'source');
    const how = ctx.params['how'] as string;
    const step: (acc: number, x: number) => number =
      how === 'product'
        ? (acc, x) => acc * x
        : how === 'max'
          ? (acc, x) => (x > acc ? x : acc)
          : how === 'min'
            ? (acc, x) => (x < acc ? x : acc)
            : (acc, x) => acc + x;
    const out = new Float64Array(v.length);
    let acc = NaN;
    let started = false;
    for (let i = 0; i < v.length; i += 1) {
      const x = v[i]!;
      if (!Number.isFinite(x)) {
        out[i] = NaN;
        continue;
      }
      // `started`, not `isNaN(acc)`: a product that overflows to Infinity
      // and then meets a 0 is NaN, and must stay so rather than restart.
      acc = started ? step(acc, x) : x;
      started = true;
      out[i] = acc;
    }
    return seal(out);
  },
};

export const hold: OpDef = {
  name: 'hold',
  family: 'logic',
  summary:
    'Carries the last non-zero value forward over zeros and gaps — turns a crossover’s +1/−1 events into a position held until the next one. Before the first non-zero value, the input passes through.',
  params: {},
  inputs: one,
  outputs: [{ id: '', unit: 'inherit' }],
  // Unbounded, like `cumulative`: the held value can be arbitrarily old.
  label: (_p, inputs) => `${inputs} held`,
  run: (ctx) => {
    const v = readNumbers(ctx, 'source');
    const out = new Float64Array(v.length);
    let held = NaN;
    for (let i = 0; i < v.length; i += 1) {
      const x = v[i]!;
      if (Number.isFinite(x) && x !== 0) held = x;
      out[i] = Number.isNaN(held) ? x : held;
    }
    return seal(out);
  },
};

/**
 * Every basic step, for registering in one loop:
 *
 * ```ts
 * let registry = createRegistry();
 * for (const op of BASIC_OPS) registry = registry.define(op);
 * ```
 */
export const BASIC_OPS: readonly OpDef[] = [
  add,
  subtract,
  multiply,
  divide,
  scale,
  shift,
  compare,
  compareColumns,
  and,
  or,
  cumulative,
  hold,
];
