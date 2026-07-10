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
 * Ticks are **calendar-aware** when the provider enumerates its gaps: `.ticks`
 * returns the session opens thinned to a calendar grain (week / month / year
 * starts, whichever fits ~`count`), and `.tickFormat` labels each anchor with a
 * **date** (`%b %d`) — or the **year** (`%Y`) when ticks are a year apart —
 * while formatting any other instant (a mid-session tick, the cursor readout)
 * with the d3 multi-scale default. Without a provider `boundaries` method it
 * falls back to interior even-spaced time ticks.
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

/** The calendar grain a run of session opens is bucketed to for axis ticks. */
type TickGranularity = 'session' | 'week' | 'month' | 'quarter' | 'year';

/**
 * The local-time bucket key for `t` at grain `g` — two instants in the same
 * week / month / quarter / year share a key. Local time (not UTC) so it agrees
 * with the local `scaleTime` label formatter; the exchange's own time zone is
 * unknown to the scale (the deferred refinement), and a session open sits well
 * inside its local day, so runtime-local grouping matches the exchange day in
 * every ordinary case.
 */
function bucketKey(t: number, g: TickGranularity): number {
  if (g === 'session') return t; // every open its own bucket
  const d = new Date(t);
  switch (g) {
    case 'week': {
      const dow = (d.getDay() + 6) % 7; // 0 = Monday
      // Local midnight of this week's Monday (Date normalizes a negative date).
      return new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate() - dow,
      ).getTime();
    }
    case 'month':
      return d.getFullYear() * 12 + d.getMonth();
    case 'quarter':
      return d.getFullYear() * 4 + Math.floor(d.getMonth() / 3);
    case 'year':
      return d.getFullYear();
  }
}

/** The first instant of each distinct `g`-bucket in the ascending list `opens`. */
function firstOfEachBucket(
  opens: readonly number[],
  g: TickGranularity,
): number[] {
  const out: number[] = [];
  let prev: number | undefined;
  for (const t of opens) {
    const k = bucketKey(t, g);
    if (k !== prev) {
      out.push(t);
      prev = k;
    }
  }
  return out;
}

const COARSENING_LADDER: readonly TickGranularity[] = [
  'week',
  'month',
  'quarter',
  'year',
];

/**
 * Thin an ascending run of **session opens** down to about `count` axis ticks by
 * **calendar grain** — the trading-terminal habit of labelling week / month /
 * year starts rather than an arbitrary every-nth session. Picks the finest grain
 * on the ladder (session → week → month → quarter → year) that yields at most
 * `count` buckets and returns the first open in each; beyond yearly it decimates
 * every-nth so the axis never crowds. Exported so the container can draw session
 * dividers at the same instants the axis labels.
 */
export function coarsenCalendar(
  opens: readonly number[],
  count: number,
): { ticks: number[]; granularity: TickGranularity } {
  if (opens.length <= count)
    return { ticks: [...opens], granularity: 'session' };
  for (const g of COARSENING_LADDER) {
    const ticks = firstOfEachBucket(opens, g);
    if (ticks.length <= count) return { ticks, granularity: g };
  }
  // Coarser than yearly isn't a calendar grain — decimate the year starts.
  const yearly = firstOfEachBucket(opens, 'year');
  const step = Math.ceil(yearly.length / count);
  return {
    ticks: yearly.filter((_, i) => i % step === 0),
    granularity: 'year',
  };
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

  /** The session-open instants in the domain — the first session's open (the
   *  left edge) plus each collapsed-gap boundary — the axis's date anchors. */
  const sessionOpens = (): number[] => {
    const bounds = provider.boundaries?.(domain[0], domain[1]) ?? [];
    return [domain[0], ...bounds];
  };

  scale.ticks = (count = 10): number[] => {
    const live = totalLive();
    if (live <= 0 || count < 1) return [domain[0]];
    const opens = sessionOpens();
    // Calendar-aware: label the session opens (each a new day), thinned to
    // week / month / year starts by grain rather than an arbitrary every-nth
    // session — the trading-terminal look.
    if (opens.length > 1) return coarsenCalendar(opens, count).ticks;
    // No boundaries (a single session / no calendar): fall back to interior
    // even-spaced ticks — endpoints excluded so none sits on the plot edge.
    const out: number[] = [];
    for (let i = 1; i < count; i++) {
      out.push(provider.offset(domain[0], (i / count) * live));
    }
    return out;
  };

  scale.tickFormat = (count = 10, specifier?: string) => {
    if (specifier !== undefined) return base.tickFormat(count, specifier);
    const opens = sessionOpens();
    const defFmt = base.tickFormat(count);
    if (opens.length <= 1) return defFmt; // no calendar → d3 multi-scale default
    // Anchor label at each coarsened session-open tick: a **date** (`%b %d`), or
    // the **year** when ticks are a year apart (a plain date would drop the year
    // the reader needs). Any other instant — a cursor readout — uses the d3
    // multi-scale default. Same grain as {@link ticks}, so labels and the
    // dividers drawn at these instants agree.
    const { ticks, granularity } = coarsenCalendar(opens, count);
    const anchors = new Set(ticks);
    const anchorFmt = base.tickFormat(
      count,
      granularity === 'year' ? '%Y' : '%b %d',
    );
    return (d: Date) => (anchors.has(+d) ? anchorFmt(d) : defFmt(d));
  };

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
