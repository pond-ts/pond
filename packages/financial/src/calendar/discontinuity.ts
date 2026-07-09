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
  /** If `value` lies inside a removed gap, snap it up to the next live instant; a value already live is returned unchanged. Behavior for a value outside the provider's whole domain is implementation-defined — `identityDiscontinuity` leaves it; a bounded provider (`segmentDiscontinuity`) may snap to its first live edge. */
  clampUp(value: number): number;
  /** If `value` lies inside a removed gap, snap it down to the previous live instant; a value already live is returned unchanged. Out-of-domain behavior is implementation-defined (see {@link clampUp}). */
  clampDown(value: number): number;
  /** Live (non-gap) domain distance from `from` to `to`. Signed: negative when `to < from`. Gap time between the two is not counted. */
  distance(from: number, to: number): number;
  /** Advance `value` by `amount` live-milliseconds, skipping gaps. Inverse of {@link distance}. */
  offset(value: number, amount: number): number;
  /** Return an independent copy of this provider. */
  copy(): DiscontinuityProvider;
  /**
   * The domain positions of **collapsed gaps** strictly inside `(from, to)` —
   * each is the far edge of a removed gap (a session/day open, a post-break
   * re-open), i.e. where two non-adjacent times become adjacent on the axis.
   * A chart draws a session divider at each. **Optional** — a provider that
   * can't enumerate its gaps omits it, and the axis just collapses silently.
   * Ascending; excludes any boundary at the very domain start (no gap precedes it).
   */
  boundaries?(from: number, to: number): number[];
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
    boundaries: () => [], // no gaps → no dividers
  };
  return self;
}

/** A half-open live (non-gap) interval `[start, end)` in epoch-ms. */
export type LiveSegment = readonly [start: number, end: number];

/** How a {@link segmentDiscontinuity} provider measures distance across segments. */
export interface SegmentDiscontinuityOptions {
  /**
   * The axis spacing (`TradingCalendar.discontinuities` exposes the same choice
   * under the same name):
   * - `'proportional'` (default) — distance is **live-ms**: time is
   *   proportional within and across segments (a 6.5-hour session is twice a
   *   3.25-hour half-day). The true-time trading axis.
   * - `'uniform'` — each segment is **one equal unit** of distance regardless
   *   of its real duration (a half-day is as wide as a full day). The ordinal /
   *   TradingView bar look. Position *within* a segment still interpolates
   *   linearly by time, so a point halfway through a segment sits at its
   *   midpoint. For **the same segment list**, `clampUp` / `clampDown` /
   *   `boundaries` are unaffected — they operate on epoch-ms edges, not on the
   *   spacing. (The calendar's session- vs bar-uniform difference comes from
   *   passing *different* segment lists, not from this option.)
   */
  spacing?: 'proportional' | 'uniform';
}

/**
 * A provider whose live (non-excised) domain is an explicit, sorted,
 * non-overlapping list of `[start, end)` segments — everything *between* the
 * segments is a removed gap. This is the general engine behind a trading
 * calendar's axis: the segments are the tradeable spans (sessions minus
 * intraday breaks, or bars), so closed time between sessions and inside a lunch
 * break both collapse to nothing while time stays proportional *within* each
 * span.
 *
 * The `spacing` option (default `'proportional'`) chooses whether distance is
 * live-ms or one-unit-per-segment (`'uniform'` — see
 * {@link SegmentDiscontinuityOptions}); it does not change which time is live,
 * only how live distance is measured.
 *
 * All arithmetic is O(log n) via bisection over precomputed cumulative distance
 * at each segment boundary — cheap enough to call per-tick / per-pixel.
 *
 * `clampUp` / `clampDown` snap a value that is not in a live span to the nearest
 * live edge *in that direction*: `clampUp` to the next span's start (or the very
 * first start, if before everything), `clampDown` to the previous span's end
 * (or the very last end, if past everything). A value already inside a live span
 * is returned unchanged; the direction with no target (up past the last span,
 * down before the first) also returns the value unchanged.
 */
