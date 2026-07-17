import { scaleTime } from 'd3-scale';
import {
  bandFormatFor,
  bandGrainFor,
  bandNext,
  bandShaded,
  bandStartOf,
  boundaryFormatFor,
  boundaryGrainFor,
  boundaryTicks,
  buildGridLevels,
  buildTicks,
  flatBaseFormatFor,
  flatFormats,
  majorFormatFor,
  nominalStepMs,
  readoutFormatFor,
  type TickGranularity,
} from './tickLadder.js';

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
   * Optional: the **session roster** strictly inside `(from, to)` — each
   * session/day open, in ascending order. Consumed two ways: the tick ladder
   * and the calendar grid treat every entry as a **date anchor** (so a
   * provider whose sessions are contiguous — the gap-free identity provider,
   * a full-day-sessions demo — still reports every open); the container's
   * **session dividers** draw only at the entries that are true collapse
   * *seams* (removed time immediately precedes them — detected via
   * {@link distance}), which on a real exchange calendar is all of them.
   * A provider that omits this just collapses the axis silently. (A
   * `TradingCalendar.discontinuities()` provider supplies it.)
   */
  boundaries?(from: number, to: number): number[];
}

/**
 * The high-level counterpart to a bare {@link DiscontinuityProvider}: anything
 * that can *produce* one from an optional `spacing` choice. A
 * `@pond-ts/financial` `TradingCalendar` satisfies this structurally (its
 * `discontinuities` accepts a superset of these options), so a consumer can
 * hand `<ChartContainer calendar={cal} spacing="uniform" />` instead of calling
 * `cal.discontinuities({ spacing })` themselves — and charts still never imports
 * the financial package (RFC §6.1). For the full option matrix (a bar `period`,
 * a scoped `range`) build the provider yourself and pass the low-level
 * `discontinuities` prop.
 */
export interface TradingCalendarLike {
  discontinuities(options?: {
    spacing?: 'proportional' | 'uniform';
  }): DiscontinuityProvider;
}

