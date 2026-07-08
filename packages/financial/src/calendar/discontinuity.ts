/**
 * The disjoint time-axis primitive: a d3fc-style discontinuity provider.
 *
 * A `DiscontinuityProvider` describes an axis whose domain is epoch-milliseconds
 * but from which certain ranges — closed-market time — have been excised. It is
 * the structural surface a `@pond-ts/charts` trading-time scale consumes to map
 * value → pixel while collapsing the gaps, and the same surface the calendar
 * engine (later in this package) produces from a session schedule. Charts
 * depends on the *shape*, never on this package (see the trading-calendar RFC).
 *
 * The five methods mirror d3fc's `discontinuity-scale` provider so the semantics
 * are the well-trodden ones:
 *
 * - {@link DiscontinuityProvider.clampUp} / {@link DiscontinuityProvider.clampDown}
 *   snap a value that falls *inside* a gap to the gap's far / near live edge.
 * - {@link DiscontinuityProvider.distance} measures *live* (non-gap) domain
 *   distance between two instants — signed, so `distance(a, b) === -distance(b, a)`.
 * - {@link DiscontinuityProvider.offset} advances a value by a live-ms amount,
 *   skipping gaps — the inverse of `distance` (`offset(a, distance(a, b))` lands
 *   on `b`, clamped out of any gap).
 * - {@link DiscontinuityProvider.copy} clones the provider.
 */
export interface DiscontinuityProvider {
  /** If `value` lies inside a removed gap, return the gap's *end* (the first live instant `>= value`); otherwise return `value` unchanged. */
  clampUp(value: number): number;
  /** If `value` lies inside a removed gap, return the gap's *start* (the last live instant `<= value`); otherwise return `value` unchanged. */
  clampDown(value: number): number;
  /** Live (non-gap) domain distance from `from` to `to`. Signed: negative when `to < from`. Gap time between the two is not counted. */
  distance(from: number, to: number): number;
  /** Advance `value` by `amount` live-milliseconds, skipping gaps. Inverse of {@link distance}. */
  offset(value: number, amount: number): number;
  /** Return an independent copy of this provider. */
  copy(): DiscontinuityProvider;
}

/**
 * The trivial provider: no gaps. `distance`/`offset` are plain subtraction and
 * addition; `clampUp`/`clampDown` are identity. Useful as a default and as the
 * base case a scale falls back to when no calendar is supplied.
 */
export function identityDiscontinuity(): DiscontinuityProvider {
  const self: DiscontinuityProvider = {
    clampUp: (value) => value,
    clampDown: (value) => value,
    distance: (from, to) => to - from,
    offset: (value, amount) => value + amount,
    copy: () => self,
  };
  return self;
}

const DAY_MS = 86_400_000;

/**
 * Monday 1970-01-05 00:00:00 UTC. The Unix epoch is a Thursday, which makes
 * week-phase arithmetic awkward; anchoring to a Monday means day-of-week is a
 * clean `dayIndex mod 7` with 0 = Monday.
 */
const MONDAY_ANCHOR_MS = 4 * DAY_MS;

/** Positive modulo — `%` alone is sign-preserving in JS. */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Count of weekday (Mon–Fri) day-indices in `[0, n)`, anchored so index 0 is a
 * Monday. Defined for all integers and monotonic in `n` (for `n < 0` it returns
 * the negated count over `[n, 0)`), so it composes into a monotonic live-ms map.
 */
function weekdaysBefore(n: number): number {
  const fullWeeks = Math.floor(n / 7);
  const rem = n - fullWeeks * 7; // 0..6 (floor makes this non-negative)
  return fullWeeks * 5 + Math.min(rem, 5);
}

export interface WeekendSkipOptions {
  /**
   * Which days are the weekend, as day-of-week indices with **0 = Sunday** …
   * **6 = Saturday** (matching `Date.getUTCDay`). Defaults to `[6, 0]`
   * (Saturday + Sunday). Must be a contiguous pair for the closed-form math to
   * hold; the reference provider does not model split or single-day weekends.
   */
  weekend?: readonly [number, number];
}

