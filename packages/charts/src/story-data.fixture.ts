import { TimeSeries } from 'pond-ts';

/**
 * Shared fixtures for the feature-axis reference stories (Annotations, Cursors,
 * Indicators). One 90-minute window on a 1-minute grid so the x is wall-clock;
 * every generator is deterministic (no RNG) so snapshots are stable.
 *
 * Excluded from the package build via the `*.fixture.ts` tsconfig exclude.
 */
export const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
export const STEP = 60_000;
export const N = 90;
export const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];
/** A shorter window for denser single-primitive shots. */
export const SHORT: readonly [number, number] = [BASE, BASE + 40 * STEP];

/** A single wavy price line (USD-ish, ~155–215). */
export function priceSeries() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([BASE + i * STEP, 185 + 30 * Math.sin(i / 10)]);
  }
  return new TimeSeries({
    name: 'price',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'price', kind: 'number' },
    ] as const,
    rows,
  });
}

/** A fast + slow pair, for crosshair / dual-series shots. */
export function twoSeries() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      185 + 30 * Math.sin(i / 10),
      190 + 18 * Math.sin(i / 6 + 1),
    ]);
  }
  return new TimeSeries({
    name: 'pair',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'fast', kind: 'number' },
      { name: 'slow', kind: 'number' },
    ] as const,
    rows,
  });
}

/** A heart-rate trace (bpm, ~110–170) — a second row for multi-row shots. */
export function hrSeries() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([BASE + i * STEP, 140 + 28 * Math.sin(i / 7)]);
  }
  return new TimeSeries({
    name: 'hr',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'bpm', kind: 'number' },
    ] as const,
    rows,
  });
}