/**
 * A d3-scale-shaped time scale whose pixel mapping runs through **trading time**
 * — closed-market gaps (weekends, holidays, overnight, lunch breaks) collapse to
 * nothing while time stays proportional within each session. Exposes the slice
 * of the d3 `ScaleTime` surface `@pond-ts/charts` actually uses, so it drops in
 * wherever the container's `xScale` goes.
 *
 * Ticks are **calendar-aware** when the provider enumerates its gaps: `.ticks`
 * walks the logical ladder (hour1 → hour3 → hour6 → hour12 → day → month →
 * quarter → year; the day rung also thins by per-month midpoint subdivision before
 * month grain) and returns the finest rung that fits `count`, and
 * `.tickFormat` labels each anchor at that grain (`%H:%M` for hours, `%b %d`
 * for days/weeks, `%b` for months/quarters, `%Y` for years) while formatting
 * any other instant with the d3 multi-scale default (the cursor readout uses
 * `.readoutFormat`, a grain-aware date/clock format, not this). The
 * coarser context a label drops lives on `.tickBoundaries` — the second-row
 * boundary labels of the **stacked** date style (the date over a clock axis,
 * the year over a day / week / month axis), one per boundary crossing plus the
 * first tick. `.flatFormat` is the **flat** (default) alternative: that context
 * promoted inline into a single row, the TradingView look.
 * Without a provider `boundaries` method it falls back to interior even-spaced
 * time ticks.
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
  /**
   * The **second-row** (boundary) label for a tick value, or `undefined` for
   * ticks that don't open a new boundary period. Same grain selection as
   * {@link ticks} at the same `count`, so the rows agree: each tick starting
   * a new day / year (whichever is the next-coarser unit the first-row label
   * omits) carries the label — a **crossing**. The left-edge context (what
   * period the domain starts in) is {@link boundaryContext}, pinned by the
   * axis rather than riding a tick; year-grain ticks have no second row.
   */
  tickBoundaries(count?: number): (value: number) => string | undefined;
  /**
   * **Flat**-style single-row labels: the coarsest calendar unit each tick
   * opens (year / month / date) promoted **inline** into the one row, its terse
   * base label (bare day-of-month, month abbrev, clock time) otherwise — the
   * TradingView default axis, the alternative to the two-row {@link tickFormat}
   * + {@link tickBoundaries} stack. Same grain selection as {@link ticks} at the
   * same `count`, so the labels sit on the tick instants. A non-tick value
   * formats with the d3 multi-scale default, like {@link tickFormat}; the
   * cursor readout itself uses {@link readoutFormat} (grain-aware), so ticks
   * read terse while the crosshair reads an unambiguous date/clock.
   */
  flatFormat(count?: number): (value: number) => string;
  /**
   * The boundary-row label for the **domain start** — the reader's left-edge
   * context (`Jan 01` over an intraday axis, the year over a month axis),
   * rendered pinned at the plot's left edge. A property of the domain, not of
   * any tick — so it stays put on a live sliding window instead of hopping
   * from tick to tick. `undefined` when the grain has no boundary row.
   */
  boundaryContext(count?: number): string | undefined;
  /**
   * The **grid populations** — one level per ladder rung that fits the plot,
   * finest first, each carrying its FULL anchor population in the domain
   * (every aligned clock instant / session open / month / quarter / year
   * start, strictly after the domain start — the window's left edge is not a
   * calendar boundary). Where {@link ticks} thins one rung down to *labels*,
   * these are the calendar structure the labels sit on: the container draws
   * every anchor and fades each level as a unit by its `spacing`, so a
   * crowding level dissolves while the coarser ones persist (the map-style
   * hierarchical grid). Levels nest — de-duplicate coarsest-first.
   *
   * `spacing` is the level's **nominal** spacing in px — `width × the grain's
   * wall-clock step / the domain's wall span` — i.e. its spacing on a gap-free
   * axis. Keying the fade off calendar density rather than the measured
   * on-screen gaps makes the look **mode-invariant**: collapsing weekends
   * draws fewer day lines at the same strength, instead of wider-spaced day
   * lines that jump to full opacity at the same zoom.
   *
   * `minGapPx` is the spacing at which a level's lines have fully faded; a
   * level denser than that is omitted outright. Empty without a calendar
   * (a provider that can't enumerate `boundaries`).
   */
  gridLevels(minGapPx?: number): Array<{
    granularity: TickGranularity;
    values: number[];
    spacing: number;
  }>;
  /**
   * The **terse base** label for each tick — the grain's bare unit with **no**
   * inline promotion (`14:00`, `12`, `Feb`, `2026`), the top row of the
   * **stacked band** date style. Same anchor set as {@link ticks}; a non-tick
   * instant (the cursor) falls through to the d3 multi-scale default. This is
   * `flatFormat` without the promotions — the coarser context lives in the
   * band row ({@link bands}) instead of inline.
   */
  baseFormat(count?: number): (value: number) => string;
  /**
   * The **cursor / marker readout** formatter — a hovered instant formatted at
   * the axis's own grain, never finer (a day-or-coarser axis reads a **date**,
   * so a daily bar at a foreign-tz midnight never renders as a time-of-day like
   * `02 AM`; a sub-day axis reads date **+** clock). This is the grain-aware
   * default the crosshair pill, marker indicators, and annotation auto-labels
   * use — replacing d3's multi-scale default, which showed local time-of-day
   * for any off-local-midnight instant. A container `cursorFormat` overrides it.
   */
  readoutFormat(count?: number): (value: number) => string;
  /**
   * The **date bands** — the segmented second row of the stacked style. One
   * entry per next-coarser calendar period touching the domain (day bands
   * under intraday ticks, month bands under day ticks, year bands under
   * month/quarter ticks), each `{ start, label, shaded }`: the period's start
   * instant (the first band's `start` may precede the domain — its label pins
   * at the left edge), the left-aligned label, and a stable zebra `shaded`
   * flag keyed to the band's calendar identity (pan/zoom-invariant). The
   * renderer draws a divider at each interior `start`, fills shaded bands, and
   * emphasizes the top-row tick sitting at each `start`. Empty at year grain
   * (nothing coarser to band) and without a calendar provider.
   */
  bands(
    count?: number,
  ): Array<{ start: number; label: string; shaded: boolean }>;
  domain(): [number, number];
  domain(next: readonly [number, number]): TradingTimeScale;
  range(): [number, number];
  range(next: readonly [number, number]): TradingTimeScale;
  copy(): TradingTimeScale;
}

// Grain selection lives in `tickLadder.ts` (the full hour1…year ladder plus
// the boundary-row helpers); re-exported here so existing imports keep working.
export { coarsenCalendar } from './tickLadder.js';
export type { TickGranularity } from './tickLadder.js';

/**
 * The trivial gap-free {@link DiscontinuityProvider}: live time **is** wall
 * time, and every local midnight is a "session open". Backing a plain
 * continuous time axis with `scaleTradingTime(identityProvider())` runs it
 * through the same logical tick ladder as a trading-calendar axis — calendar
 * days are the day anchors, so a year of data ticks on month starts and an
 * afternoon ticks on clock-aligned hours, instead of d3's mixed multi-scale
 * default.
 */
