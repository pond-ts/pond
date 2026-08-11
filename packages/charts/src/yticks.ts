/**
 * The **y-axis auto-tick count** — the `count` a `<YAxis>`'s labels and the
 * row's gridlines both pass to `scale.ticks(count)` / `tickFormat(count)`, so
 * a label and its gridline stay on the same instants (the alignment the two
 * hardcoded `5`s in `YAxis` + `Layers` used to hold by agreeing).
 *
 * Height-derived by default — a short strip gets fewer ticks than a tall row,
 * so a 72px histogram lane no longer crushes 5 labels into the space a 380px
 * row uses (the #508 vol-surface friction). This mirrors the trading-time x
 * axis, whose count is width-derived (0.44.1). An explicit `<YAxis tickCount>`
 * overrides the derivation; explicit `<YAxis ticks>` bypasses this entirely.
 */

/** Target px of row height per y tick. A y label is one line, so this is the
 *  vertical breathing room between gridlines — a touch tighter than the x
 *  axis's per-tick budget, since stacked numbers need less room than dates. */
const Y_TICK_PX = 48;

/**
 * Resolve a y-axis's auto-tick count: the explicit `tickCount` when given,
 * else `floor(height / Y_TICK_PX)` floored at 2 (a drawable minimum even on a
 * pre-layout zero height). `ticks(count)` treats it as a target and returns
 * nice 1-2-5 values near it, so a larger count on a tall row is exactly right.
 */
export function resolveYTickCount(
  height: number,
  explicit?: number | undefined,
): number {
  if (explicit !== undefined) return Math.max(1, Math.floor(explicit));
  return Math.max(2, Math.floor(height / Y_TICK_PX));
}

/** The slice of a scale {@link yTickValues} reads. */
interface TickableScale {
  ticks(count?: number): number[];
  domain(): number[];
  /** Present on d3's `scaleLog` and on no other continuous scale. */
  base?: () => number;
  /** Present on d3's `scaleSymlog` and on no other continuous scale — the
   *  linear window's half-width, i.e. the knee ([PND-SYMLOG]). */
  constant?: () => number;
}

/**
 * The y tick **values** a `<YAxis>`'s labels and the row's gridlines draw —
 * the one list, so a label and its gridline stay on the same instants.
 *
 * On a linear scale this is just `scale.ticks(count)`, whose 1-2-5 selection
 * treats the count as a target. **On a log scale it cannot be**, because d3's
 * `scaleLog.ticks(count)` is not a target at all — it is nearly a step
 * function, and the jump is catastrophic. Measured against a real seven-decade
 * domain (ESnet's traffic history, 1.9e10 → 2.6e17 bytes):
 *
 * | `count` | ticks returned |
 * | ------- | -------------- |
 * | 4       | 3 (every *other* decade — 1e12, 1e14, 1e16) |
 * | 6       | 7 (every decade — the one right answer)     |
 * | 8       | **64** (every 2,3,…9 × decade)              |
 *
 * Since the count is height-derived (`height / 48`), that means a 260px row
 * silently labels 3 of 7 decades and a 400px row draws 64 gridlines and 64
 * labels — a 40px resize flipping between them. Neither is a rendering nicety;
 * both are unreadable.
 *
 * So for a log scale we pick the decades ourselves: every `k`th power of ten,
 * with `k` the smallest step whose tick count fits the budget. That is what a
 * log plot is conventionally gridded on, it degrades predictably as the row
 * shrinks, and it never explodes.
 *
 * Below two decades of span there aren't enough powers of ten to grid with, and
 * d3's within-decade selection (2,3,…9 × 10ⁿ) is the right answer and is well
 * behaved — so that case defers to the scale.
 *
 * Log detection is structural: `base()` exists on `scaleLog` and on no other
 * continuous scale. The alternative is threading the axis kind down to the
 * gridline site, which has no `AxisSpec` in scope — the same localized-shape
 * approach `resolveBarBaseline` takes to read `.domain()`.
 */
