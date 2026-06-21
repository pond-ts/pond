import type { Scale } from './line.js';

/**
 * How a gap-aware draw layer ({@link LineChart} / {@link AreaChart}) renders a
 * **gap** — a run of non-finite (`NaN`) samples, the signal a coast / dropout /
 * missing bucket leaves in the columnar data (`Number.isFinite`, never
 * `!= null`; see `docs/rfcs/charts.md` trap #2). One concept shared across a
 * line and its area fill, so both speak the same vocabulary.
 *
 * **Bands deliberately have no gap mode.** A filled envelope's break wants its
 * own treatment (sharp edge vs. blurred), still to be designed; for now a band
 * always breaks honestly at a gap.
 *
 * - **`none`** — bridge straight across the gap: an interior gap is linearly
 *   interpolated ({@link bridgeGaps}) so the line connects the bordering points
 *   and the fill / band spans the gap, as if the data were continuous. A leading
 *   / trailing gap (no finite sample on one side) stays a break — there's nothing
 *   to bridge from. This is the only mode that is *not* gap-honest — use it when
 *   the gap is an artefact to ignore (evenly-sampled data with the odd dropped
 *   read), not a real absence.
 * - **`empty`** *(default)* — break: end the subpath at the gap, start a fresh
 *   one after it (d3-shape's `.defined`). Today's behavior; the fill / band
 *   leaves a hole. The honest default — a gap reads as a gap.
 * - **`dashed`** — the solid segments break as in `empty`, **plus** a dashed
 *   line bridges each gap **straight** (last-good point → next-good point). The
 *   fill stays broken. Reads as "we know the value resumed here, but didn't
 *   measure between" without pretending the line was continuous.
 * - **`step`** — the solid segments break as in `empty`, **plus** a single
 *   **flat dashed line at the average** of the two edge values bridges each gap
 *   (a horizontal `- - -`, no vertical step — see {@link drawGapSteps}). The
 *   fill stays broken. A neutral "the value sat around here" estimate — flatter
 *   and less committal than `dashed`'s straight interpolation between the edges.
 * - **`fade`** — estela's coast look: at each gap edge the line drops to the
 *   baseline on a **vertical fade to transparent** (opaque at the line,
 *   transparent at the baseline), and fades back in on the far side. The fill
 *   stays broken. Replicates estela's `es-drop` gradient
 *   (`packages/ui/src/DataChart.tsx`) in the canvas renderer.
 *
 * `dashed` and `step` are the **inferred dashed connectors** — both drawn fainter
 * than the solid line (theme `gap.connectorOpacity`, {@link DEFAULT_GAP_CONNECTOR_OPACITY})
 * so an inferred bridge reads as secondary to measured data. Only `fade` drops to
 * a "baseline": for a line the axis floor (the y-scale's domain lower bound,
 * resolved at draw time), for an {@link AreaChart} its own fill baseline.
 */
export type GapMode = 'none' | 'empty' | 'dashed' | 'step' | 'fade';

/** The default gap mode — break at the gap, leave a hole (today's behavior). */
export const DEFAULT_GAP_MODE: GapMode = 'empty';

/**
 * Default opacity for the inferred dashed gap connectors (`dashed` / `step`) when
 * a theme sets no `gap.connectorOpacity` — fainter than the solid line so the
 * inferred bridge reads as secondary to measured data.
 */
export const DEFAULT_GAP_CONNECTOR_OPACITY = 0.5;

/**
 * One gap in a columnar value series: the index of the last finite sample
 * **before** the gap and the first finite sample **after** it, with their pixel
 * coordinates already resolved. Only **interior** gaps (a finite sample on each
 * side) become edges — a leading / trailing gap has nothing to bridge, so it's
 * skipped (the solid path simply starts / ends at the first / last finite run,
 * matching the d3 `.defined` break).
 */
export interface GapEdge {
  /** Index of the last finite sample before the gap. */
  readonly fromIndex: number;
  /** Index of the first finite sample after the gap. */
  readonly toIndex: number;
  /** Pixel x of the last-good sample (`fromIndex`). */
  readonly fromX: number;
  /** Pixel y of the last-good sample (`fromIndex`). */
  readonly fromY: number;
  /** Pixel x of the next-good sample (`toIndex`). */
  readonly toX: number;
  /** Pixel y of the next-good sample (`toIndex`). */
  readonly toY: number;
}

