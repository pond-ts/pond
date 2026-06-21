/**
 * Interaction-overlay primitives + geometry — the crosshair/dot draws (on a
 * row's overlay canvas, above the data and below the DOM readout) plus the pure
 * cursor-resolution helper. All pure, so the geometry is unit-tested directly
 * like {@link drawLine} / {@link drawBand}.
 */

import type { CursorMode } from './context.js';

/** Default cursor mode — the synced vertical line (cursor enabled on the
 *  container by default; pair with an off-chart readout via `onTrackerChanged`). */
export const DEFAULT_CURSOR_MODE: CursorMode = 'line';

/**
 * Decompose a {@link CursorMode} into what it draws: the shared vertical line,
 * the per-series dots, and which value chip (if any). The modes are exclusive
 * presets — `line` is line-only, `point` / `inline` / `flag` are dot-based with
 * no line, `none` draws nothing. (The `flag` chip is the stacked-at-top form for
 * now; the point-anchored staffed flag lands in a later phase.)
 */
export function cursorParts(mode: CursorMode): {
  readonly line: boolean;
  readonly dots: boolean;
  readonly chip: 'none' | 'inline' | 'flag';
} {
  switch (mode) {
    case 'line':
      return { line: true, dots: false, chip: 'none' };
    case 'point':
      return { line: false, dots: true, chip: 'none' };
    case 'inline':
      return { line: false, dots: true, chip: 'inline' };
    case 'flag':
      return { line: false, dots: true, chip: 'flag' };
    case 'none':
      return { line: false, dots: false, chip: 'none' };
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

/**
 * A vertical crosshair at plot-x `x` (CSS px), full row height. Snapped to a
 * pixel center so the 1px line stays crisp regardless of the cursor's sub-pixel
 * position (an integer x would straddle two device columns and blur).
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  height: number,
  color: string,
): void {
  const px = Math.round(x) + 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, height);
  ctx.stroke();
  ctx.restore();
}

/** Dot radius (CSS px) for {@link drawTrackerDot}. */
const DOT_RADIUS = 3;

/**
 * A filled dot at (`x`, `y`) marking a series' value under the cursor. An
 * optional `ring` (usually the plot background) is stroked around it so the dot
 * stays legible sitting on top of its line.
 */
export function drawTrackerDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  ring?: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (ring !== undefined) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = ring;
    ctx.stroke();
  }
  ctx.restore();
}