export function identityProvider(): DiscontinuityProvider {
  const self: DiscontinuityProvider = {
    clampUp: (t) => t,
    clampDown: (t) => t,
    distance: (from, to) => to - from,
    offset: (v, amount) => v + amount,
    copy: () => self,
    boundaries: (from, to) => {
      const out: number[] = [];
      const d = new Date(from);
      // First local midnight strictly after `from`; step by calendar day (not
      // 24h) so DST transitions stay on midnight.
      let cur = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      while (cur.getTime() < to) {
        if (cur.getTime() > from) out.push(cur.getTime());
        cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      }
      return out;
    },
  };
  return self;
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
   *  left edge) plus each collapsed-gap boundary — the axis's date anchors.
   *  Memoized per domain: both the label ladder ({@link resolved}) and the
   *  grid populations ({@link TradingTimeScale.gridLevels}) walk these every
   *  frame of a pan, and on a wide continuous domain the enumeration (one
   *  Date per day) is the expensive part. */
  let opensMemo: { key: string; value: number[] } | null = null;
  const sessionOpens = (): number[] => {
    const key = `${domain[0]}:${domain[1]}`;
    if (opensMemo?.key !== key) {
      const bounds = provider.boundaries?.(domain[0], domain[1]) ?? [];
      opensMemo = { key, value: [domain[0], ...bounds] };
    }
    return opensMemo.value;
  };

  /** Whether the provider has calendar structure to ladder on. Without a
   *  `boundaries` method there are no anchors — the even-spacing fallback. */
  const hasCalendar = (): boolean => provider.boundaries !== undefined;

  /** The ladder result for this domain at `count` — the single source `ticks`,
   *  `tickFormat`, and `tickBoundaries` all derive from, so the three agree.
   *  Memoized on `(domain, count)`: the three callers (plus gridlines /
   *  dividers) hit the same resolution per render, and on a wide continuous
   *  domain re-walking every day-open is the expensive part. */
  let laddered: {
    key: string;
    value: { ticks: number[]; granularity: TickGranularity };
  } | null = null;
  const resolved = (count: number) => {
    const key = `${domain[0]}:${domain[1]}:${count}`;
    if (laddered?.key !== key) {
      laddered = {
        key,
        value: buildTicks(provider, sessionOpens(), domain[1], count),
      };
    }
    return laddered.value;
  };

  scale.ticks = (count = 10): number[] => {
    const live = totalLive();
    if (live <= 0 || count < 1) return [domain[0]];
    // Calendar-aware: walk the logical ladder over the session-open anchors
    // (hour steps inside sessions, then day / week / month / quarter / year
    // starts) — the trading-terminal look, never an arbitrary every-nth.
    if (hasCalendar()) return resolved(count).ticks;
    // No boundaries (no calendar structure at all): fall back to interior
    // even-spaced ticks — endpoints excluded so none sits on the plot edge.
    const out: number[] = [];
    for (let i = 1; i < count; i++) {
      out.push(provider.offset(domain[0], (i / count) * live));
    }
    return out;
  };

  scale.tickFormat = (count = 10, specifier?: string) => {
    if (specifier !== undefined) return base.tickFormat(count, specifier);
    const defFmt = base.tickFormat(count);
    if (!hasCalendar()) return defFmt; // no calendar → d3 multi-scale default
    // Anchor labels at the grain {@link ticks} chose — one uniform format per
    // grain (hours as `%H:%M`, days/weeks as `%b %d`, months/quarters as `%b`,
    // years as `%Y`); the coarser context the label omits is the second row
    // ({@link tickBoundaries}). Any other instant — a cursor readout — uses
    // the d3 multi-scale default. Same grain as {@link ticks}, so labels and
    // the dividers drawn at these instants agree.
    const { ticks, granularity } = resolved(count);
    const anchors = new Set(ticks);
    const anchorFmt = base.tickFormat(count, majorFormatFor(granularity));
    return (d: Date) => (anchors.has(+d) ? anchorFmt(d) : defFmt(d));
  };

  scale.tickBoundaries = (count = 10) => {
    if (!hasCalendar()) return () => undefined;
    const { ticks, granularity } = resolved(count);
    const bg = boundaryGrainFor(granularity);
    if (bg === undefined) return () => undefined;
    const fmt = base.tickFormat(count, boundaryFormatFor(bg));
    const labelled = new Map<number, string>();
    for (const t of boundaryTicks(ticks, granularity, domain[0])) {
      labelled.set(t, fmt(new Date(t)));
    }
    return (value: number) => labelled.get(value);
  };

  scale.flatFormat = (count = 10) => {
    // A non-tick instant always uses the d3 multi-scale default — same as
    // tickFormat. (The cursor readout doesn't route through here; it uses
    // readoutFormat, grain-aware.) Without a calendar there are no ladder
    // anchors, so every value falls through to the default.
    const defFmt = base.tickFormat(count);
    if (!hasCalendar()) return (value: number) => defFmt(new Date(value));
    const { ticks, granularity } = resolved(count);
    // Seed the promotion walk from the previous **live** instant before the
    // domain start (clampDown; identity on a continuous axis): a domain that
    // opens exactly on a month's first session then promotes that tick to the
    // month (`apr 8 14 …`, not `1 8 14 …`) — the previous session was in
    // March — while a mid-session start still suppresses the false promotion.
    const specs = flatFormats(
      ticks,
      granularity,
      provider.clampDown(domain[0] - 1),
    );
    // One d3 formatter per distinct specifier; most ticks share the base one.
    const bySpec = new Map<string, (d: Date) => string>();
    const fmtFor = (spec: string) => {
      let f = bySpec.get(spec);
      if (f === undefined) {
        f = base.tickFormat(count, spec);
        bySpec.set(spec, f);
      }
      return f;
    };
    const labelled = new Map<number, string>();
    ticks.forEach((t, i) => labelled.set(t, fmtFor(specs[i]!)(new Date(t))));
    return (value: number) => labelled.get(value) ?? defFmt(new Date(value));
  };

  scale.baseFormat = (count = 10) => {
    // The terse top row of the stacked band style: the grain's bare unit, no
    // inline promotion (that context lives in the band row). Anchors get the
    // grain's flat base format; a non-tick instant (the cursor) reads the d3
    // multi-scale default, so the crosshair still shows a full timestamp.
    const defFmt = base.tickFormat(count);
    if (!hasCalendar()) return (value: number) => defFmt(new Date(value));
    const { ticks, granularity } = resolved(count);
    const anchors = new Set(ticks);
    const terse = base.tickFormat(count, flatBaseFormatFor(granularity));
    return (value: number) =>
      anchors.has(value) ? terse(new Date(value)) : defFmt(new Date(value));
  };

  scale.readoutFormat = (count = 10) => {
    const defFmt = base.tickFormat(count);
    if (!hasCalendar()) return (value: number) => defFmt(new Date(value));
    const fmt = base.tickFormat(
      count,
      readoutFormatFor(resolved(count).granularity),
    );
    return (value: number) => fmt(new Date(value));
  };

  scale.bands = (count = 10) => {
    if (!hasCalendar()) return [];
    const bg = bandGrainFor(resolved(count).granularity);
    if (bg === undefined) return []; // year grain — nothing coarser to band
    const fmt = base.tickFormat(count, bandFormatFor(bg));
    const out: Array<{ start: number; label: string; shaded: boolean }> = [];
    // First band starts at (or before) the domain start — the partial left
    // band whose label the renderer pins at x=0; step to each next period
    // start still inside the domain. Bounded loop as a runaway guard.
    let s = bandStartOf(domain[0], bg);
    for (let i = 0; i < 100_000 && s < domain[1]; i++) {
      out.push({
        start: s,
        label: fmt(new Date(s)),
        shaded: bandShaded(s, bg),
      });
      s = bandNext(s, bg);
    }
    return out;
  };

  scale.boundaryContext = (count = 10) => {
    if (!hasCalendar()) return undefined;
    const { granularity } = resolved(count);
    const bg = boundaryGrainFor(granularity);
    if (bg === undefined) return undefined;
    const fmt = base.tickFormat(count, boundaryFormatFor(bg));
    return fmt(new Date(domain[0]));
  };

  /** Memoized like {@link resolved}: the draw pass asks once per frame, and
   *  the populations only change with the domain / width / fade floor. */
  let gridMemo: {
    key: string;
    value: Array<{
      granularity: TickGranularity;
      values: number[];
      spacing: number;
    }>;
  } | null = null;
  scale.gridLevels = (minGapPx = 4) => {
    if (!hasCalendar()) return [];
    const width = Math.abs(range[1] - range[0]);
    const wallSpan = domain[1] - domain[0];
    if (wallSpan <= 0 || width <= 0) return [];
    const cap = Math.max(1, Math.floor(width / Math.max(1, minGapPx)));
    const key = `${domain[0]}:${domain[1]}:${width}:${minGapPx}`;
    if (gridMemo?.key !== key) {
      gridMemo = {
        key,
        value: buildGridLevels(provider, sessionOpens(), domain[1], cap)
          .map((l) => ({
            granularity: l.granularity,
            // The first open is the domain start itself — a window edge, not
            // a boundary (and mid-period in general). Grid lines are the
            // strictly-interior anchors.
            values: l.values.filter((v) => v > domain[0]),
            // Nominal (gap-free) spacing — the fade metric; see the
            // interface doc for why it isn't the measured on-screen gap.
            spacing: (width * nominalStepMs(l.granularity)) / wallSpan,
          }))
          .filter((l) => l.values.length > 0 && l.spacing > minGapPx),
      };
    }
    return gridMemo.value;
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
