/**
 * Interaction-overlay primitives — drawn on a row's overlay canvas (above the
 * data, below the DOM readout) and redrawn on pointer move while the data canvas
 * stays put. Pure + canvas-only so the geometry is unit-tested directly, like
 * {@link drawLine} / {@link drawBand}.
 */

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