/**
 * Return a copy of `values` with **interior** gaps (NaN runs that have a finite
 * sample on each side) linearly interpolated across, for the `none` mode — so d3
 * sees a continuous finite series and both the line and (for an area) the fill
 * bridge the gap with real path ops. Leading / trailing NaNs (no finite anchor
 * on one side) are left NaN: there's nothing to interpolate from, so they stay a
 * break (a `lineTo`/`moveTo` with a NaN coord is dropped by the canvas spec, so
 * leaving them NaN is the honest no-op rather than fabricating an edge value).
 *
 * O(N): one forward pass tracking the last finite value + index, filling the
 * pending run when the next finite sample closes it. Allocates one `Float64Array`
 * (only taken on the `none` path).
 */
export function bridgeGaps(values: Float64Array, length: number): Float64Array {
  const out = values.slice(0, length);
  let lastIdx = -1; // index of the last finite value seen
  for (let i = 0; i < length; i += 1) {
    if (Number.isFinite(out[i]!)) {
      if (lastIdx >= 0 && i - lastIdx > 1) {
        // Fill the (lastIdx, i) interior run by linear interpolation.
        const a = out[lastIdx]!;
        const b = out[i]!;
        const span = i - lastIdx;
        for (let j = lastIdx + 1; j < i; j += 1) {
          out[j] = a + ((b - a) * (j - lastIdx)) / span;
        }
      }
      lastIdx = i;
    }
  }
  return out;
}

/**
 * Walk a columnar series once (O(N)) and collect the **interior** gaps — runs of
 * non-finite `value(i)` that have a finite sample on *both* sides — as
 * {@link GapEdge}s with pixel coordinates resolved through `xScale`/`lineY`.
 *
 * `value(i)` reads the gap-deciding value at index `i` (for a line that's the
 * `y` value; for a band, "finite" means *both* edges finite — pass a function
 * that returns `NaN` unless both are). `lineY(i)` reads the pixel y the bridge
 * should start / end at (the value line for a line / area; the upper edge for a
 * band). Leading and trailing gaps are skipped — a bridge needs a point on each
 * side.
 */
export function collectGapEdges(
  length: number,
  x: Float64Array,
  value: (i: number) => number,
  xScale: Scale,
  lineY: (i: number) => number,
): GapEdge[] {
  const edges: GapEdge[] = [];
  let prevGood = -1; // last finite index seen
  let inGap = false; // inside a NaN run that already has a left border
  for (let i = 0; i < length; i += 1) {
    if (Number.isFinite(value(i))) {
      if (inGap && prevGood >= 0) {
        // Close an interior gap: prevGood → i.
        edges.push({
          fromIndex: prevGood,
          toIndex: i,
          fromX: xScale(x[prevGood]!),
          fromY: lineY(prevGood),
          toX: xScale(x[i]!),
          toY: lineY(i),
        });
      }
      prevGood = i;
      inGap = false;
    } else if (prevGood >= 0) {
      // A gap with a left border — a candidate interior gap (closed when the
      // next finite sample arrives; a trailing run never closes, so is skipped).
      inGap = true;
    }
  }
  return edges;
}

/**
 * Stroke a **dashed straight bridge** across each gap (`from` → `to`), for the
 * `dashed` mode. The solid segments are drawn separately (the `empty` pass); this
 * adds only the bridges, dashed (and faint, via `opacity`) so they read as
 * inferred, not measured. Bracketed by `save`/`restore` so the dash pattern,
 * alpha, and stroke don't leak into later layers.
 */
