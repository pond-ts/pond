/**
 * Stroke the plot's gridlines: a vertical line at each `xTicks` pixel and a
 * horizontal line at each `yTicks` pixel, faint and dashed. Drawn behind the
 * data layers from the same tick positions the axes label, so grid and labels
 * line up. `+0.5` aligns each 1px stroke to the device grid for a crisp line.
 *
 * `save`/`restore` brackets the dash + stroke state so it doesn't leak into the
 * data layers that draw next.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  xTicks: readonly number[],
  yTicks: readonly number[],
  width: number,
  height: number,
  color: string,
  dash: readonly number[],
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([...dash]);
  ctx.beginPath();
  for (const x of xTicks) {
    const px = Math.round(x) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  for (const y of yTicks) {
    const py = Math.round(y) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(width, py);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Greedily thin an **ascending** list of pixel positions so no two kept lines
 * are closer than `minGap` px — keeps the axis from crowding when collapse
 * points are dense (e.g. a divider at every daily candle). Keeps the first of
 * each cluster.
 */
export function thinPixels(xs: readonly number[], minGap: number): number[] {
  const out: number[] = [];
  for (const x of xs) {
    if (out.length === 0 || x - out[out.length - 1]! >= minGap) out.push(x);
  }
  return out;
}

/**
 * Stroke **session dividers** — solid vertical lines at each `xs` pixel, spanning
 * the plot height. Drawn a touch stronger than the dashed gridlines (solid, so a
 * session/day boundary reads as structural, not just another tick) at the
 * discontinuity provider's collapse points (see `DiscontinuityProvider.boundaries`).
 */
export function drawDividers(
  ctx: CanvasRenderingContext2D,
  xs: readonly number[],
  height: number,
  color: string,
): void {
  if (xs.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const x of xs) {
    const px = Math.round(x) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  ctx.stroke();
  ctx.restore();
}
