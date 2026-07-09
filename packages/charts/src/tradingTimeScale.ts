import { scaleTime } from 'd3-scale';

/**
 * The structural discontinuity-provider surface `scaleTradingTime` consumes to
 * collapse closed-market time. Charts declares this **shape** itself and never
 * imports `@pond-ts/financial` — a `TradingCalendar.discontinuities()` provider
 * satisfies it structurally, so the packages stay decoupled (trading-calendar
 * RFC §6.1). Domain values are epoch-milliseconds.
 */
export interface DiscontinuityProvider {
  /** A value in a removed gap → its next live instant; a live value unchanged. */
  clampUp(value: number): number;
  /** A value in a removed gap → its previous live instant; a live value unchanged. */
  clampDown(value: number): number;
  /** Signed live (non-gap) distance from `from` to `to`. */
  distance(from: number, to: number): number;
  /** Advance `value` by `amount` live-ms, skipping gaps (inverse of {@link distance}). */
  offset(value: number, amount: number): number;
  copy(): DiscontinuityProvider;
  /**
   * Optional: the domain positions of collapsed gaps strictly inside `(from,
   * to)` — session/day opens where closed time was removed. The container draws
   * a **session divider** at each; a provider that omits it just collapses the
   * axis silently. (A `TradingCalendar.discontinuities()` provider supplies it.)
   */
  boundaries?(from: number, to: number): number[];
}

/**
 * A d3-scale-shaped time scale whose pixel mapping runs through **trading time**
 * — closed-market gaps (weekends, holidays, overnight, lunch breaks) collapse to
 * nothing while time stays proportional within each session. Exposes the slice
 * of the d3 `ScaleTime` surface `@pond-ts/charts` actually uses, so it drops in
 * wherever the container's `xScale` goes.
 *
 * Ticks are evenly spaced in *trading* time (hence evenly spaced in pixels) —
 * the non-degenerate baseline; a calendar-aware nice-tick generator can override
 * `.ticks` at the container level. `tickFormat` delegates to a d3 `scaleTime` so
 * the multi-scale time format is unchanged.
 *
 * **Out-of-domain behavior.** Within the calendar the scale extrapolates like a
 * normal scale — a live instant *before* the domain start maps to a negative
 * pixel (so off-plot marks are still culled). Instants outside the calendar
 * entirely (before the first session / after the last) have no trading-time
 * position and **clamp** to the near edge rather than extrapolating into
 * meaningless space. In practice marks are always in-calendar, so this only
 * affects data beyond the calendar's absolute extremes.
 */
export interface TradingTimeScale {
  (value: number): number;
  invert(pixel: number): number;
  ticks(count?: number): number[];
  tickFormat(count?: number, specifier?: string): (date: Date) => string;
  domain(): [number, number];
  domain(next: readonly [number, number]): TradingTimeScale;
  range(): [number, number];
  range(next: readonly [number, number]): TradingTimeScale;
  copy(): TradingTimeScale;
}

/**
 * Build a {@link TradingTimeScale} over the given discontinuity `provider`.
 * Configure like a d3 scale: `scaleTradingTime(provider).domain([t0, t1]).range([0, width])`.
 */
export function scaleTradingTime(
  provider: DiscontinuityProvider,
): TradingTimeScale {
  let domain: [number, number] = [0, 1];
  let range: [number, number] = [0, 1];
  // A private d3 time scale, kept in sync with the domain, purely for tickFormat.
  const base = scaleTime();

  const totalLive = (): number => provider.distance(domain[0], domain[1]);

  const scale = ((value: number): number => {
    const live = totalLive();
    const span = range[1] - range[0];
    if (live === 0) return range[0];
    return range[0] + (provider.distance(domain[0], value) / live) * span;
  }) as TradingTimeScale;

  scale.invert = (pixel: number): number => {
    const span = range[1] - range[0];
    const frac = span === 0 ? 0 : (pixel - range[0]) / span;
    return provider.offset(domain[0], frac * totalLive());
  };

  scale.ticks = (count = 10): number[] => {
    const live = totalLive();
    if (live <= 0 || count < 1) return [domain[0]];
    // Interior ticks, evenly spaced in trading time (→ evenly spaced in pixels).
    // Endpoints are excluded so no tick sits exactly on the plot edge, matching
    // how a d3 time axis places ticks inside the domain.
    const out: number[] = [];
    for (let i = 1; i < count; i++) {
      out.push(provider.offset(domain[0], (i / count) * live));
    }
    return out;
  };

  scale.tickFormat = (count = 10, specifier?: string) =>
    // d3's multi-scale time format is domain-independent, so `base` needs no
    // domain sync — it exists only to borrow d3's formatter.
    specifier !== undefined
      ? base.tickFormat(count, specifier)
      : base.tickFormat(count);

  function domainFn(): [number, number];
  function domainFn(next: readonly [number, number]): TradingTimeScale;
  function domainFn(
    next?: readonly [number, number],
  ): [number, number] | TradingTimeScale {
    if (next === undefined) return [domain[0], domain[1]];
    domain = [next[0], next[1]];
    return scale;
  }
  scale.domain = domainFn;

  function rangeFn(): [number, number];
  function rangeFn(next: readonly [number, number]): TradingTimeScale;
  function rangeFn(
    next?: readonly [number, number],
  ): [number, number] | TradingTimeScale {
    if (next === undefined) return [range[0], range[1]];
    range = [next[0], next[1]];
    return scale;
  }
  scale.range = rangeFn;

  scale.copy = (): TradingTimeScale =>
    scaleTradingTime(provider.copy()).domain(domain).range(range);

  return scale;
}
