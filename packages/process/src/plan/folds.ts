/**
 * The four folds every consumer wants, as ordinary registry entries.
 *
 * These were a hardcoded `reduce` enum on the selector — a second
 * vocabulary alongside the registry, extensible only by editing this
 * library, absent from every id, and recomputed on every request because
 * the graph's memo stopped one step short of the thing callers read.
 *
 * They are pre-registered by `createRegistry()` because they apply to any
 * numeric series and every consumer wants them, not because they are
 * privileged. Each is a plain {@link FoldDef}: a consumer can `define`
 * over a name to replace one, or add its own beside them.
 *
 * `at` is a function rather than an array on purpose. A fold reports two
 * or three rows out of 150,000, and materializing the key column to
 * answer that was most of what the old reductions cost.
 */

import { int } from './params.js';
import type { FoldContext, FoldDef, Params } from './types.js';

const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * Six decimal places, applied at the boundary rather than in the graph.
 *
 * A column holds full `Float64Array` precision; a fact is read by a
 * person or quoted by a model, and neither wants seventeen digits.
 */
const round = (v: number): number => Math.round(v * 1e6) / 1e6;

const source = [{ role: 'source' }] as const;

export const last: FoldDef = {
  kind: 'fold',
  name: 'last',
  family: 'read',
  summary:
    'The most recent defined value, with its date. The usual way to ask "what is it now?".',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `latest ${inputs}`,
  fold: (ctx) => {
    // The fold that makes [PND-PROCCOL] worth doing: it reads one cell,
    // and on the boxed path it paid to densify all 500,000 first.
    const v = read(ctx);
    for (let i = v.length - 1; i >= 0; i -= 1) {
      if (v.defined(i)) return { value: round(v.value(i)), at: day(ctx.at(i)) };
    }
    return { value: null };
  },
};

export const extremes: FoldDef = {
  kind: 'fold',
  name: 'extremes',
  family: 'read',
  summary:
    'The lowest and highest values over the whole series, each with its date.',
  params: {},
  inputs: source,
  unit: 'inherit',
  label: (_p, inputs) => `range of ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    let lo = Infinity;
    let hi = -Infinity;
    let loAt = -1;
    let hiAt = -1;
    for (let i = 0; i < v.length; i += 1) {
      if (!v.defined(i)) continue;
      const x = v.value(i);
      if (x < lo) {
        lo = x;
        loAt = i;
      }
      if (x > hi) {
        hi = x;
        hiAt = i;
      }
    }
    if (loAt === -1) return { min: null, max: null };
    return {
      min: { value: round(lo), at: day(ctx.at(loAt)) },
      max: { value: round(hi), at: day(ctx.at(hiAt)) },
    };
  },
};

export const percentileRank: FoldDef = {
  kind: 'fold',
  name: 'percentileRank',
  family: 'read',
  summary:
    'Where the latest value sits within the series’ own history, as a 0–1 fraction. Answers "is this unusual?" without needing a second series to compare against.',
  params: {},
  inputs: source,
  // Not the input's unit: a rank is dimensionless, and inheriting made a
  // percentile of an annualised vol report itself as '%/yr'.
  unit: '%ile',
  label: (_p, inputs) => `rank of ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    // One pass, not the three the old reduction took: it densified, then
    // filtered to find the last defined value, then filtered again to
    // count below it.
    let last: number | undefined;
    let seen = 0;
    for (let i = v.length - 1; i >= 0; i -= 1) {
      if (v.defined(i)) {
        last = v.value(i);
        break;
      }
    }
    if (last === undefined) return { value: null };
    let below = 0;
    for (let i = 0; i < v.length; i += 1) {
      if (!v.defined(i)) continue;
      const x = v.value(i);
      seen += 1;
      if (x < last) below += 1;
    }
    const fraction = below / seen;
    return {
      value: round(fraction),
      note: `${Math.round(fraction * 100)}th percentile of ${seen} observations`,
    };
  },
};

export const shape: FoldDef = {
  kind: 'fold',
  name: 'shape',
  family: 'read',
  summary:
    'A bounded sample of the whole series — the honest answer to "show me the series" for a caller paying by the token.',
  // A param rather than a selector field, which is the difference that
  // matters: it lands in the id, so two callers asking for 40 points
  // share one answer instead of computing it twice.
  params: {
    points: int({ min: 2, max: 400, suggest: [20, 120], default: 40 }),
  },
  inputs: source,
  unit: 'inherit',
  label: (p: Params, inputs) => `shape(${String(p['points'])}) of ${inputs}`,
  fold: (ctx) => {
    const v = read(ctx);
    const want = ctx.params['points'] as number;
    const step = Math.max(1, Math.floor(v.length / want));
    const points: [string, number][] = [];
    for (let i = 0; i < v.length; i += step) {
      if (v.defined(i)) points.push([day(ctx.at(i)), round(v.value(i))]);
    }
    return { points: points.length, series: points };
  },
};

/**
 * One reader over the `source` role, columnar where it can be.
 *
 * `ctx.numeric` is a zero-copy view and allocates nothing; `ctx.values`
 * is the boxed fallback for a role that is not packed numeric, and is a
 * lazy getter, so this only pays for densifying when it has to
 * ([PND-PROCCOL]). Both are behind one shape so a fold body reads the
 * same either way — `defined(i)` then `value(i)`, never a cell that
 * might be `undefined`.
 */
function read(ctx: FoldContext): {
  length: number;
  defined(i: number): boolean;
  value(i: number): number;
} {
  const view = ctx.numeric('source');
  if (view !== undefined) {
    const { values } = view;
    return {
      length: view.length,
      defined: (i) => view.defined(i),
      value: (i) => values[i]!,
    };
  }
  const boxed = ctx.values['source']!;
  return {
    length: boxed.length,
    defined: (i) => boxed[i] !== undefined,
    value: (i) => boxed[i]!,
  };
}

/** Registered by `createRegistry()`; nothing stops a consumer replacing one. */
export const STANDARD_FOLDS: readonly FoldDef[] = [
  last,
  extremes,
  percentileRank,
  shape,
];
