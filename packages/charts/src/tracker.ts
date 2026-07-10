/**
 * Cursor geometry helpers — pure functions deciding *what* the cursor draws
 * ({@link cursorParts}) and *where* it sits ({@link resolveCursorX}). The marks
 * themselves render as an SVG overlay in `Layers` (no cursor canvas); these
 * helpers stay pure, so they're unit-tested directly.
 */

import type { Interval } from 'pond-ts';
import type { CursorMode } from './context.js';

/**
 * The interval in the sorted, non-overlapping `buckets` that contains `t`
 * (`begin ≤ t < end`), or `undefined` if `t` falls in no bucket. Binary search —
 * the `region` cursor uses it to find the bucket under the pointer.
 */
export function bucketAt(
  buckets: readonly Interval[],
  t: number,
): Interval | undefined {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = buckets[mid]!;
    if (t < b.begin()) hi = mid - 1;
    else if (t >= b.end()) lo = mid + 1;
    else return b;
  }
  return undefined;
}

/** Default cursor mode — the synced vertical line (cursor enabled on the
 *  container by default; pair with an off-chart readout via `onTrackerChanged`). */
export const DEFAULT_CURSOR_MODE: CursorMode = 'line';

/**
 * Decompose a {@link CursorMode} into what it draws: the shared vertical line,
 * the per-series dots, and which value chip (if any). The modes are exclusive
 * presets — `line` is line-only, `point` / `inline` / `flag` are dot-based with
 * no line, `none` draws nothing. `flag` raises a staff from each point to a
 * value flag stacked near the top of the row (drawn in `Layers`).
 */
export function cursorParts(mode: CursorMode): {
  readonly line: boolean;
  readonly dots: boolean;
  readonly chip: 'none' | 'inline' | 'flag' | 'axis';
  /** `region` mode: a shaded **band** over the bucket under the pointer (from
   *  `cursorSequence`), drawn by `Layers`; no line/dots/chip of its own. */
  readonly band: boolean;
} {
  const base = { line: false, dots: false, chip: 'none', band: false } as const;
  switch (mode) {
    case 'line':
      return { ...base, line: true };
    case 'point':
      return { ...base, dots: true };
    case 'inline':
      return { ...base, dots: true, chip: 'inline' };
    case 'flag':
      return { ...base, dots: true, chip: 'flag' };
    case 'crosshair':
      // A single reticle (not per-series): `Layers` draws the dashed vertical +
      // full-width horizontal lines, the centre dot, and one value pill itself
      // (so no generic line/dots here); the x-time pill is on `<XAxis>`.
      return { ...base, chip: 'axis' };
    case 'region':
      // A shaded band over the bucket under the pointer — `Layers` resolves the
      // bucket from `cursorBuckets` and draws the rect (cropped through xScale).
      return { ...base, band: true };
    case 'none':
      return { ...base };
  }
}

/**
 * The crosshair's plot-pixel x from the tracker inputs. A controlled
 * `trackerPosition` (epoch ms) maps through `xScale`, so a pinned time rides with
 * the data; `null` hides it; `undefined` (uncontrolled) uses the stored hover
 * pixel, so a still cursor stays put while a live window slides under it.
 */
export function resolveCursorX(
  trackerPosition: number | null | undefined,
  hoverX: number | null,
  xScale: (time: number) => number,
): number | null {
  if (trackerPosition === undefined) return hoverX;
  if (trackerPosition === null) return null;
  return xScale(trackerPosition);
}

// The cursor's line / dots / flag-staffs render as an SVG overlay in `Layers`
// (DOM, crisp, positioned in plot space) — there is no cursor canvas, so the
// former `drawCrosshair` / `drawTrackerDot` canvas primitives are gone.
