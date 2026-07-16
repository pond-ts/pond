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

/** Nominal days per month — the band gate: the session-stride band applies
 *  while a nominal month still affords ≥ 2 marks at the span-derived budget. */
const DAYS_PER_MONTH = 30.44;

/** Days in the local month containing `d`. */
function daysInLocalMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * Whether index `i` marks in a month of `n` sessions/days at stride `k`. Two
 * regimes, split on `m = floor(n / k)` — the whole stride-intervals the month
 * affords:
 *
 * - **`m ≥ 4` (dense): anchored stride** — the month start (index 0), then
 *   every `k`-th index, stopping so the gap to the next month start stays
 *   ≥ `k` (slack at the month end, never a cramped tick before the month
 *   label). This is the decoded TradingView rule, validated label-for-label
 *   against owner-supplied 2026 captures: `apr | 8 14 20 24 | may` is session
 *   indices `0 4 8 12 16` of April's 21 sessions at stride 4, index 20
 *   dropped because `may` would sit only 1 session away.
 * - **`m ≤ 3` (coarse): balanced division** — marks at `round(j·n/m)`. An
 *   anchored stride here leaves a hole of up to ~2k before the next month
 *   (the `Mar 9 17 ……… Apr` look), and each ±1 stride change relabels every
 *   mark even though density barely moves (the 9/17 → 10/19 → 11/21 crawl).
 *   Division splits the month into near-equal parts (gaps differ ≤ 1), and —
 *   since the marks depend only on `(n, m)` — they hold still across the
 *   whole stride range that maps to one `m`: mid-month, then thirds, exactly
 *   the coarse-zoom look the anchored data converges to as it densifies.
 */
function monthMark(i: number, k: number, n: number): boolean {
  const m = Math.floor(n / k);
  if (m <= 1) return i === 0;
  if (m <= 3) {
    for (let j = 0; j < m; j++) {
      if (Math.round((j * n) / m) === i) return true;
    }
    return false;
  }
  return i === 0 || (i % k === 0 && i <= n - k);
}

/**
 * Day-of-month subdivision — the **no-provider fallback** for direct
 * {@link coarsenCalendar} calls: each month's marks land on calendar days at
 * a uniform `ceil(gapDays)` stride from the 1st (day `1` = index 0), under
 * the identity assumption that every calendar day is a session (where
 * day-space and session-space coincide). A stride day with no open in the
 * list **snaps to the next open**: a mark is taken when any stride day lies
 * in `(previous open's date, own date]`. Membership depends only on dates and
 * the span-derived stride, so a pan cannot reshuffle the marks. (The window's
 * first open has no known predecessor and marks only on its own exact day — a
 * snapped edge mark would appear/disappear with the pan phase.)
 */
function subdivideMonthsByDay(
  opens: readonly number[],
  gapDays: number,
): number[] {
  const k = Math.max(2, Math.ceil(gapDays - 1e-9));
  const out: number[] = [];
  let prev: { month: number; dom: number } | null = null;
  for (const t of opens) {
    const d = new Date(t);
    const month = d.getFullYear() * 12 + d.getMonth();
    const dom = d.getDate();
    const monthLen = daysInLocalMonth(d);
    // Scan window: same month → since the previous open's date; the first
    // open of a new month → from day 1 (a weekend month-start snaps here);
    // the window's first open → its own exact day only (see doc above).
    const from = prev === null ? dom - 1 : prev.month === month ? prev.dom : 0;
    prev = { month, dom };
    for (let g = from + 1; g <= dom; g++) {
      if (monthMark(g - 1, k, monthLen)) {
        out.push(t);
        break;
      }
    }
  }
  return out;
}

