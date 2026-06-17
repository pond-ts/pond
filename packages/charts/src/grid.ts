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