export function drawGapBridges(
  ctx: CanvasRenderingContext2D,
  edges: readonly GapEdge[],
  color: string,
  width: number,
  opacity = 1,
): void {
  if (edges.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = opacity;
  ctx.setLineDash(GAP_DASH);
  ctx.beginPath();
  for (const e of edges) {
    ctx.moveTo(e.fromX, e.fromY);
    ctx.lineTo(e.toX, e.toY);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Stroke a **flat dashed line at the average** of the two edge values across each
 * gap, for the `step` mode: one horizontal segment at the midpoint of `fromY` and
 * `toY`, spanning the gap (`- - -`) — no vertical step. A neutral "the value sat
 * around here" estimate, flatter and less committal than `dashed`'s straight
 * interpolation between the edges. Dashed (and faint, via `opacity`) so it reads
 * as inferred. Bracketed by `save`/`restore`.
 */
export function drawGapSteps(
  ctx: CanvasRenderingContext2D,
  edges: readonly GapEdge[],
  color: string,
  width: number,
  opacity = 1,
): void {
  if (edges.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = opacity;
  ctx.setLineDash(GAP_DASH);
  ctx.beginPath();
  for (const e of edges) {
    // The average of the two edge values; with a linear y-scale the pixel
    // midpoint equals yScale of the value average, so no value round-trip.
    const midY = (e.fromY + e.toY) / 2;
    ctx.moveTo(e.fromX, midY);
    ctx.lineTo(e.toX, midY);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the **fade-to-baseline** at each gap edge for the `fade` mode — estela's
 * coast look (`es-drop`). At the last-good point a vertical segment drops to
 * `baselinePx`, stroked with a vertical gradient opaque (`color`) at the line and
 * transparent at the baseline; the same fade rises at the next-good point on the
 * far side. So the line dissolves into the floor approaching the gap and re-forms
 * after it, rather than ending in a hard stub.
 *
 * estela strokes this as one SVG `<path>` with a single `objectBoundingBox`
 * gradient spanning the path's box; canvas gradients are in user space, so we
 * build one short vertical gradient per drop (anchored at that drop's line→base
 * span) and stroke it. Faithful to the *visual* (a per-edge vertical fade from
 * the line colour to nothing); the implementation differs only in that canvas
 * needs a gradient per drop instead of one shared bounding-box gradient.
 *
 * {@link withAlpha} derives the transparent stop from `color` (a CSS hex); a
 * non-hex colour falls back to `transparent`. Bracketed by `save`/`restore`.
 */
export function drawGapFades(
  ctx: CanvasRenderingContext2D,
  edges: readonly GapEdge[],
  baselinePx: number,
  color: string,
  width: number,
): void {
  if (edges.length === 0) return;
  const transparent = withAlpha(color, 0);
  ctx.save();
  ctx.lineWidth = width;
  // One vertical drop per edge endpoint: the last-good point and the next-good
  // point each fade from the line down to the baseline.
  for (const e of edges) {
    for (const [px, py] of [
      [e.fromX, e.fromY],
      [e.toX, e.toY],
    ] as const) {
      // Degenerate (the line already sits on the baseline) → nothing to fade.
      if (Math.abs(py - baselinePx) < 1e-6) continue;
      const grad = ctx.createLinearGradient(0, py, 0, baselinePx);
      grad.addColorStop(0, color); // opaque at the line
      grad.addColorStop(1, transparent); // transparent at the baseline
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, baselinePx);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Dash pattern for the inferred-bridge modes (`dashed` / `step`): 4 on, 4 off.
 * Mutable (not `readonly`) because `ctx.setLineDash` takes a `number[]`.
 */
const GAP_DASH: number[] = [4, 4];

/**
 * Re-express a CSS hex colour (`#rgb` / `#rrggbb`) as `rgba(...)` with the given
 * alpha — for the transparent stop of a fade gradient. A non-hex string (named
 * colour, already-`rgba`) can't be parsed, so at alpha 0 it falls back to the
 * CSS keyword `transparent` (still see-through); at any other alpha it's returned
 * unchanged. Shared by the `fade` gap mode and {@link AreaChart}'s graded fill.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (m === null) return alpha === 0 ? 'transparent' : color;
  let r: number;
  let g: number;
  let b: number;
  if (m[1]!.length === 3) {
    r = parseInt(m[1]![0]! + m[1]![0]!, 16);
    g = parseInt(m[1]![1]! + m[1]![1]!, 16);
    b = parseInt(m[1]![2]! + m[1]![2]!, 16);
  } else {
    r = parseInt(m[1]!.slice(0, 2), 16);
    g = parseInt(m[1]!.slice(2, 4), 16);
    b = parseInt(m[1]!.slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