/**
 * The bundled **reference** discontinuity provider: UTC weekends removed from
 * the axis. This is demo / spike grade — it knows nothing about exchange
 * holidays, half-days, session hours, or non-UTC weekends. For real markets,
 * construct a provider from a session schedule (bring-your-own calendar data,
 * per the trading-calendar RFC); this exists to prove the interface, to seed
 * stories/tests, and to cover the "just drop the weekends" case.
 *
 * Semantics: the removed gaps are `[Sat 00:00 UTC, Mon 00:00 UTC)` each week
 * (i.e. all of Saturday and Sunday). All arithmetic is closed-form O(1) — no
 * scan over the intervening weeks — so it is cheap to call per-tick / per-pixel.
 */
export function weekendSkip(
  options: WeekendSkipOptions = {},
): DiscontinuityProvider {
  const weekend = options.weekend ?? [6, 0]; // Sat, Sun (getUTCDay convention)
  const weekendSet = new Set(weekend);
  if (weekendSet.size !== 2 || !weekendSet.has(6) || !weekendSet.has(0)) {
    // The closed-form live-ms map is derived specifically for a Sat+Sun
    // weekend. Reject anything else rather than silently miscomputing.
    throw new RangeError(
      'weekendSkip currently supports only the Saturday+Sunday weekend ([6, 0]); ' +
        'for other market schedules build a provider from a session calendar.',
    );
  }

  /** Day index relative to the Monday anchor (0 = the anchor Monday). */
  const dayIndexOf = (value: number): number =>
    Math.floor((value - MONDAY_ANCHOR_MS) / DAY_MS);

  /** Is this day index a weekend day (Sat = 5 or Sun = 6, Monday-anchored)? */
  const isWeekendDay = (dayIndex: number): boolean => mod(dayIndex, 7) >= 5;

  /**
   * Live (weekend-free) ms from the anchor Monday to `value`. Monotonic
   * non-decreasing; an instant inside a weekend maps to the live-ms of that
   * weekend's Saturday-00:00 boundary (its intra-day remainder counts as 0).
   */
  const liveMsFromAnchor = (value: number): number => {
    const dayIndex = dayIndexOf(value);
    const remInDay = value - MONDAY_ANCHOR_MS - dayIndex * DAY_MS; // [0, DAY_MS)
    const liveDaysMs = weekdaysBefore(dayIndex) * DAY_MS;
    return liveDaysMs + (isWeekendDay(dayIndex) ? 0 : remInDay);
  };

  /** Inverse of {@link liveMsFromAnchor}: the epoch-ms instant for a live-ms offset. */
  const instantForLiveMs = (live: number): number => {
    const liveDay = Math.floor(live / DAY_MS);
    const remMs = live - liveDay * DAY_MS;
    const fullWeeks = Math.floor(liveDay / 5);
    const remW = liveDay - fullWeeks * 5; // 0..4 → Mon..Fri
    const dayIndex = fullWeeks * 7 + remW;
    return MONDAY_ANCHOR_MS + dayIndex * DAY_MS + remMs;
  };

  const self: DiscontinuityProvider = {
    clampDown: (value) => {
      const dayIndex = dayIndexOf(value);
      if (!isWeekendDay(dayIndex)) return value;
      // Last live instant <= value is the start of this weekend's Saturday.
      const saturdayIndex = mod(dayIndex, 7) === 5 ? dayIndex : dayIndex - 1;
      return MONDAY_ANCHOR_MS + saturdayIndex * DAY_MS;
    },
    clampUp: (value) => {
      const dayIndex = dayIndexOf(value);
      if (!isWeekendDay(dayIndex)) return value;
      // First live instant >= value is the following Monday 00:00.
      const daysToMonday = mod(dayIndex, 7) === 5 ? 2 : 1; // Sat → +2, Sun → +1
      return MONDAY_ANCHOR_MS + (dayIndex + daysToMonday) * DAY_MS;
    },
    distance: (from, to) => liveMsFromAnchor(to) - liveMsFromAnchor(from),
    offset: (value, amount) =>
      instantForLiveMs(liveMsFromAnchor(value) + amount),
    copy: () => self,
  };
  return self;
}