/**
 * **Session-index** subdivision — the decoded TradingView algorithm, used
 * whenever the provider can enumerate the calendar. Each month's sessions are
 * indexed `0…M−1` from the month's first session, and marks land on a
 * **uniform integer stride** of those indices ({@link monthMark}: the month
 * start, then every `k`-th session, truncated so the gap to the next month
 * start stays ≥ `k`). Marks therefore sit an equal number of *bars* apart —
 * evenly spaced pixels on a collapsed (and especially a uniform) trading axis
 * — with the slack at the month **end**, and no weekend/holiday snapping at
 * all: non-sessions simply aren't indices, and a month whose 1st is a Sunday
 * anchors on Monday-the-2nd (index 0). Validated label-for-label against
 * owner-supplied TradingView captures (Feb/Apr/May 2026, NYSE calendar) at
 * strides 4, 3, and 2.
 *
 * The stride is per-month — `ceil(gapDays / (extentDays/M))`, i.e. the
 * span-derived day budget divided by the month's own days-per-session — so a
 * full month lands on the global density while a stub month (the live edge, a
 * fixture that ends mid-month) earns proportionally fewer marks. Zooming
 * steps the stride through the integers (…4 → 3 → 2 → 1), re-labelling some
 * interior marks at each step (strides don't nest; the deliberate trade,
 * owner-confirmed 2026-07-16 after their own TradingView samples showed the
 * same: month anchors never move and density shifts by ~one bar, so it
 * doesn't read as flicker — unlike the dyadic halving this replaces, which
 * nested perfectly but stepped density 2× and wobbled ±1 day inside non-power
 * months). Panning never reshuffles anything: rosters are queried over each
 * **full calendar month** (`boundaries(monthStart−1ms, nextMonthStart)`), so
 * an index is a property of the calendar, never of the window.
 *
 * The window's left edge (`opens[0]`) is indexed via point queries: the count
 * of its month's sessions opening strictly before it, and whether it is
 * itself exactly a session open — only then is it markable (a mid-gap edge
 * has no honest index and would ride the pan). A calendar's **absolute
 * start** — whose first session follows no collapsed gap, so some providers
 * never report it — is detected by live-time flow and indexed 0, keeping the
 * world-start month pinned.
 */
function subdivideMonthsBySession(
  opens: readonly number[],
  gapDays: number,
  provider: DiscontinuityProvider,
): number[] {
  const monthKeyOf = (t: number): number => {
    const d = new Date(t);
    return d.getFullYear() * 12 + d.getMonth();
  };
  const monthStartOf = (key: number): number =>
    new Date(Math.floor(key / 12), key % 12, 1).getTime();
  const strideOf = (count: number, extentDays: number): number =>
    Math.max(2, Math.ceil((gapDays * count) / Math.max(1, extentDays) - 1e-9));
  // Full-month roster: session count + the per-month stride its calendar-day
  // extent affords. Cached per call; ≤ (visible months + 1) provider queries,
  // and the whole resolution is memoized upstream per (domain, count).
  const rosters = new Map<number, { count: number; stride: number }>();
  const rosterOf = (key: number): { count: number; stride: number } => {
    let r = rosters.get(key);
    if (r === undefined) {
      const sessions = provider.boundaries!(
        monthStartOf(key) - 1,
        monthStartOf(key + 1),
      );
      const count = Math.max(1, sessions.length);
      const extentDays =
        sessions.length === 0
          ? 0
          : new Date(sessions[sessions.length - 1]!).getDate() -
            new Date(sessions[0]!).getDate() +
            1;
      r = { count, stride: strideOf(count, extentDays) };
      rosters.set(key, r);
    }
    return r;
  };
  const out: number[] = [];
  let curKey = -1;
  let idx = 0;
  for (let i = 0; i < opens.length; i++) {
    const t = opens[i]!;
    const key = monthKeyOf(t);
    if (i === 0) {
      // Index the window's left edge within its month (see doc above).
      curKey = key;
      const monthStart = monthStartOf(key);
      const sessions = provider.boundaries!(
        monthStart - 1,
        monthStartOf(key + 1),
      );
      const pre = provider.boundaries!(monthStart - 1, t).length;
      const exact = provider.boundaries!(t - 1, t + 1).length > 0;
      // The calendar's absolute start (see doc above): unreported by the
      // roster, detected by live-time flow — it is the month's session 0.
      const worldStart =
        !exact && pre === 0 && provider.distance(t, t + MIN_MS) > 0;
      const count = Math.max(1, sessions.length + (worldStart ? 1 : 0));
      const rosterFirstDom =
        sessions.length > 0 ? new Date(sessions[0]!).getDate() : 31;
      const firstDom = worldStart
        ? Math.min(new Date(t).getDate(), rosterFirstDom)
        : rosterFirstDom;
      const lastDom =
        sessions.length > 0
          ? new Date(sessions[sessions.length - 1]!).getDate()
          : new Date(t).getDate();
      const stride = strideOf(count, lastDom - firstDom + 1);
      rosters.set(key, { count, stride });
      if ((exact || worldStart) && monthMark(pre, stride, count)) {
        out.push(t);
      }
      idx = exact || worldStart ? pre + 1 : pre;
      continue;
    }
    if (key !== curKey) {
      // A month transition: this open is its month's first session, index 0.
      curKey = key;
      idx = 0;
    }
    const { count, stride } = rosterOf(key);
    if (monthMark(idx, stride, count)) out.push(t);
    idx++;
  }
  return out;
}