export function segmentDiscontinuity(
  input: readonly LiveSegment[],
  options: SegmentDiscontinuityOptions = {},
): DiscontinuityProvider {
  const uniform = options.spacing === 'uniform';
  // Drop zero/negative-length spans at the boundary so every segment is a real
  // live span (the calendar never emits these, but the entry point is public).
  const segments = input.filter((s) => s[1] > s[0]);
  const n = segments.length;
  // Precompute cumulative distance at each segment start; cum[n] = total. Each
  // segment contributes its real ms width (proportional) or one unit (uniform).
  const cum = new Array<number>(n + 1);
  cum[0] = 0;
  for (let i = 0; i < n; i++) {
    const seg = segments[i]!;
    cum[i + 1] = cum[i]! + (uniform ? 1 : seg[1] - seg[0]);
  }
  const total = cum[n]!;

  /** Rightmost segment index whose start <= t, or -1. */
  const segAtOrBefore = (t: number): number => {
    let lo = 0;
    let hi = n; // first index with start > t
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid]![0] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };

  /** Live (non-gap) distance from the first segment start to `t`, in `[0, total]`. */
  const liveMs = (t: number): number => {
    if (n === 0 || t <= segments[0]![0]) return 0;
    if (t >= segments[n - 1]![1]) return total;
    const i = segAtOrBefore(t); // >= 0 here
    const seg = segments[i]!;
    if (t >= seg[1]) return cum[i + 1]!; // in the gap after segment i → boundary
    // Inside segment i: raw ms (proportional) or the linear fraction (uniform).
    const within = t - seg[0];
    return cum[i]! + (uniform ? within / (seg[1] - seg[0]) : within);
  };

  /** Inverse of {@link liveMs}: the epoch-ms instant at cumulative distance `L`. */
  const instantForLive = (L: number): number => {
    if (n === 0) return 0;
    if (L <= 0) return segments[0]![0];
    if (L >= total) return segments[n - 1]![1];
    // First segment whose cumulative end (cum[i+1]) is > L.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid + 1]! <= L) lo = mid + 1;
      else hi = mid;
    }
    const seg = segments[lo]!;
    const within = L - cum[lo]!; // in [0, segment's distance)
    return seg[0] + (uniform ? within * (seg[1] - seg[0]) : within);
  };

  const self: DiscontinuityProvider = {
    clampUp: (t) => {
      if (n === 0) return t;
      if (t < segments[0]![0]) return segments[0]![0]; // before all → first start
      const i = segAtOrBefore(t); // >= 0
      if (t < segments[i]![1]) return t; // inside a segment
      // In a gap after segment i: snap forward to the next start; past last → t.
      return i + 1 < n ? segments[i + 1]![0] : t;
    },
    clampDown: (t) => {
      if (n === 0) return t;
      if (t >= segments[n - 1]![1]) return segments[n - 1]![1]; // past all → last end
      const i = segAtOrBefore(t);
      if (i < 0 || t < segments[i]![1]) return t; // before all, or inside a segment
      // In a gap after segment i: snap back to that segment's end.
      return segments[i]![1];
    },
    distance: (from, to) => liveMs(to) - liveMs(from),
    offset: (value, amount) => instantForLive(liveMs(value) + amount),
    copy: () => self,
    boundaries: (from, to) => {
      // Each segment start that a real gap precedes, strictly inside (from, to).
      const out: number[] = [];
      for (let i = 1; i < n; i++) {
        const start = segments[i]![0];
        if (start > segments[i - 1]![1] && start > from && start < to) {
          out.push(start);
        }
      }
      return out;
    },
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

/**
 * The bundled **reference** discontinuity provider: UTC weekends (all of
 * Saturday and Sunday) removed from the axis. This is demo / spike grade — it
 * knows nothing about exchange holidays, half-days, session hours, or non-UTC
 * weekends. For real markets, construct a provider from a session schedule
 * (bring-your-own calendar data, per the trading-calendar RFC); this exists to
 * prove the interface, to seed stories/tests, and to cover the "just drop the
 * weekends" case. It deliberately takes **no options** — anything beyond a
 * plain Sat+Sun UTC weekend is a job for the calendar, not a knob here.
 *
 * Semantics: the removed gaps are `[Sat 00:00 UTC, Mon 00:00 UTC)` each week.
 * All arithmetic is closed-form O(1) — no scan over the intervening weeks — so
 * it is cheap to call per-tick / per-pixel.
 */
export function weekendSkip(): DiscontinuityProvider {
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
    boundaries: (from, to) => {
      // Each Monday 00:00 (the end of a weekend gap) strictly inside (from, to).
      const out: number[] = [];
      const firstMondayIndex = Math.ceil(
        (from - MONDAY_ANCHOR_MS) / (7 * DAY_MS),
      );
      for (let w = firstMondayIndex; ; w++) {
        const monday = MONDAY_ANCHOR_MS + w * 7 * DAY_MS;
        if (monday >= to) break;
        if (monday > from) out.push(monday);
      }
      return out;
    },
  };
  return self;
}
