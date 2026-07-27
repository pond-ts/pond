/**
 * Seeded 5-minute bars.
 *
 * M1's claim only shows up at scale — a graph that recomputes in under a
 * millisecond makes caching invisible. 150k bars is roughly fourteen
 * months of continuous 5m data and puts a cold `sma(20)` in the tens of
 * milliseconds, which is the range where the warm/cold badge reads.
 *
 * The walk is deterministic (a small LCG, no `Math.random`) so that a
 * number quoted in a friction note can be reproduced later.
 */

import { TimeSeries, type SeriesSchema } from 'pond-ts';

const FIVE_MIN = 5 * 60_000;

export const barSchema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
  { name: 'volume', kind: 'number' },
] as const satisfies SeriesSchema;

/** Consumer-supplied units for the raw columns — see `Units`. */
export const barUnits = { px: 'USD', volume: 'shares' };

/** Mulberry32 — small, seeded, and good enough for a price walk. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DatasetSpec {
  readonly id: string;
  readonly rows: number;
  readonly seed: number;
  readonly start: number;
  readonly drift: number;
  readonly vol: number;
}

export const datasetSpecs: readonly DatasetSpec[] = [
  {
    id: 'ACME_5m',
    rows: 150_000,
    seed: 20260727,
    start: 184.5,
    drift: 6e-7,
    vol: 0.0009,
  },
  {
    id: 'GLOBEX_5m',
    rows: 150_000,
    seed: 91117,
    start: 42.8,
    drift: -2e-7,
    vol: 0.0016,
  },
];

/**
 * A GBM-ish walk with a slow intraday cycle laid over it, so that a
 * rolling study has something with visible structure to bite on rather
 * than pure noise.
 */
export function makeBars(spec: DatasetSpec): TimeSeries<typeof barSchema> {
  const next = rng(spec.seed);
  const t0 = Date.UTC(2025, 0, 1);
  const rows: [number, number, number][] = new Array(spec.rows);
  let px = spec.start;
  for (let i = 0; i < spec.rows; i += 1) {
    // Box–Muller, one draw per bar.
    const u = Math.max(next(), 1e-12);
    const shock = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    const cycle = Math.sin((i / 288) * 2 * Math.PI) * spec.vol * 0.35;
    px *= Math.exp(spec.drift + spec.vol * shock + cycle);
    rows[i] = [t0 + i * FIVE_MIN, px, Math.round(2_000 + next() * 18_000)];
  }
  return TimeSeries.fromJSON({ name: spec.id, schema: barSchema, rows });
}