/**
 * Thin an ascending run of **session opens** down to about `count` axis ticks.
 * Picks the finest rung: every session → **per-month uniform session stride**
 * (still day grain, month starts pinned) → month → quarter → year; beyond
 * yearly it decimates every-nth so the axis never crowds. Exported so the
 * container can draw session dividers at the same instants the axis labels.
 *
 * The day band thins each month to a **uniform session stride** — the month's
 * first session, then every `k`-th session, truncated so the gap to the next
 * month start stays ≥ `k` (slack at the month end, never a cramped tick
 * before the month label). The decoded-and-validated TradingView algorithm:
 * with a `provider` the stride runs in **session-index space**
 * ({@link subdivideMonthsBySession}) — marks an equal number of bars apart,
 * evenly spaced pixels on a collapsed axis, no weekend snapping; without one
 * it falls back to day-of-month space ({@link subdivideMonthsByDay}).
 * Zooming steps the stride through the integers (…4 → 3 → 2 → 1), a ~one-bar
 * density change that re-labels some interior marks; month / year starts stay
 * pinned at every zoom, and pans never reshuffle anything (the stride derives
 * from the span, the indices from the calendar). Schemes tried and rejected
 * on the way here: a global even day-stride (can't pin month starts — the
 * `Feb` label drifted with zoom), `round(i·L/div)` division (beats against
 * the month length), and dyadic midpoint halving (perfect zoom-nesting, but
 * 2× density jumps and ±1-day wobble inside non-power months; the owner's
 * TradingView captures showed uniform strides re-labelling on zoom reads
 * calmer than either wobble). There is deliberately no week rung: a
 * Monday-anchored week can't pin month starts either, so the day band owns
 * everything between every-session and month grain.
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
  provider?: DiscontinuityProvider,
): { ticks: number[]; granularity: TickGranularity } {
  if (opens.length <= count) return { ticks: [...opens], granularity: 'day' };
  // Per-month uniform session stride. Band-gated to spans where a nominal
  // month still affords ≥ 2 marks (below that a month is down to one mark,
  // which *is* month grain — the bucket ladder), and to daily-dense opens: a
  // synthetic run of month/year starts has no days to stride over.
  const openSpanDays =
    (opens[opens.length - 1]! - opens[0]!) / DAY_MS || Infinity;
  const dailyDense = opens.length >= 0.5 * openSpanDays;
  const gapDays = (spanDays ?? openSpanDays) / count;
  if (dailyDense && DAYS_PER_MONTH / gapDays >= 2) {
    const ticks =
      provider?.boundaries !== undefined
        ? subdivideMonthsBySession(opens, gapDays, provider)
        : subdivideMonthsByDay(opens, gapDays);
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

/**
 * The **grid populations** behind {@link buildTicks}' labels: every ladder rung
 * that fits `cap` lines, each carrying its FULL anchor population — every
 * aligned clock instant, every session open, every month / quarter / year
 * start — finest rung first. The axis *labels* are a thinned subset of one
 * rung; the grid is the calendar structure itself, so the container draws
 * every anchor of each returned level and fades a level's lines by their pixel
 * spacing (a crowding level dissolves while the coarser ones persist — the
 * map-style hierarchical grid). Levels **nest** (a month start is a session
 * open; an aligned hour sits inside its session; there is no week rung), so a
 * consumer de-duplicates shared anchors coarsest-first and each line draws
 * once, at its coarsest membership's (widest-spaced, so strongest) alpha.
 *
 * `cap` is the max lines per level — the caller derives it from plot width ÷
 * the fade-out spacing, so a level too dense to be visible at all is simply
 * absent rather than enumerated and thrown away. Sub-day rungs are gated on
 * the live-span estimate first (like {@link buildTicks}) and skipped when they
 * add no anchor beyond the session opens themselves (that is the day level).
 */
