/**
 * Deterministic data generators for the performance bench (Phase 1).
 *
 * Every generator is **seeded** and pure: the same `(size, seed)` always
 * produces the same series. The bench numbers are directional and
 * machine-recorded, so the *data* must not be a source of variance — a
 * benchmark re-run on the same machine compares like with like, and a
 * regression shows up as a renderer change, not a different random walk.
 *
 * These build pond `TimeSeries` via the public API. For the static-size
 * scenarios the construction cost (per-row validation in the constructor) is
 * paid in `useMemo` *outside* the timed region — the bench times
 * mount→first-paint, not data generation. See `Perf.stories.tsx`.
 */

import { TimeSeries } from 'pond-ts';

/** 1-second grid — the references' cadence (dashboards sample at 1–10 Hz). */
export const STEP_MS = 1_000;

/** Fixed base epoch (2026-01-01 00:00 UTC) so the time axis is deterministic. */
export const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * A tiny deterministic PRNG (mulberry32) — seeded, fast, no dependency. Good
 * enough to add reproducible jitter to an otherwise-smooth signal so the
 * renderer walks a realistic, non-degenerate point cloud (a pure sine
 * compresses to a thin band and under-exercises the stroke path).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

/**
 * Build a single-column line series of `size` points: a slow sine plus seeded
 * jitter, on the 1s grid. The jitter keeps the line from collapsing to a thin
 * band so the stroke path does real per-point work.
 */
export function makeLineSeries(
  size: number,
  seed = 1,
): TimeSeries<typeof LINE_SCHEMA> {
  const rand = mulberry32(seed);
  const rows: Array<[number, number]> = new Array(size);
  for (let i = 0; i < size; i += 1) {
    const v = 50 + 40 * Math.sin(i / 200) + (rand() - 0.5) * 18;
    rows[i] = [BASE + i * STEP_MS, v];
  }
  return new TimeSeries({ name: 'perf-line', schema: LINE_SCHEMA, rows });
}

const THREE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number' },
  { name: 'b', kind: 'number' },
  { name: 'c', kind: 'number' },
] as const;

/**
 * Build a three-column series of `size` points (the "3 series" scenario): three
 * phase-shifted sines, each with its own seeded jitter, sharing one time axis.
 * Renders as three overlaid {@link LineChart}s — the multi-series stroke cost.
 */
export function makeThreeSeries(
  size: number,
  seed = 1,
): TimeSeries<typeof THREE_SCHEMA> {
  const ra = mulberry32(seed);
  const rb = mulberry32(seed + 101);
  const rc = mulberry32(seed + 202);
  const rows: Array<[number, number, number, number]> = new Array(size);
  for (let i = 0; i < size; i += 1) {
    const a = 50 + 40 * Math.sin(i / 200) + (ra() - 0.5) * 18;
    const b = 50 + 30 * Math.sin(i / 200 + 2) + (rb() - 0.5) * 14;
    const c = 50 + 35 * Math.sin(i / 200 + 4) + (rc() - 0.5) * 16;
    rows[i] = [BASE + i * STEP_MS, a, b, c];
  }
  return new TimeSeries({ name: 'perf-three', schema: THREE_SCHEMA, rows });
}

const BAND_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'lower', kind: 'number' },
  { name: 'mid', kind: 'number' },
  { name: 'upper', kind: 'number' },
] as const;

/**
 * Build a band series of `size` points (the "band" scenario): a centre line
 * with a seeded-jittered half-width, materialized as `lower`/`mid`/`upper`
 * columns. Renders as a {@link BandChart} (lower/upper fill) with a
 * {@link LineChart} on the median — the filled-envelope draw cost (a d3 `area`,
 * roughly twice the path length of a single line).
 */
export function makeBandSeries(
  size: number,
  seed = 1,
): TimeSeries<typeof BAND_SCHEMA> {
  const rand = mulberry32(seed);
  const rows: Array<[number, number, number, number]> = new Array(size);
  for (let i = 0; i < size; i += 1) {
    const mid = 50 + 30 * Math.sin(i / 200);
    const halfWidth = 6 + 4 * Math.abs(Math.sin(i / 53)) + rand() * 3;
    rows[i] = [BASE + i * STEP_MS, mid - halfWidth, mid, mid + halfWidth];
  }
  return new TimeSeries({ name: 'perf-band', schema: BAND_SCHEMA, rows });
}

/** The time range `[start, end]` spanned by a `size`-point series on the grid. */
export function rangeFor(size: number): readonly [number, number] {
  return [BASE, BASE + Math.max(0, size - 1) * STEP_MS];
}

/**
 * The next sample value for the live-append scenario at logical index `n` —
 * the same slow-sine-plus-seeded-jitter shape as {@link makeLineSeries}, so the
 * streaming line matches the static one. Seeded by `n` itself, so a given index
 * always yields the same value (deterministic across runs).
 */
export function liveSampleAt(n: number, seed = 1): number {
  // Derive a per-index deterministic jitter without keeping PRNG state across
  // the (open-ended) append loop.
  const rand = mulberry32((seed * 2654435761 + n) >>> 0);
  return 50 + 40 * Math.sin(n / 200) + (rand() - 0.5) * 18;
}
