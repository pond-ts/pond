import type { DiscontinuityProvider } from './tradingTimeScale.js';

/**
 * The logical tick ladder — grain selection for a time axis. Ticks sit on real
 * calendar/clock units (1s…30s, 1m…30m, 1H…12H, day / week / month / quarter /
 * year — the trading-terminal convention), never on even pixel spacing: the
 * axis walks the ladder finest→coarsest and picks the first grain whose anchor
 * count fits the width-derived cap. The same ladder serves a **disjoint
 * trading-calendar** axis (session opens are the day anchors, hour anchors are
 * generated in live time so they never land in a collapsed gap) and a **plain
 * continuous** axis (an identity provider whose "sessions" are calendar days).
 *
 * Each grain also knows its **boundary grain** — the next-coarser unit its own
 * label doesn't carry (hours → the date, days/weeks → the month, months →
 * the year). The axis renders that as a second label row, once per boundary
 * crossing, so a month row reads `Dec Jan Feb …` with `2026` appearing exactly
 * where the year turns — the **stacked** date style.
 *
 * The **flat** date style (the default, the TradingView look) drops the second
 * row: each tick that *opens* a coarser calendar period is relabelled **inline**
 * to that period — the year at a year turn, the month at a month turn, the date
 * at a day turn under an intraday grain — while every other tick keeps a terse
 * base label (bare day-of-month, month abbrev, clock time). {@link flatFormats}
 * computes the per-tick format specifiers for that single row.
 */

/** The calendar grain a run of tick anchors is bucketed to. */
export type TickGranularity =
  | 'second1'
  | 'second5'
  | 'second15'
  | 'second30'
  | 'minute1'
  | 'minute5'
  | 'minute15'
  | 'minute30'
  | 'hour1'
  | 'hour3'
  | 'hour6'
  | 'hour12'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year';

const SEC_MS = 1_000;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The sub-day rungs, finest first, with their clock step — the 1/5/15/30
 *  second and minute steps terminals use, then the hour steps. */
const SUB_DAY_GRAINS: ReadonlyArray<{ g: TickGranularity; step: number }> = [
  { g: 'second1', step: 1 * SEC_MS },
  { g: 'second5', step: 5 * SEC_MS },
  { g: 'second15', step: 15 * SEC_MS },
  { g: 'second30', step: 30 * SEC_MS },
  { g: 'minute1', step: 1 * MIN_MS },
  { g: 'minute5', step: 5 * MIN_MS },
  { g: 'minute15', step: 15 * MIN_MS },
  { g: 'minute30', step: 30 * MIN_MS },
  { g: 'hour1', step: 1 * HOUR_MS },
  { g: 'hour3', step: 3 * HOUR_MS },
  { g: 'hour6', step: 6 * HOUR_MS },
  { g: 'hour12', step: 12 * HOUR_MS },
];

/** Whether `g` is one of the sub-day (clock-step) rungs. */
function isSubDay(g: TickGranularity): boolean {
  return g !== 'day' && SUB_DAY_GRAINS.some((r) => r.g === g);
}

/**
 * The local-time bucket key for `t` at grain `g` — two instants in the same
 * day / week / month / quarter / year share a key. Local time (not UTC) so it
 * agrees with the local `scaleTime` label formatter; the exchange's own time
 * zone is unknown to the scale (the deferred refinement), and a session open
 * sits well inside its local day, so runtime-local grouping matches the
 * exchange day in every ordinary case. Hour grains are never bucketed (each
 * anchor is its own tick), so they key by identity.
 */