export function buildGridLevels(
  provider: DiscontinuityProvider,
  opens: readonly number[],
  domainEnd: number,
  cap: number,
): Array<{ granularity: TickGranularity; values: number[] }> {
  const out: Array<{ granularity: TickGranularity; values: number[] }> = [];
  if (cap < 1 || opens.length === 0) return out;
  const liveSpan = provider.distance(opens[0]!, domainEnd);
  for (const { g, step } of SUB_DAY_GRAINS) {
    if (opens.length + Math.floor(liveSpan / step) > cap) continue;
    const budget = cap + opens.length + 4;
    const anchors = stepAnchors(provider, opens, domainEnd, step, budget);
    if (anchors.length > budget) continue;
    if (anchors.length > opens.length) {
      out.push({ granularity: g, values: anchors });
    }
  }
  if (opens.length <= cap) {
    out.push({ granularity: 'day', values: [...opens] });
  }
  for (const g of COARSENING_LADDER) {
    const values = firstOfEachBucket(opens, g);
    if (values.length <= cap) out.push({ granularity: g, values });
  }
  return out;
}

/**
 * The **nominal wall-clock step** of grain `g` in ms — the calendar time one
 * grid cell of that grain covers (a day is a day whether or not its weekend
 * neighbours are drawn; a month is ~30.44 days). This is what the grid's
 * density fade keys off: `width × step / wallSpan` is a grain's spacing on a
 * gap-free axis, and using it (rather than the measured on-screen gaps) makes
 * the fade **mode-invariant** — collapsing weekends draws fewer day lines at
 * the *same* strength, instead of wider-spaced lines that jump to full
 * opacity at the same zoom.
 */
export function nominalStepMs(g: TickGranularity): number {
  const sub = SUB_DAY_GRAINS.find((r) => r.g === g);
  if (sub !== undefined) return sub.step;
  switch (g) {
    case 'day':
      return DAY_MS;
    case 'week':
      return 7 * DAY_MS;
    case 'month':
      return DAYS_PER_MONTH * DAY_MS;
    case 'quarter':
      return 3 * DAYS_PER_MONTH * DAY_MS;
    default:
      // 'year' (the sub-day grains are handled above).
      return 365.25 * DAY_MS;
  }
}

/**
 * Whether `t` sits exactly on a calendar instant of grain `g` — a local
 * midnight at day grain, a month / quarter / year start, a clock-aligned
 * step multiple (relative to `t`'s own local midnight, the same convention
 * as {@link nextAligned}) on the sub-day rungs. The window-edge genuineness
 * test in {@link buildTicks} — the only way a **continuous** axis's edge tick
 * survives, since a gap-free provider has no dead time to probe.
 *
 * The sub-day test shares {@link nextAligned}'s **fixed-elapsed-ms** rung
 * convention **by design** — so an edge tick is judged aligned iff it is one
 * of the instants {@link stepAnchors} would actually generate. On the two DST
 * transition days a wall-clock `03:00` is then *not* "aligned" to `hour3`
 * (only 2h elapsed since midnight) while `04:00` is — the same drift the
 * anchors themselves take, and the already-deferred exchange-tz grain
 * refinement (see `nextAligned`), not a fresh inconsistency. It only decides
 * whether the *window-edge* tick is kept on those days — nil practical impact
 * (Codex review, #479).
 */
