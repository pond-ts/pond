import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';
import { bucketStateFor, rollingStateFor } from '../src/reducers/index.js';

/**
 * Standing differential-fuzz parity suite — the drift-defense capstone.
 *
 * Every silent correctness bug this project's audits have surfaced was the
 * same shape: one reducer execution path quietly disagreeing with another on
 * the same data. `aggregate('stdev')` fast-path vs row-path (audit §1.1);
 * `min`/`max` returning a position-dependent extreme on `reduce` vs the true
 * extreme on `bucketState` (the non-finite-policy survey); rolling-`stdev`
 * one-pass cancelling on large values where the bucket path didn't (#222).
 *
 * The per-operator tests pin FIXED shapes; what they miss is *randomized*
 * distributions — large magnitudes, sliding windows, edge-case sizes — which is
 * exactly where each of those bugs lived. This suite fuzzes those:
 *   1. cross-path agreement — `aggregate` (reduceColumn) vs `bucketState` vs
 *      `rollingState` (full window) must agree on every fuzzed multiset;
 *   2. FIFO sliding vs recompute — `rollingState`'s incremental add/remove must
 *      match a from-scratch reference over the current window, on large-offset
 *      trending streams (the §1.1 / #222 failure shape).
 *
 * Seeded RNG (mulberry32) so any failure reproduces from the printed trial.
 */

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rand: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rand() * (hi - lo + 1));

// A fuzzed finite-number multiset: random size (incl. 0 and 1) and a random
// magnitude regime, so both small-int and large-magnitude buckets get hit.
function genMultiset(rand: () => number): number[] {
  const size = randInt(rand, 0, 40);
  const regime = randInt(rand, 0, 3);
  const base = [0, 0, 1e6, 1e10][regime]!;
  const spread = [10, 1000, 1000, 100][regime]!;
  const dupHeavy = rand() < 0.25; // collapse the value space to force ties
  const out: number[] = [];
  for (let i = 0; i < size; i += 1) {
    let v = base + (rand() * 2 - 1) * spread;
    if (dupHeavy) v = base + randInt(rand, 0, 2) * spread;
    out.push(v);
  }
  return out;
}

// Naive references (independent oracles where the definition is unambiguous).
const refSum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const refMin = (xs: number[]): number => Math.min(...xs);
const refMax = (xs: number[]): number => Math.max(...xs);
const refAvg = (xs: number[]): number => refSum(xs) / xs.length;
// Welford from scratch — accurate at large magnitude (deviation space), and
// independent of the impl's incremental *delete* (it only ever adds), so it is
// a valid oracle for delete drift.
function refStdev(xs: number[]): number {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (const v of xs) {
    n += 1;
    const d = v - mean;
    mean += d / n;
    m2 += d * (v - mean);
  }
  return n === 0 ? NaN : Math.sqrt(m2 / n);
}

// All built-in numeric reducers (median/pNN included in cross-path; excluded
// from the sliding test — they buffer + sort each snapshot, no incremental
// accumulator to drift).
const ALL = [
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'stdev',
  'median',
  'p25',
  'p95',
] as const;
// Only selection/integer reducers are bit-exact across paths. `sum`/`avg` are
// FP accumulations — different summation order (and the sliding path's running
// add/subtract) drift in the last ULP at large magnitude, which is expected,
// not drift worth failing on — so they take the relative tolerance below.
const EXACT = new Set(['count', 'min', 'max']);

// --- path invokers --------------------------------------------------------

// aggregate the whole multiset into one bucket (the columnar reduceColumn fast
// path — one call covers every reducer).
function viaAggregate(vals: number[]): Map<string, unknown> {
  const rows = vals.map((v, i) => [i * 1000, v] as const);
  const s = new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const,
    rows: rows as Array<readonly [number, number]>,
  });
  const mapping: Record<string, { from: 'value'; using: string }> = {};
  for (const name of ALL) mapping[name] = { from: 'value', using: name };
  const out = s.aggregate(Sequence.every('1h'), mapping as never);
  const result = new Map<string, unknown>();
  const row = out.length === 0 ? undefined : out.at(0);
  for (const name of ALL) result.set(name, row?.get(name as never));
  return result;
}

const viaBucket = (vals: number[], name: string): unknown => {
  const st = bucketStateFor(name);
  for (const v of vals) st.add(v);
  return st.snapshot();
};

const viaRollingFull = (vals: number[], name: string): unknown => {
  const st = rollingStateFor(name);
  vals.forEach((v, i) => st.add(i, v));
  return st.snapshot();
};

// --- agreement assertion --------------------------------------------------

function agree(
  name: string,
  a: unknown,
  b: unknown,
  ctx: string,
  relTol = 1e-9,
  absTol = 0,
): void {
  if (a === undefined || b === undefined) {
    expect(a, `${name} ${ctx}`).toBe(b);
    return;
  }
  const x = a as number;
  const y = b as number;
  if (EXACT.has(name)) {
    expect(x, `${name} ${ctx}`).toBe(y);
  } else {
    // relative tolerance — generous enough for method differences (e.g. avg's
    // Σ/n vs a running mean) — plus an optional absolute floor for the
    // unresolvable-precision floor at large magnitude (set by the caller).
    const tol = Math.max(Math.abs(x), Math.abs(y), 1) * relTol + absTol;
    expect(
      Math.abs(x - y),
      `${name} ${ctx} (a=${x} b=${y})`,
    ).toBeLessThanOrEqual(tol);
  }
}