export function bucketKey(t: number, g: TickGranularity): number {
  if (isSubDay(g)) return t;
  const d = new Date(t);
  switch (g) {
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
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
    default:
      return t;
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
  'month',
  'quarter',
  'year',
];

/** Nominal days per month — sets the subdivision depth from the span-derived
 *  per-mark day budget (how many marks a month can afford). */
const DAYS_PER_MONTH = 30.44;

/** Deepest subdivision level: 2^6 = 64 > 31, so depth 6 saturates every month
 *  at every-day (the recursion stops on 1-day intervals anyway). */
const MAX_SUBDIV_DEPTH = 6;

/** Days in the local month containing `d`. */
function daysInLocalMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * The days-of-month marked at subdivision `depth` for a month of `monthLen`
 * days — **midpoint halving** of the [month start, next month start) interval:
 * depth 0 is just the 1st, and each deeper level adds the (floor) midpoint of
 * every existing gap, saturating at every day. So successive depths **nest**:
 * `dyadicDays(L, k) ⊆ dyadicDays(L, k+1)` — a zoom-in only inserts marks
 * between the ones already shown, never relocates them. Cached by
 * `(monthLen, depth)` — 4 month lengths × 7 depths.
 */
const dyadicCache = new Map<number, Set<number>>();
function dyadicDays(monthLen: number, depth: number): Set<number> {
  const key = monthLen * 8 + depth;
  let days = dyadicCache.get(key);
  if (days === undefined) {
    const set = new Set<number>([1]);
    const halve = (a: number, b: number, d: number): void => {
      if (d <= 0 || b - a <= 1) return;
      const mid = Math.floor((a + b) / 2);
      set.add(mid);
      halve(a, mid, d - 1);
      halve(mid, b, d - 1);
    };
    halve(1, monthLen + 1, depth);
    dyadicCache.set(key, set);
    days = set;
  }
  return days;
}

/**
 * Thin `opens` to the sessions on each month's {@link dyadicDays} at `depth` —
 * the TradingView subdivision behaviour. The month start is always level 0, so
 * month / year starts stay **pinned** at every zoom (promoted to `%b` / `%Y` by
 * {@link flatFormats}); deeper levels insert the midpoint, then the quarter
 * points, … between marks that never move. On a trading calendar a dyadic day
 * with no session (a weekend / holiday) **snaps to the next session**: an open
 * is marked when any dyadic day lies in `(previous session's date, its own
 * date]` — so `Feb 1` on a Sunday marks Monday the 2nd, exactly as month grain
 * would. Membership depends only on dates and `depth`, never the window, so a
 * pan cannot reshuffle the marks. (The window's first open has no known
 * predecessor and marks only on its own exact day — a snapped edge mark would
 * appear/disappear with the pan phase.)
 */
function subdivideMonths(opens: readonly number[], depth: number): number[] {
  const out: number[] = [];
  let prev: { month: number; dom: number } | null = null;
  for (const t of opens) {
    const d = new Date(t);
    const month = d.getFullYear() * 12 + d.getMonth();
    const dom = d.getDate();
    const days = dyadicDays(daysInLocalMonth(d), depth);
    // Scan window: same month → since the previous session's date; the first
    // session of a new month → from day 1 (a weekend month-start snaps here);
    // the window's first open → its own exact day only (see doc above).
    const from = prev === null ? dom - 1 : prev.month === month ? prev.dom : 0;
    prev = { month, dom };
    for (let g = from + 1; g <= dom; g++) {
      if (days.has(g)) {
        out.push(t);
        break;
      }
    }
  }
  return out;
}

/**
 * Thin an ascending run of **session opens** down to about `count` axis ticks.
 * Picks the finest rung: every session → **per-month midpoint subdivision**
 * (still day grain, month starts pinned) → month → quarter → year; beyond
 * yearly it decimates every-nth so the axis never crowds. Exported so the
 * container can draw session dividers at the same instants the axis labels.
 *
 * The day band **subdivides each month by midpoint halving** ({@link
 * dyadicDays}): depth 1 marks the month start + its midpoint (`May … 16 …
 * Jun`), depth 2 adds the quarter points (`May 8 16 24 Jun`), and so on down
 * to every day. Successive depths nest, so a zoom only inserts marks between
 * the ones already shown (or removes the in-between level) — the surviving
 * labels are the *same numbers* at every zoom, and month / year starts stay
 * pinned to their true instants. The depth comes from the span-derived
 * per-month budget (`spanDays / count`), constant at a fixed zoom, so a pan
 * never reshuffles the marks either. Two flat-spacing schemes were tried and
 * rejected: a global even day-stride can't pin month starts (the `Feb` label
 * drifted as zoom changed the stride), and `round(i·L/div)` division beats
 * against the month length (uneven 2-vs-3-day gaps) and doesn't nest across
 * zooms. There is deliberately no week rung: a Monday-anchored week has the
 * same can't-pin-the-month drift, so the day band owns everything between
 * every-session and month grain.
 *
 * `count` is a **cap**, not a target: coarser grains jump by 3–4× (month →
 * quarter → year), so a small fixed count over-coarsens long spans. Callers
 * size the cap to the room the labels have — the container derives it from plot
 * width — rather than passing a small constant. `spanDays` is the domain's
 * calendar-day span from the caller (stable at a fixed zoom); absent (a direct
 * call), it falls back to the opens' own span.
 *
 * This is the day-and-coarser half of the ladder; {@link buildTicks} adds the
 * sub-day rungs.
 */
export function coarsenCalendar(
  opens: readonly number[],
  count: number,
  spanDays?: number,
): { ticks: number[]; granularity: TickGranularity } {
  if (opens.length <= count) return { ticks: [...opens], granularity: 'day' };
  // Per-month midpoint subdivision. The depth is the deepest whose ≈2^depth
  // marks/month fit the span-derived budget (floor, so the density never
  // exceeds the width-derived cap; between doublings marks spread out, then
  // halve — the dyadic behaviour). Depth 0 means a month is down to one mark,
  // which *is* month grain — the bucket ladder below. Gated to daily-dense
  // opens: a synthetic run of month/year starts has no days to subdivide.
  const openSpanDays =
    (opens[opens.length - 1]! - opens[0]!) / DAY_MS || Infinity;
  const dailyDense = opens.length >= 0.5 * openSpanDays;
  const gapDays = (spanDays ?? openSpanDays) / count;
  const depth = Math.min(
    MAX_SUBDIV_DEPTH,
    Math.floor(Math.log2(DAYS_PER_MONTH / gapDays)),
  );
  if (dailyDense && depth >= 1) {
    const ticks = subdivideMonths(opens, depth);
    if (ticks.length > 0) return { ticks, granularity: 'day' };
  }
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

/** The first clock-aligned `stepMs` multiple at or after `t`, relative to `t`'s
 *  own local midnight — so a 3-hour step lands on 00:00 / 03:00 / 06:00 local,
 *  whatever the session open was. Fixed-ms stepping from midnight, so on a DST
 *  transition day the later anchors drift off the wall-clock grid by the shift
 *  (labels stay truthful — they format the real instant); exchange-tz grain is
 *  the already-deferred refinement. */
function nextAligned(t: number, stepMs: number): number {
  const d = new Date(t);
  const midnight = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
  ).getTime();
  return midnight + Math.ceil((t - midnight) / stepMs) * stepMs;
}

/**
 * The sub-day anchors at `stepMs`: each session open, plus each clock-aligned
 * step instant strictly inside that session's **live** span. (The caller may
 * still drop the very first anchor as a cramped lead — see {@link buildTicks}.) An instant is
 * in-session iff live distance-then-offset round-trips it — so a lunch-break
 * gap, an early close, or a collapsed overnight never gets an anchor, and no
 * new provider surface is needed. Bails once `cap` is exceeded (the caller
 * only needs to know the grain doesn't fit).
 */
function stepAnchors(
  provider: DiscontinuityProvider,
  opens: readonly number[],
  domainEnd: number,
  stepMs: number,
  cap: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i]!;
    const end = i + 1 < opens.length ? opens[i + 1]! : domainEnd;
    out.push(open);
    for (let t = nextAligned(open + 1, stepMs); t < end; t += stepMs) {
      if (provider.offset(open, provider.distance(open, t)) === t) {
        out.push(t);
        if (out.length > cap) return out;
      }
    }
  }
  return out;
}

