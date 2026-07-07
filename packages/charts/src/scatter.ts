import type { ChartSeries } from './data.js';
import type { Scale } from './line.js';
import type { ScatterStyle } from './theme.js';
import type { ResolvedEncoding } from './encoding.js';
import type { SelectInfo } from './context.js';

/**
 * Scatter geometry + the canvas draw — pure, like {@link drawLine} /
 * {@link drawBand}, so the recording-mock tests assert the op sequence and the
 * hit math without a browser.
 *
 * A scatter plots one mark per finite point at `(xScale(x), yScale(y))`, sized
 * + coloured by the resolved {@link ResolvedEncoding} (data-driven radius /
 * colour) over the style's base. All three of `drawScatter`, `scatterExtent`,
 * and {@link hitTestScatter} are **O(N)** in the point count (a single pass; no
 * spatial index — a chart row holds far fewer points than a dense line, and a
 * click happens at human cadence). If a scatter ever needs 100k+ points this is
 * the place to add a coarse x-bucket index; today the linear walk is the right
 * tradeoff.
 */

/** A non-finite y (the gap signal) means "no point here" — skip it everywhere. */
function isPoint(cs: ChartSeries, i: number): boolean {
  return Number.isFinite(cs.y[i]!);
}

/**
 * Index of the point in `cs` **nearest** `time` by `|x − time|`, restricted to
 * finite points, or `-1` if none. `cs.x` is the sorted time axis, so a binary
 * search finds the insertion point in O(log N); the two straddling rows are then
 * the only nearest candidates — but either may be a gap (non-finite y), so we
 * step outward from each until we find a real point and keep the closer.
 *
 * Ties go to the **earlier** point (strict `<` on the distance comparison),
 * matching core's `nearest(select:'nearest')`. Used by the tracker's `sampleAt`
 * so the readout snaps to a drawn mark (not a gap) — and reads everything by
 * index, so the encoded colour at that row comes along for free.
 */
export function nearestIndex(cs: ChartSeries, time: number): number {
  const n = cs.length;
  if (n === 0) return -1;
  // Binary search for the first index with x >= time.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cs.x[mid]! < time) lo = mid + 1;
    else hi = mid;
  }
  // Candidates straddle `lo`: the row at `lo` (>= time) and `lo - 1` (< time).
  // Either side may be a run of gaps, so scan outward for the nearest real point.
  let best = -1;
  let bestDist = Infinity;
  // Walk right from lo for the first finite point.
  for (let i = lo; i < n; i += 1) {
    if (Number.isFinite(cs.y[i]!)) {
      best = i;
      bestDist = Math.abs(cs.x[i]! - time);
      break;
    }
  }
  // Walk left from lo-1; take it only if strictly closer (ties → earlier index,
  // which on the left side means this earlier point wins an equal distance).
  for (let i = lo - 1; i >= 0; i -= 1) {
    if (Number.isFinite(cs.y[i]!)) {
      const d = Math.abs(cs.x[i]! - time);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
      break;
    }
  }
  return best;
}

/**
 * The `[min, max]` of the **finite** plotted values — identical to a line's
 * vertical extent (the marks sit at their values; radius is a pixel-space
 * concern that doesn't widen the data domain). `null` if no point is finite.
 * Mirrors `yExtent` so a scatter auto-fits its axis the same way a line does.
 */
export function scatterExtent(cs: ChartSeries): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < cs.length; i += 1) {
    const v = cs.y[i]!;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min === Infinity ? null : [min, max];
}

/**
 * Draw the scatter: one filled, outlined circle per finite point, sized +
 * coloured by `encoding` (data-driven radius / colour) over `style`. A gap
 * (non-finite y) draws nothing — points are discrete, there is no path to break.
 *
 * The **selected** point (when `selected` matches this layer's `label` *and* a
 * point's `begin` key) is restroked with the style's wider highlight ring after
 * the base pass, so it lifts above its neighbours regardless of draw order.
 * Matching on both key and label is what keeps two series sharing a timestamp
 * from both lighting up (the container's selection contract).
 *
 * Each circle is its own `beginPath`/`arc`/`fill`/`stroke`; `save`/`restore`
 * brackets the whole pass so fill/stroke state doesn't leak into later layers.
 * Reads `cs.x`/`cs.y` by index — no per-point object allocation in the hot loop.
 *
 * @param keyAt   maps a row index to the point's stable key (its event `begin`),
 *                for selection matching — the row's `x` is epoch ms, so this is
 *                usually `(i) => cs.x[i]`.
 * @param labelAt optional per-point text label; `undefined` ⇒ no labels drawn.
 * @param font    `theme.font` (family + size) for label text.
 * @param selected the container's current selection (or `null`).
 * @param seriesId this layer's stable series identity (its `id` prop, or
 *                `undefined` when the layer isn't selectable) — the series half
 *                of the selection match. A point lights only when the selection's
 *                `id` matches, keyed to the sample by its `key`.
 */