describe('reducer parity — fuzzed cross-path agreement', () => {
  it('aggregate / bucketState / rollingState agree on 400 fuzzed multisets', () => {
    const rand = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 400; trial += 1) {
      const vals = genMultiset(rand);
      // An empty *series* has no bucket at all (aggregate → no row), distinct
      // from an empty *bucket* (bucketState → the reducer's empty value), so
      // only cross-check the columnar fast path when a bucket exists.
      const agg = vals.length > 0 ? viaAggregate(vals) : undefined;
      for (const name of ALL) {
        const b = viaBucket(vals, name);
        const c = viaRollingFull(vals, name);
        agree(name, b, c, `trial=${trial} bucket-vs-rolling n=${vals.length}`);
        if (agg)
          agree(
            name,
            agg.get(name),
            b,
            `trial=${trial} aggregate-vs-bucket n=${vals.length}`,
          );
      }
    }
  });

  it('paths match the independent reference (sum/count/avg/min/max + stdev)', () => {
    const rand = mulberry32(0x5eed);
    for (let trial = 0; trial < 400; trial += 1) {
      const vals = genMultiset(rand);
      const n = vals.length;
      if (n === 0) continue; // empty series → no bucket; covered by cross-path
      const agg = viaAggregate(vals);
      expect(agg.get('count'), `count trial=${trial}`).toBe(n);
      agree('sum', agg.get('sum'), refSum(vals), `ref trial=${trial}`);
      agree('min', agg.get('min'), refMin(vals), `ref trial=${trial}`);
      agree('max', agg.get('max'), refMax(vals), `ref trial=${trial}`);
      agree('avg', agg.get('avg'), refAvg(vals), `ref trial=${trial}`);
      agree('stdev', agg.get('stdev'), refStdev(vals), `ref trial=${trial}`);
    }
  });
});

describe('rolling parity — FIFO sliding window matches recompute', () => {
  // The §1.1 / #222 shape: a strictly FIFO window (add at the tail, remove the
  // oldest) over a *large-offset trending* stream, where the old one-pass
  // cancelled but the bucket/Welford paths didn't. After each op the
  // incremental rollingState must match a from-scratch reference over the
  // current window. Excludes median/pNN (no incremental accumulator).
  const SLIDING = ['sum', 'count', 'avg', 'min', 'max', 'stdev'] as const;
  const refOf = (name: string, w: number[]): unknown => {
    if (w.length === 0) return undefined;
    switch (name) {
      case 'sum':
        return refSum(w);
      case 'count':
        return w.length;
      case 'avg':
        return refAvg(w);
      case 'min':
        return refMin(w);
      case 'max':
        return refMax(w);
      case 'stdev':
        return refStdev(w);
      default:
        throw new Error(name);
    }
  };

  it('rollingState snapshot tracks the window on large-offset trending streams', () => {
    const rand = mulberry32(0xb0a710);
    for (const name of SLIDING) {
      for (let trial = 0; trial < 60; trial += 1) {
        // Large offset (up to 1e10) + moderate in-window spread — the trending
        // regime. (Deliberately no extreme outliers: evicting a value far
        // outside the residual spread is the documented subtractive-variance
        // limitation, not a drift bug; see stdev.ts.)
        const base = [0, 1e3, 1e6, 1e10][randInt(rand, 0, 3)]!;
        const state = rollingStateFor(name);
        const window: Array<{ i: number; v: number }> = [];
        const maxLen = randInt(rand, 1, 8);
        let idx = 0;
        for (let step = 0; step < 50; step += 1) {
          // Always add; once full, evict the oldest (strict FIFO).
          const v = base + (rand() * 2 - 1) * 50;
          state.add(idx, v);
          window.push({ i: idx, v });
          idx += 1;
          if (window.length > maxLen) {
            const old = window.shift()!;
            state.remove(old.i, old.v);
          }
          const got = state.snapshot();
          const ref = refOf(
            name,
            window.map((w) => w.v),
          );
          // At a large offset B, two effects compound: the deviation-precision
          // floor (~B·ε) and drift accumulated over the sliding add/remove
          // (running-sum rounding, Welford-delete residue). Both are *absolute*
          // and scale with B, so the floor is `B·1e-12` (≈1e-2 at B=1e10 —
          // covers worst-case drift with margin, yet still 2 orders below the
          // order-1 errors the gross cancellation this test defends against
          // would produce). Tight (1e-9 relative) at small magnitudes.
          //
          // CALIBRATION (do not widen blindly): this floor sits ~100× above the
          // fixed impl's own drift (~3e-4 at B=1e10) yet well below the bug
          // class — reverting #222 (rolling-stdev → one-pass) fails this test
          // with maxErr ≈ 496. Widening it risks blinding the suite; if you
          // must, re-confirm a reverted #222 still fails here.
          agree(
            name,
            got,
            ref,
            `trial=${trial} step=${step} base=${base}`,
            1e-9,
            base * 1e-12,
          );
        }
      }
    }
  });
});
