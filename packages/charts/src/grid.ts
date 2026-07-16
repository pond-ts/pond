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
 *
 * `alphas` (parallel to `xs`) fades individual lines — used by the `'all'`
 * session-divider mode so crowding lines dim smoothly toward invisible instead
 * of popping in/out with a hard density cutoff. Omitted ⇒ every line at full
 * opacity in a single path (the fast default). A near-zero alpha is skipped.
 */
export function drawDividers(
  ctx: CanvasRenderingContext2D,
  xs: readonly number[],
  height: number,
  color: string,
  alphas?: readonly number[],
): void {
  if (xs.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  if (alphas === undefined) {
    ctx.beginPath();
    for (const x of xs) {
      const px = Math.round(x) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
    }
    ctx.stroke();
  } else {
    // Per-line opacity → each line is its own path (globalAlpha can't vary
    // within one stroke). Dividers draw at base opacity 1 (nothing sets it
    // before this pass), so set the line alpha directly; `restore` resets it.
    for (let i = 0; i < xs.length; i++) {
      const a = alphas[i] ?? 1;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      const px = Math.round(xs[i]!) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Per-line opacity for {@link drawDividers} in `'all'` mode: each line fades in
 * proportion to its gap to the nearest neighbour, full at `fadePx`+ and ramping
 * to 0 as lines converge. So as a zoom-out crowds the session lines they dim
 * together toward a clean plot — no hard drop that pops on pan. `xs` ascending.
 */
export function dividerAlphas(xs: readonly number[], fadePx: number): number[] {
  return xs.map((x, i) => {
    const left = i > 0 ? x - xs[i - 1]! : Infinity;
    const right = i < xs.length - 1 ? xs[i + 1]! - x : Infinity;
    return Math.max(0, Math.min(1, Math.min(left, right) / fadePx));
  });
}