export function drawScatter(
  ctx: CanvasRenderingContext2D,
  cs: ChartSeries,
  xScale: Scale,
  yScale: Scale,
  style: ScatterStyle,
  encoding: ResolvedEncoding,
  keyAt: (i: number) => number,
  labelAt: ((i: number) => string | undefined) | undefined,
  font: { readonly family: string; readonly size: number },
  selected: SelectInfo | null,
  seriesId: string | undefined,
): void {
  ctx.save();
  // The selection only lights up a point of *this* series; resolve the key once.
  // A no-id (non-selectable) layer passes `undefined` and never matches.
  const selectedKey =
    selected !== null && selected.id === seriesId ? selected.key : null;
  let selPx = 0;
  let selPy = 0;
  let selR = 0;
  let selHit = false;

  for (let i = 0; i < cs.length; i += 1) {
    if (!isPoint(cs, i)) continue;
    const px = xScale(cs.x[i]!);
    const py = yScale(cs.y[i]!);
    const r = encoding.radiusAt(i);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = encoding.colorAt(i);
    ctx.fill();
    if (style.outlineWidth > 0) {
      ctx.lineWidth = style.outlineWidth;
      ctx.strokeStyle = style.outline;
      ctx.stroke();
    }
    // Defer the selected point's highlight ring to a second pass so it sits on
    // top of any neighbour drawn after it.
    if (selectedKey !== null && keyAt(i) === selectedKey) {
      selPx = px;
      selPy = py;
      selR = r;
      selHit = true;
    }
  }

  // Highlight ring for the selected point (after the base pass — always on top).
  if (selHit) {
    ctx.beginPath();
    ctx.arc(selPx, selPy, selR, 0, Math.PI * 2);
    ctx.lineWidth = style.selectedWidth;
    ctx.strokeStyle = style.selectedOutline;
    ctx.stroke();
  }

  // Optional per-point labels, after all marks so text isn't overpainted.
  if (labelAt !== undefined) {
    ctx.fillStyle = style.label;
    ctx.font = `${font.size}px ${font.family}`;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < cs.length; i += 1) {
      if (!isPoint(cs, i)) continue;
      const text = labelAt(i);
      if (text === undefined || text === '') continue;
      const px = xScale(cs.x[i]!);
      const py = yScale(cs.y[i]!);
      const r = encoding.radiusAt(i);
      // Sit the label just right of the point (past its radius), vertically
      // centred — simple, theme-styled placement.
      ctx.fillText(text, px + r + LABEL_GAP, py);
    }
  }

  ctx.restore();
}

/** Gap (px) between a point's edge and its label text. */
const LABEL_GAP = 4;

/**
 * Hit-test plot-pixel `(qx, qy)` against the scatter's points — the topmost
 * point whose circle contains the click, or `null`. "Topmost" = the
 * last-drawn at that spot, so a later point drawn over an earlier one wins; we
 * walk **backwards** and return the first containing point.
 *
 * A point's hit radius is its drawn radius (data-driven or base) — clicking the
 * visible disc selects it. Distance is compared squared (no `sqrt` in the loop).
 * Returns the point's {@link SelectInfo} with the series `id` (the selection
 * identity), `key = keyAt(i)` (its event `begin` — click provenance), the encoded
 * fill colour (so the readout swatch matches the mark), and the display `label`.
 *
 * Pure: takes the same `xScale`/`yScale` the row hands to `draw`, so it
 * unit-tests without a DOM (mirrors the `sampleAt` / `resolveSelection` split).
 */
export function hitTestScatter(
  cs: ChartSeries,
  qx: number,
  qy: number,
  xScale: Scale,
  yScale: Scale,
  encoding: ResolvedEncoding,
  keyAt: (i: number) => number,
  id: string,
  seriesLabel: string,
): SelectInfo | null {
  for (let i = cs.length - 1; i >= 0; i -= 1) {
    if (!isPoint(cs, i)) continue;
    const px = xScale(cs.x[i]!);
    const py = yScale(cs.y[i]!);
    const r = encoding.radiusAt(i);
    const dx = qx - px;
    const dy = qy - py;
    if (dx * dx + dy * dy <= r * r) {
      return {
        id,
        key: keyAt(i),
        value: cs.y[i]!,
        color: encoding.colorAt(i),
        label: seriesLabel,
      };
    }
  }
  return null;
}