function alignedToGrain(t: number, g: TickGranularity): boolean {
  const d = new Date(t);
  const midnight = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
  ).getTime();
  const sub = SUB_DAY_GRAINS.find((r) => r.g === g);
  if (sub !== undefined) return (t - midnight) % sub.step === 0;
  if (t !== midnight) return false;
  switch (g) {
    case 'month':
      return d.getDate() === 1;
    case 'quarter':
      return d.getDate() === 1 && d.getMonth() % 3 === 0;
    case 'year':
      return d.getDate() === 1 && d.getMonth() === 0;
    default:
      // 'day' (and the unreachable 'week' — there is no week rung).
      return true;
  }
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
 * then day (thinned by a per-month uniform session stride) → month → quarter → year
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
    // The provider routes the day band to session-index space (screen-even
    // marks; see subdivideMonthsBySession).
    return coarsenCalendar(
      opens,
      cap,
      (domainEnd - opens[0]!) / DAY_MS,
      provider,
    );
  })();
  // Round anchors to integer milliseconds: a pan/zoom domain comes from
  // `scale.invert(pixel)` and is fractional, and a fractional anchor breaks
  // the label pipeline — formatters pass through `new Date(ms)`, which
  // truncates, so the instant no longer matches its own anchor set and the
  // label falls through to the d3 multi-scale default (a bare `.259`
  // millisecond tick). Sub-ms precision is invisible at any ladder grain.
  result.ticks = result.ticks.map((t) => Math.round(t));
  // Drop the **window-edge rider**: the first tick is `opens[0]` (the raw
  // domain start), which is a calendar anchor only when it happens to BE one.
  // A mid-period edge otherwise becomes a tick pinned at x=0 that relabels
  // itself as the window pans (`8 → 9 → 10` mid-day, a `15:23` under an hour
  // grain) — sticky and misleading (owner, 2026-07-16); TradingView never
  // labels the window edge. Genuine ⇔ the instant is **live** and either a
  // true session open (dead time immediately before — incl. the calendar's
  // absolute start) or sits **exactly on a calendar instant of the chosen
  // grain** (a midnight at day grain, a month start at month grain, a clock
  // multiple on an hour rung) — the latter is how a gap-free continuous axis,
  // which has no dead time to probe, keeps a window cut exactly on a boundary
  // (a Jan-1-to-Jan-1 year fixture keeps its `2026`). Probe the **rounded**
  // tick `edge` (what actually renders), not the raw fractional `opens[0]`:
  // a fractional pan/zoom start that rounds onto a grain instant is aligned
  // by the value the reader sees, and the two agree exactly on the integer-ms
  // instants that aren't pan/zoom-derived.
  const t = result.ticks;
  if (t.length > 0 && t[0] === Math.round(opens[0]!)) {
    const edge = t[0]!;
    const genuine =
      provider.distance(edge, edge + 1) > 0 && // live (a dead edge never ticks)
      (provider.distance(edge - 1, edge) === 0 || // a session open, or…
        alignedToGrain(edge, result.granularity)); // …exactly on the grain
    if (!genuine) t.shift();
  }
  // Drop a cramped **leading partial-period** anchor: a genuine first tick
  // (a "1Y back from today" view starting exactly on a mid-month session)
  // can still land arbitrarily close to the first full period start and the
  // two labels collide (the classic "Jun 23Jul 07" pile-up). When the lead
  // gap is under half a typical period (in **live** time, so a collapsed
  // weekend doesn't fake a gap), the partial anchor isn't earning its label —
  // the boundary row moves to the next tick.
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
