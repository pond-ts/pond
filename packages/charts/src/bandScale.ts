import { scaleLinear } from 'd3-scale';

/**
 * A d3-scale-shaped **ordinal band scale** for a categorical x-axis — the
 * transpose view's "columns on x" (categorical-axis RFC, Phase 1). It exposes the
 * slice of the d3 scale surface `@pond-ts/charts` actually uses, so it drops in
 * wherever the container's `xScale` goes (the same trick {@link TradingTimeScale}
 * uses for a discontinuous time axis).
 *
 * **Numeric slot-index domain (the load-bearing choice).** The domain is
 * `[0, n]` — one unit slot per category, slot `i` occupying `[i, i+1]` — *not* a
 * `string[]`. So the pixel **mapping stays linear** and the container's numeric
 * domain / auto-fit / `range` pipeline is untouched; a bar layer draws each
 * category with the ordinary `barSpanPx(i, i+1, …)`. The category-ness lives in
 * three methods only:
 *
 * - {@link ScaleBand.ticks} → the band **centres** (`i + 0.5`), one per category;
 * - {@link ScaleBand.invert} → snaps a pixel to the nearest slot's centre (the
 *   categorical crosshair UX, and it keeps the `+xScale.invert` call sites happy);
 * - {@link ScaleBand.label} → the category name at a slot (the axis formatter).
 *
 * The category labels are carried alongside for {@link ScaleBand.label}; the
 * numeric domain is authoritative for geometry.
 */
export interface ScaleBand {
  /** Slot value (`i` = left edge, `i + 0.5` = centre) → pixel. Linear. */
  (value: number): number;
  /** Pixel → the nearest slot's **centre** value (`i + 0.5`), clamped to a real slot. */
  invert(pixel: number): number;
  /** One tick per category, at its band **centre** (`i + 0.5`). */
  ticks(count?: number): number[];
  /** One slot's width in pixels (`|range| / slots`). The bar's `gap` insets within it. */
  bandwidth(): number;
  /** Slot pitch in pixels — same as {@link bandwidth} (padding is the bar's `gap`). */
  step(): number;
  /** The category name at slot value `v` (`categories[floor(v)]`), or `''`. */
  label(value: number): string;
  domain(): [number, number];
  domain(next: readonly [number, number]): ScaleBand;
  range(): [number, number];
  range(next: readonly [number, number]): ScaleBand;
  copy(): ScaleBand;
}

/**
 * Build a {@link ScaleBand} over an ordered list of category names. Configure like
 * a d3 scale: `scaleBand(tickers).domain([0, n]).range([0, width])` — the
 * container sets `domain([0, n])` from the layer's slot extent and `range([0,
 * plotWidth])`. `categories` supplies the labels; the domain drives the geometry,
 * so the two must agree on count (`categories.length === n`), which they do when
 * both come from the same layer's `xCategories()` / slot extent.
 */
export function scaleBand(categories: readonly string[]): ScaleBand {
  let domain: [number, number] = [0, Math.max(1, categories.length)];
  let range: [number, number] = [0, 1];
  const lin = scaleLinear();

  const sync = () => lin.domain(domain).range(range);
  /** Slot count = the domain width (the container sets `[0, n]`). */
  const slots = (): number => Math.max(0, Math.round(domain[1] - domain[0]));

  const scale = ((value: number): number => {
    sync();
    return lin(value);
  }) as ScaleBand;

  scale.invert = (pixel: number): number => {
    sync();
    const v = lin.invert(pixel);
    const n = slots();
    if (n === 0) return domain[0];
    // Snap to the nearest slot's centre, clamped to a real slot.
    const i = Math.min(n - 1, Math.max(0, Math.floor(v - domain[0])));
    return domain[0] + i + 0.5;
  };

  scale.ticks = (): number[] => {
    const n = slots();
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) out.push(domain[0] + i + 0.5);
    return out;
  };

  scale.bandwidth = (): number => {
    const n = slots();
    if (n === 0) return 0;
    return Math.abs((range[1] - range[0]) / n);
  };
  scale.step = scale.bandwidth;

  scale.label = (value: number): string => {
    const i = Math.floor(value - domain[0]);
    return i >= 0 && i < categories.length ? categories[i]! : '';
  };

  function domainFn(): [number, number];
  function domainFn(next: readonly [number, number]): ScaleBand;
  function domainFn(
    next?: readonly [number, number],
  ): [number, number] | ScaleBand {
    if (next === undefined) return [domain[0], domain[1]];
    domain = [next[0], next[1]];
    return scale;
  }
  scale.domain = domainFn;

  function rangeFn(): [number, number];
  function rangeFn(next: readonly [number, number]): ScaleBand;
  function rangeFn(
    next?: readonly [number, number],
  ): [number, number] | ScaleBand {
    if (next === undefined) return [range[0], range[1]];
    range = [next[0], next[1]];
    return scale;
  }
  scale.range = rangeFn;

  scale.copy = (): ScaleBand =>
    scaleBand(categories).domain(domain).range(range);

  return scale;
}
