/**
 * Stroke the plot's gridlines: a vertical line at each `xTicks` pixel and a
 * horizontal line at each `yTicks` pixel, faint and dashed. On a calendar
 * axis the verticals are the **full grain populations** (every day / month /
 * aligned hour in view — see `TradingTimeScale.gridLevels`), not just the
 * labelled ticks. `+0.5` aligns each 1px stroke to the device grid for a
 * crisp line.
 *
 * `xAlphas` (parallel to `xTicks`) fades individual verticals — the
 * hierarchical density falloff: a crowding grain's lines dim toward invisible
 * while coarser grains hold full strength. Full-alpha lines (and all the
 * horizontals) batch into one path; only the fading remainder pays a
 * per-line stroke. A near-zero alpha is skipped.
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
  xAlphas?: readonly number[],
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([...dash]);
  ctx.beginPath();
  for (let i = 0; i < xTicks.length; i++) {
    if (xAlphas !== undefined && (xAlphas[i] ?? 1) < 1) continue;
    const px = Math.round(xTicks[i]!) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  for (const y of yTicks) {
    const py = Math.round(y) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(width, py);
  }
  ctx.stroke();
  if (xAlphas !== undefined) {
    for (let i = 0; i < xTicks.length; i++) {
      const a = xAlphas[i] ?? 1;
      if (a >= 1 || a <= 0.02) continue;
      ctx.globalAlpha = a;
      const px = Math.round(xTicks[i]!) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
  }
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
 * Per-line opacity for {@link drawDividers} in `'all'` mode: each line keys off
 * the gap to its nearest neighbour — full at `fullPx`+, **zero** at `gonePx`
 * and below, a quadratic ramp between. So as a zoom-out crowds the session
 * lines they dim toward a clean plot — no hard drop that pops on pan.
 *
 * The curve must fall **superlinearly** in the gap: the veil a reader sees is
 * `alpha × density = alpha / gap`, so the earlier linear ramp (`alpha = gap/f`)
 * cancelled the density growth exactly and pinned a constant gray wash over the
 * whole plot no matter how far out you zoomed. Quadratic-to-a-floor makes the
 * wash itself → 0 as lines converge: alpha `t²` with
 * `t = (gap − gonePx) / (fullPx − gonePx)`. `xs` ascending.
 */
export function dividerAlphas(
  xs: readonly number[],
  gonePx: number,
  fullPx: number,
): number[] {
  return xs.map((x, i) => {
    const left = i > 0 ? x - xs[i - 1]! : Infinity;
    const right = i < xs.length - 1 ? xs[i + 1]! - x : Infinity;
    const gap = Math.min(left, right);
    const t = Math.max(0, Math.min(1, (gap - gonePx) / (fullPx - gonePx)));
    return t * t;
  });
}