/**
 * The full-ladder grain selection: given the provider, the domain, and the
 * width-derived `cap`, walk the clock rungs (1s … 30s, 1m … 30m, 1h … 12h)
 * then day (thinned by per-month midpoint subdivision) → month → quarter → year
 * (then decimate) and return the first rung that fits.
 * `opens` are the session-open anchors (`[domain start, ...boundaries]`) the
 * caller already has. Sub-day rungs are only reachable when the opens
 * themselves fit — a year of daily sessions never wastes time generating hour
 * anchors.
 */
export function buildTicks(
  provider: DiscontinuityProvider,
  opens: readonly number[],
  domainEnd: number,
  cap: number,
): { ticks: number[]; granularity: TickGranularity } {
  const result = ((): { ticks: number[]; granularity: TickGranularity } => {
    if (opens.length <= cap) {
      // Pick the clock rung from the **live-span estimate**, not the
      // enumerated anchor count. On a live chart the domain slides every
      // frame, and the number of aligned marks inside a sliding window
      // oscillates ±1 with its phase — an exact count sitting at the cap
      // flips the grain back and forth for single frames (the LiveSine
      // flicker). The span is constant while sliding, so the estimate is
      // stable; the enumerated count may then exceed the cap by a tick or
      // two at some phases, which the per-tick pixel budget absorbs.
      const liveSpan = provider.distance(opens[0]!, domainEnd);
      for (const { g, step } of SUB_DAY_GRAINS) {
        if (opens.length + Math.floor(liveSpan / step) > cap) continue;
        // The estimate can undercount the real anchor count by up to one
        // phase tick per session (each session's aligned marks can exceed
        // floor(sessionSpan/step) by one, and per-session floors sum below
        // the floor of the sum), so the enumeration budget must cover
        // cap + opens.length or a near-cap multi-session window truncates.
        // A truncated array must never be returned: it passes the
        // earns-its-labels check below while leaving the later sessions
        // with no ticks at all (a lopsided axis) — if the budget is still
        // exceeded (multiple live segments per session can add further
        // phase ticks), try the coarser rungs, whose smaller estimates
        // leave the budget room to finish.
        const budget = cap + opens.length + 4;
        const ticks = stepAnchors(provider, opens, domainEnd, step, budget);
        if (ticks.length > budget) continue;
        // A clock rung must earn its labels: if it adds no intraday anchor
        // beyond the opens themselves, it's really day grain (a row of
        // "09:30"s under every session is a worse day axis, not a clock
        // axis) — and every coarser rung would earn even less.
        if (ticks.length > opens.length) return { ticks, granularity: g };
        break;
      }
      return { ticks: [...opens], granularity: 'day' };
    }
    // Pass the domain's **calendar-day span** (wall time, domain start → end)
    // so the day-stride is picked from a quantity that's constant at a fixed
    // zoom — panning slides the window but never changes it, so the marks stay
    // put instead of reshuffling when the enumerated open count wobbles ±1.
    return coarsenCalendar(opens, cap, (domainEnd - opens[0]!) / DAY_MS);
  })();
  // Round anchors to integer milliseconds: a pan/zoom domain comes from
  // `scale.invert(pixel)` and is fractional, and a fractional anchor breaks
  // the label pipeline — formatters pass through `new Date(ms)`, which
  // truncates, so the instant no longer matches its own anchor set and the
  // label falls through to the d3 multi-scale default (a bare `.259`
  // millisecond tick). Sub-ms precision is invisible at any ladder grain.
  result.ticks = result.ticks.map((t) => Math.round(t));
  // Drop a cramped **leading partial-period** anchor: the first tick is the
  // domain start, which usually sits mid-period (a "1Y back from today" view
  // starts mid-month), so it can land arbitrarily close to the first full
  // period start and the two labels collide (the classic "Jun 23Jul 07"
  // pile-up). When the lead gap is under half a typical period (in **live**
  // time, so a collapsed weekend doesn't fake a gap), the partial anchor
  // isn't earning its label — the boundary row moves to the next tick.
  const t = result.ticks;
  if (
    t.length >= 3 &&
    provider.distance(t[0]!, t[1]!) < 0.5 * provider.distance(t[1]!, t[2]!)
  ) {
    t.shift();
  }
  return result;
}