export function yTickValues(scale: TickableScale, count: number): number[] {
  if (typeof scale.constant === 'function')
    return symlogTickValues(scale, count);
  if (typeof scale.base !== 'function') return scale.ticks(count);

  const domain = scale.domain();
  const lo = Math.min(domain[0]!, domain[domain.length - 1]!);
  const hi = Math.max(domain[0]!, domain[domain.length - 1]!);
  if (!(lo > 0) || !(hi > lo)) return scale.ticks(count);

  const first = Math.ceil(Math.log10(lo));
  const last = Math.floor(Math.log10(hi));
  const decades = last - first + 1;
  if (decades < 2) return scale.ticks(count);

  const budget = Math.max(2, count);
  const step = Math.max(1, Math.ceil(decades / budget));
  const out: number[] = [];
  for (let e = first; e <= last; e += step) out.push(10 ** e);
  return out;
}

/**
 * Tick values for a **symlog** axis — linear through zero, logarithmic beyond
 * ([PND-SYMLOG]).
 *
 * **This is the feature, not a refinement of it.** d3's `scaleSymlog` supplies
 * the transform but its `ticks()` is `linearish` — evenly spaced in *value*. On
 * a ±1M domain with a 20k knee that yields `-1M, -500k, 0, 500k, 1M`: **nothing
 * at all below the knee**, which is the region a symlog axis exists to reveal.
 * The mapping does spread that region generously (0→250px, 20k→294px,
 * 100k→364px on a 500px range), so such a chart is readable-but-unlabelled —
 * confidently gridded on the one part of the scale that isn't the point. Owning
 * the ladder is therefore inseparable from owning the transform.
 *
 * The ladder, and why each piece is there:
 *
 * - **Zero, always.** It is the axis's centre of symmetry and the one value a
 *   symlog scale is chosen to keep visible.
 * - **The knee, ±`constant`.** Where the reading changes from linear to
 *   logarithmic. Unlabelled, a reader has no way to know which régime a given
 *   gap belongs to, and the same pixel distance means different things either
 *   side of it.
 * - **Decades beyond the knee, mirrored.** What a log plot is conventionally
 *   gridded on, thinned by the same "every `k`th power of ten" rule the log path
 *   above uses, so it degrades predictably as the row shrinks instead of
 *   exploding.
 * - **Bounds are NOT labelled.** A data-derived bound is rarely round, so
 *   printing it puts an arbitrary number next to a decade — the noise a log grid
 *   exists to avoid.
 *
 * Below one decade of span past the knee there is nothing to grid
 * logarithmically, so it defers to `scale.ticks(count)` — which is linear, and
 * correct, because inside the knee symlog *is* linear.
 *
 * Detection is structural, matching the log path's use of `base()`: `constant()`
 * exists on `scaleSymlog` and on no other continuous scale.
 */
function symlogTickValues(scale: TickableScale, count: number): number[] {
  const domain = scale.domain();
  const lo = Math.min(domain[0]!, domain[domain.length - 1]!);
  const hi = Math.max(domain[0]!, domain[domain.length - 1]!);
  const knee = Math.abs(scale.constant?.() ?? 1);
  const maxAbs = Math.max(Math.abs(lo), Math.abs(hi));
  if (!(knee > 0) || !(maxAbs > knee) || !(hi > lo)) return scale.ticks(count);

  const firstExp = Math.ceil(Math.log10(knee));
  const lastExp = Math.floor(Math.log10(maxAbs));
  const decades = lastExp - firstExp + 1;
  if (decades < 1) return scale.ticks(count);

  // A symmetric domain shows each decade twice, so the budget is spent twice as
  // fast as on a log axis — hence `decades * 2` against the same count.
  const twoSided = lo < 0 && hi > 0;
  const budget = Math.max(2, count);
  const step = Math.max(1, Math.ceil((decades * (twoSided ? 2 : 1)) / budget));

  const out = new Set<number>();
  const add = (v: number) => {
    if (v >= lo && v <= hi) out.add(v);
  };
  add(0);
  add(knee);
  add(-knee);
  for (let e = firstExp; e <= lastExp; e += step) {
    add(10 ** e);
    add(-(10 ** e));
  }
  return [...out].sort((a, b) => a - b);
}
