import type { DiscontinuityProvider } from './tradingTimeScale.js';

/**
 * The logical tick ladder — grain selection for a time axis. Ticks sit on real
 * calendar/clock units (1H / 3H / 6H / 12H / day / week / month / quarter /
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
 * where the year turns.
 */

/** The calendar grain a run of tick anchors is bucketed to. */
export type TickGranularity =
  | 'hour1'
  | 'hour3'
  | 'hour6'
  | 'hour12'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year';

const HOUR_MS = 3_600_000;

/** The sub-day rungs, finest first, with their clock step. */
const HOUR_GRAINS: ReadonlyArray<{ g: TickGranularity; step: number }> = [
  { g: 'hour1', step: 1 * HOUR_MS },
  { g: 'hour3', step: 3 * HOUR_MS },
  { g: 'hour6', step: 6 * HOUR_MS },
  { g: 'hour12', step: 12 * HOUR_MS },
];

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
  const d = new Date(t);
  switch (g) {
    case 'hour1':
    case 'hour3':
    case 'hour6':
    case 'hour12':
      return t;
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
 * on the ladder (day → week → month → quarter → year) that yields at most
 * `count` buckets and returns the first open in each; beyond yearly it decimates
 * every-nth so the axis never crowds. Exported so the container can draw session
 * dividers at the same instants the axis labels.
 *
 * `count` is a **cap**, not a target: grains jump by 4–12× up the ladder, so a
 * small fixed count over-coarsens long spans (a mid-year-anchored 12-month daily
 * run spans 6 quarter buckets — capped at 5 it collapses to year grain, 2
 * ticks). Callers size the cap to the room the labels have — the container
 * derives it from plot width — rather than passing a small constant.
 *
 * This is the day-and-coarser half of the ladder; {@link buildTicks} adds the
 * sub-day rungs.
 */
export function coarsenCalendar(
  opens: readonly number[],
  count: number,
): { ticks: number[]; granularity: TickGranularity } {
  if (opens.length <= count) return { ticks: [...opens], granularity: 'day' };
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
function hourAnchors(
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
 * width-derived `cap`, walk hour1 → hour3 → hour6 → hour12 → day → week →
 * month → quarter → year (then decimate) and return the first rung that fits.
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
      for (const { g, step } of HOUR_GRAINS) {
        const ticks = hourAnchors(provider, opens, domainEnd, step, cap);
        // An hour rung must earn its clock labels: if it adds no intraday
        // anchor beyond the opens themselves, it's really day grain (a row of
        // "09:30"s under every session is a worse day axis, not an hour axis).
        if (ticks.length <= cap && ticks.length > opens.length)
          return { ticks, granularity: g };
      }
      return { ticks: [...opens], granularity: 'day' };
    }
    return coarsenCalendar(opens, cap);
  })();
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
 * row. Hour labels (`14:00`) need the date; day/week labels (`Feb 02`) need
 * the month-and-year; month/quarter labels (`Feb`) need the year; a year label
 * already says everything.
 */
export function boundaryGrainFor(
  g: TickGranularity,
): TickGranularity | undefined {
  switch (g) {
    case 'hour1':
    case 'hour3':
    case 'hour6':
    case 'hour12':
      return 'day';
    case 'day':
    case 'week':
      return 'month';
    case 'month':
    case 'quarter':
      return 'year';
    case 'year':
      return undefined;
  }
}

/** d3 time-format specifier for the **major** (first-row) label at grain `g`. */
export function majorFormatFor(g: TickGranularity): string {
  switch (g) {
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
 *  boundary grain `g`. A month boundary carries the year (`Jul 2026`) — the
 *  second row is where the coarser context lives, so it must be complete. */
export function boundaryFormatFor(g: TickGranularity): string {
  switch (g) {
    case 'day':
      return '%b %d';
    case 'month':
      return '%b %Y';
    case 'year':
      return '%Y';
    default:
      return '%Y';
  }
}

/**
 * Which of `ticks` (at grain `granularity`) carry a boundary label: the first
 * tick always (the reader needs context immediately), then every tick whose
 * boundary-grain bucket differs from the previous tick's — i.e. the first tick
 * of each new day / month / year. Returns the boundary-flagged tick values;
 * empty when the grain has no boundary row (year grain).
 */
export function boundaryTicks(
  ticks: readonly number[],
  granularity: TickGranularity,
): number[] {
  const bg = boundaryGrainFor(granularity);
  if (bg === undefined) return [];
  const out: number[] = [];
  let prev: number | undefined;
  for (const t of ticks) {
    const k = bucketKey(t, bg);
    if (prev === undefined || k !== prev) out.push(t);
    prev = k;
  }
  return out;
}