/**
 * The **boundary grain** for ticks at grain `g` — the next-coarser unit a
 * tick's own label doesn't already carry, rendered as the axis's second label
 * row. Clock labels (`14:00`) need the date; day/week labels (`Feb 02`)
 * already carry the month, so they need only the year — as do month/quarter
 * labels (`Feb`); a year label already says everything.
 */
export function boundaryGrainFor(
  g: TickGranularity,
): TickGranularity | undefined {
  if (isSubDay(g)) return 'day';
  switch (g) {
    case 'day':
    case 'week':
    case 'month':
    case 'quarter':
      return 'year';
    default:
      return undefined;
  }
}

/** d3 time-format specifier for the **major** (first-row) label at grain `g`. */
export function majorFormatFor(g: TickGranularity): string {
  switch (g) {
    case 'second1':
    case 'second5':
    case 'second15':
    case 'second30':
      return '%H:%M:%S';
    case 'minute1':
    case 'minute5':
    case 'minute15':
    case 'minute30':
    case 'hour1':
    case 'hour3':
    case 'hour6':
    case 'hour12':
      return '%H:%M';
    case 'day':
    case 'week':
      return '%b %d';
    case 'month':
    case 'quarter':
      return '%b';
    case 'year':
      return '%Y';
  }
}

/** d3 time-format specifier for the **boundary** (second-row) label at the
 *  boundary grain `g` — a date under clock ticks, the bare year under
 *  everything else. Never repeat a unit the first row already shows
 *  (`Jan 2026` under a `Jan 05` tick reads as noise). */
export function boundaryFormatFor(g: TickGranularity): string {
  return g === 'day' ? '%b %d' : '%Y';
}

/**
 * Which of `ticks` (at grain `granularity`) carry a boundary label: every tick
 * whose boundary-grain bucket differs from the previous tick's — i.e. a
 * **crossing**, the first tick of a new day / year. The first tick is *not*
 * automatically flagged: the reader's left-edge context is the pinned
 * {@link TradingTimeScale.boundaryContext} label (a property of the domain
 * start, not of any tick — anchoring it to the first tick made it hop
 * tick-to-tick on a live sliding window). Empty when the grain has no
 * boundary row (year grain).
 */
export function boundaryTicks(
  ticks: readonly number[],
  granularity: TickGranularity,
  domainStart?: number,
): number[] {
  const bg = boundaryGrainFor(granularity);
  if (bg === undefined) return [];
  const out: number[] = [];
  // Seed with the domain start's bucket when given: a first tick in a
  // different period than the left edge IS a crossing (a 23:55-anchored
  // window whose cramped 23:55 lead was dropped still marks 00:00 as the
  // day turn); a first tick in the same period is not (no tick-hopping
  // context on a live window).
  let prev: number | undefined =
    domainStart !== undefined ? bucketKey(domainStart, bg) : undefined;
  for (const t of ticks) {
    const k = bucketKey(t, bg);
    if (prev !== undefined && k !== prev) out.push(t);
    prev = k;
  }
  return out;
}

/**
 * The calendar units a **flat**-style tick can be promoted to, coarsest first —
 * the levels coarser than a tick's own label that a single-row axis relabels an
 * opening tick to. A sub-day tick can open a date / month / year; a day or week
 * tick a month / year; a month or quarter tick a year; a year tick nothing.
 */
function flatPromotionLevels(g: TickGranularity): TickGranularity[] {
  if (isSubDay(g)) return ['year', 'month', 'day'];
  switch (g) {
    case 'day':
    case 'week':
      return ['year', 'month'];
    case 'month':
    case 'quarter':
      return ['year'];
    default:
      // 'year' (and, unreachably, the sub-day grains handled above).
      return [];
  }
}

/**
 * The terse **base** (non-promoted) flat label format for grain `g` — the label
 * a tick carries when it opens no coarser period: the clock time for a sub-day
 * grain, a bare day-of-month for day / week (`5`, not `Jan 5` — the month rides
 * the promoted month-start tick), the month abbrev for month / quarter, the
 * year for year. Terser than {@link majorFormatFor} (which carries the month on
 * every day tick) because the flat row leans on inline promotions for context.
 */
export function flatBaseFormatFor(g: TickGranularity): string {
  if (isSubDay(g)) {
    return g.startsWith('second') ? '%H:%M:%S' : '%H:%M';
  }
  switch (g) {
    case 'day':
    case 'week':
      return '%-d';
    case 'month':
    case 'quarter':
      return '%b';
    default:
      // 'year' (sub-day grains are handled by the isSubDay branch above).
      return '%Y';
  }
}

/**
 * The flat label format for a tick **promoted** to calendar level `level`. A
 * day turn keeps its month (`Jan 5`) so an intraday day boundary reads
 * unambiguously among clock ticks; a month turn shows the bare month, a year
 * turn the year. Only `day` / `month` / `year` are produced by
 * {@link flatPromotionLevels}; other levels fall back to their major format.
 */
function flatPromotionFormatFor(level: TickGranularity): string {
  switch (level) {
    case 'day':
      return '%b %-d';
    case 'month':
      return '%b';
    case 'year':
      return '%Y';
    default:
      return majorFormatFor(level);
  }
}

/**
 * The **flat** (single-row) label format specifier for each tick, parallel to
 * `ticks` (already at grain `granularity`). Each tick shows the coarsest
 * calendar period it *opens* — a year / month / date promotion — and its terse
 * {@link flatBaseFormatFor} label otherwise, so the one row reads
 * `… 30 31 Feb 2 3 …` with `Feb` where the month turns and the year where it
 * turns. A tick "opens" level L when its L-bucket differs from the previous
 * tick's; the coarsest changed level wins (a Jan-1 tick promotes to the year,
 * not the month).
 *
 * `domainStart` seeds the walk (like {@link boundaryTicks}): the first tick is
 * promoted only if it crosses a period relative to the instant just *before*
 * the domain's left edge — so a window opening mid-month doesn't falsely
 * promote its first tick (and a live sliding window doesn't flicker the
 * leftmost label), while a domain starting *exactly* on a boundary still
 * promotes the boundary tick (it truly is the period's first instant: a window
 * opening at May 1 midnight reads `May 16 …`, not `1 16 …`). Without
 * `domainStart` the first tick is never promoted.
 */
export function flatFormats(
  ticks: readonly number[],
  granularity: TickGranularity,
  domainStart?: number,
): string[] {
  const base = flatBaseFormatFor(granularity);
  const levels = flatPromotionLevels(granularity);
  // Last-seen bucket per level; seeded from just before the domain start so a
  // first tick sharing the edge's period isn't a crossing, but one exactly ON
  // the period boundary is.
  const prev = new Map<TickGranularity, number>();
  if (domainStart !== undefined) {
    for (const L of levels) prev.set(L, bucketKey(domainStart - 1, L));
  }
  return ticks.map((t) => {
    let spec = base;
    let promoted = false;
    for (const L of levels) {
      const k = bucketKey(t, L);
      // Coarsest changed level wins; still update every level's bucket so a
      // year turn (which also turns the month/day) leaves them all current.
      if (!promoted && prev.has(L) && prev.get(L) !== k) {
        spec = flatPromotionFormatFor(L);
        promoted = true;
      }
      prev.set(L, k);
    }
    return spec;
  });
}
