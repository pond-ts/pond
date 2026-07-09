import {
  BoundedSequence,
  Interval,
  TimeSeries,
  type DurationInput,
  type SeriesSchema,
} from 'pond-ts';
import { normalizeSessions, type Session } from './session.js';
import {
  segmentDiscontinuity,
  type DiscontinuityProvider,
  type LiveSegment,
} from './discontinuity.js';
import {
  generateSessions,
  type DateRange,
  type SessionRules,
} from './rules.js';

/** An instant range for session queries — `[start, end)` epoch-ms. */
export interface InstantRange {
  start: number;
  end: number;
}

/**
 * The schema of a series after {@link TradingCalendar.tagSessions} appends its
 * session-id column. The column is an **optional** number (`required: false`)
 * because it holds `undefined` for every event in closed time — so
 * `.get(column)` types as `number | undefined`, forcing the consumer to handle
 * the closed-time case rather than crashing on it. Expressed with only the
 * exported `SeriesSchema` (a schema already leads with its key column, so
 * `[...S, col]` is core's `AppendColumn` tuple) so it names cleanly in the
 * emitted declarations.
 */
export type TaggedSchema<
  S extends SeriesSchema,
  Name extends string,
> = readonly [
  ...S,
  { readonly name: Name; readonly kind: 'number'; readonly required: false },
];

const DURATION_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a pond {@link DurationInput} (`number` ms or `"5m"`-style literal) to
 * milliseconds. Grammar mirrors core's (unexported) `parseDuration` exactly —
 * positive finite numbers, integer literals only — so this collapses to a
 * re-use if core ever exports it.
 */
function durationToMs(input: DurationInput): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      throw new TypeError(
        'duration must be a positive finite number of milliseconds',
      );
    }
    return input;
  }
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(input);
  if (!m) throw new TypeError(`unsupported duration '${input}'`);
  return Number(m[1]) * DURATION_MS[m[2]!]!;
}

/**
 * A trading calendar: an ordered, non-overlapping schedule of {@link Session}s
 * plus the query surface the data ops and (later) the chart axis need.
 *
 * A calendar is **always defined by a session list** — the canonical form. Rules
 * are one way to produce that list ({@link TradingCalendar.fromRules}); a
 * consumer with dated instants uses them directly
 * ({@link TradingCalendar.fromSessions}). Both paths are first-class (RFC
 * Amendment 2, Tidal Ask 1).
 *
 * The schedule is **finite** — queries outside its covered range return empty /
 * `undefined`, they do not extrapolate. A rules calendar covers exactly the
 * range it was generated over.
 */
export class TradingCalendar {
  readonly #sessions: readonly Session[];
  /** Session `open` values, ascending — the bisection axis for instant queries. */
  readonly #opens: readonly number[];
  /** date → index, for O(1) by-date lookup. */
  readonly #byDate: ReadonlyMap<string, number>;

  private constructor(sessions: readonly Session[]) {
    this.#sessions = sessions;
    this.#opens = sessions.map((s) => s.open);
    this.#byDate = new Map(sessions.map((s, i) => [s.date, i]));
  }

  /** Build a calendar from an explicit session list (validated + sorted). The first-class path. */
  static fromSessions(sessions: Iterable<Session>): TradingCalendar {
    return new TradingCalendar(normalizeSessions(sessions));
  }

  /** Build a calendar by generating sessions from {@link SessionRules} over a date range. */
  static fromRules(rules: SessionRules, range: DateRange): TradingCalendar {
    return new TradingCalendar(
      normalizeSessions(generateSessions(rules, range)),
    );
  }

  /** All sessions, ascending by open. */
  sessions(): readonly Session[] {
    return this.#sessions;
  }

  /** The number of trading sessions in the calendar. */
  get length(): number {
    return this.#sessions.length;
  }

  /** The session labelled `date` (`YYYY-MM-DD`), or `undefined` if not a trading day. */
  sessionOn(date: string): Session | undefined {
    const i = this.#byDate.get(date);
    return i === undefined ? undefined : this.#sessions[i];
  }

  /** Whether `date` (`YYYY-MM-DD`) is a trading day in this calendar. */
  isTradingDay(date: string): boolean {
    return this.#byDate.has(date);
  }

  /**
   * The session whose `[open, close)` contains `instant`, or `undefined` if the
   * instant falls in closed time (between sessions, or outside the schedule).
   * Being inside a *break* still counts as inside the session — use
   * {@link isOpen} to exclude breaks.
   */
  sessionContaining(instant: number): Session | undefined {
    // Rightmost session with open <= instant.
    const i = this.#lastOpenAtOrBefore(instant);
    if (i < 0) return undefined;
    const s = this.#sessions[i]!;
    return instant < s.close ? s : undefined;
  }

  /** Whether the market is open at `instant` — inside a session and not inside one of its breaks. */
  isOpen(instant: number): boolean {
    const s = this.sessionContaining(instant);
    if (!s) return false;
    if (!s.breaks) return true;
    for (const b of s.breaks) {
      if (instant >= b.start && instant < b.end) return false;
    }
    return true;
  }

  /** Sessions overlapping the instant range `[start, end)`, ascending. */
  sessionsInRange(range: InstantRange): Session[] {
    const { start, end } = range;
    if (end <= start) return [];
    const out: Session[] = [];
    // Start from the session possibly containing `start`, then walk forward.
    let i = Math.max(0, this.#lastOpenAtOrBefore(start));
    for (; i < this.#sessions.length; i++) {
      const s = this.#sessions[i]!;
      if (s.open >= end) break;
      if (s.close > start) out.push(s);
    }
    return out;
  }

  /**
   * A {@link BoundedSequence} of one interval per session — `[open, close)`,
   * labelled by trading date. This is the daily-bar bucketing grid: feed it
   * straight to `TimeSeries.aggregate` / `.materialize` and every bucket is a
   * real trading session, with no weekend/holiday buckets and no bucket
   * spanning a market closure. Intraday breaks are *inside* the daily bar (a
   * daily bar spans the lunch) — use {@link barSequence} to break at them.
   *
   * With `range`, only sessions overlapping `[start, end)` are included (full
   * sessions — bars are not clipped to the range; crop the result if exact
   * range edges are needed).
   */
  sessionSequence(range?: InstantRange): BoundedSequence {
    const sessions = range ? this.sessionsInRange(range) : this.#sessions;
    return new BoundedSequence(
      sessions.map(
        (s) => new Interval({ value: s.date, start: s.open, end: s.close }),
      ),
    );
  }

  /**
   * A {@link BoundedSequence} of intraday `period`-width bars, session-aligned:
   * bars never span a session boundary or an intraday break, and the final bar
   * of each tradeable segment is **truncated at the close** (a 90-minute grid
   * on a 6.5-hour session ends with a short bar). Labelled by bar-open instant.
   * This mirrors `exchange_calendars.trading_index` / `pandas_market_calendars`
   * bar-grid semantics, and — like {@link sessionSequence} — flows straight
   * through `aggregate`/`materialize`.
   *
   * `period` is a pond {@link DurationInput} (`"5m"`, `"1h"`, or ms). With
   * `range`, only sessions overlapping it contribute bars (full sessions).
   */
  barSequence(period: DurationInput, range?: InstantRange): BoundedSequence {
    const periodMs = durationToMs(period);
    if (!(periodMs > 0)) {
      throw new RangeError(
        `barSequence period must be > 0; got ${JSON.stringify(period)}`,
      );
    }
    const sessions = range ? this.sessionsInRange(range) : this.#sessions;
    const intervals = TradingCalendar.#barSlots(sessions, periodMs).map(
      ([start, end]) => new Interval({ value: start, start, end }),
    );
    return new BoundedSequence(intervals);
  }

  /**
   * The session-aligned `period`-bar `[start, end)` slots — the geometry behind
   * {@link barSequence}, shared with the uniform axis. Bars never span a session
   * boundary or an intraday break; the final bar of each tradeable segment is
   * truncated at that segment's end.
   */
  static #barSlots(
    sessions: readonly Session[],
    periodMs: number,
  ): LiveSegment[] {
    const slots: LiveSegment[] = [];
    for (const [a, b] of TradingCalendar.#liveSegments(sessions)) {
      for (let t = a; t < b; t += periodMs) {
        slots.push([t, Math.min(t + periodMs, b)]);
      }
    }
    return slots;
  }

  /**
   * Append a **session-id column** to `series`: for each event, the `open`
   * instant of the session that contains it, or `undefined` if the event falls
   * in closed time (a gap between sessions, or outside the schedule). The id is
   * numeric and stable per session — use it as a `partitionBy` key so
   * stateful ops (`rolling`, `fill`, cumulative folds) **don't bridge across a
   * session boundary** (the align/rolling stopgap of the trading-calendar RFC,
   * Tidal Ask 2). Recover the session from an id via {@link sessionOn} /
   * {@link sessionContaining}.
   *
   * Default column name `"session"` (override with `column`). Throws if a
   * column of that name already exists (a fresh column is appended, per
   * `withColumn`). O(n + sessions) — a single merge walk over the (sorted)
   * events and sessions; materializes the events once to read their instants.
   */
  tagSessions<S extends SeriesSchema, const Name extends string = 'session'>(
    series: TimeSeries<S>,
    options: { column?: Name } = {},
  ): TimeSeries<TaggedSchema<S, Name>> {
    const column = (options.column ?? 'session') as Name;
    const events = series.toArray();
    const ids = new Array<number | undefined>(events.length);
    const sessions = this.#sessions;
    let c = 0;
    for (let i = 0; i < events.length; i++) {
      const t = events[i]!.begin();
      // Events are ascending by begin and sessions by open, so the cursor only
      // moves forward: skip sessions that already closed at or before t.
      while (c < sessions.length && sessions[c]!.close <= t) c++;
      const s = c < sessions.length ? sessions[c]! : undefined;
      ids[i] = s !== undefined && t >= s.open ? s.open : undefined;
    }
    return series.withColumn(column, ids) as unknown as TimeSeries<
      TaggedSchema<S, Name>
    >;
  }

  /**
   * A {@link DiscontinuityProvider} over this calendar's **tradeable spans** —
   * each session's `[open, close)` with its intraday breaks removed. Closed time
   * between sessions and inside a lunch break collapses to nothing. A
   * `@pond-ts/charts` trading-time scale consumes this (structurally — no
   * package coupling) to map value → pixel with the gaps excised.
   *
   * **`spacing`** picks the axis metric (the trading-calendar RFC Q7):
   * - `'proportional'` (default) — time is proportional within *and across*
   *   sessions; a half-day is half as wide as a full day. The true-time axis.
   * - `'uniform'` — equal width per slot regardless of duration; the ordinal /
   *   TradingView bar look. **Without `period`** each *session* is one slot
   *   (the daily-candle view; intraday breaks are not collapsed *within* the
   *   slot, since a daily bar spans the lunch). **With `period`** each
   *   session-aligned bar (the {@link barSequence} grid — break-split, truncated
   *   at each segment's close) is one slot, so an intraday uniform axis lays
   *   every bar out at equal width. `period` is ignored for `'proportional'`.
   *
   * With `range`, only sessions overlapping `[start, end)` contribute.
   * Collapse-point `boundaries` follow the segments each variant uses:
   * `'proportional'` and period-`'uniform'` split on breaks, so a lunch re-open
   * is a divider; session-`'uniform'` (no `period`) treats each session as one
   * slot, so it draws a divider only at session opens, not at breaks.
   */
  discontinuities(
    options: {
      range?: InstantRange;
      spacing?: 'proportional' | 'uniform';
      period?: DurationInput;
    } = {},
  ): DiscontinuityProvider {
    const { range, spacing = 'proportional', period } = options;
    const sessions = range ? this.sessionsInRange(range) : this.#sessions;
    if (spacing === 'uniform') {
      const slots =
        period !== undefined
          ? TradingCalendar.#barSlots(sessions, durationToMs(period))
          : sessions.map((s): LiveSegment => [s.open, s.close]);
      return segmentDiscontinuity(slots, { spacing: 'uniform' });
    }
    return segmentDiscontinuity(TradingCalendar.#liveSegments(sessions));
  }

  /** Tradeable spans — each session's `[open, close)` with its breaks removed. */
  static #liveSegments(sessions: readonly Session[]): LiveSegment[] {
    const segments: LiveSegment[] = [];
    for (const s of sessions) {
      let segStart = s.open;
      if (s.breaks) {
        for (const b of s.breaks) {
          if (b.start > segStart) segments.push([segStart, b.start]);
          segStart = b.end;
        }
      }
      if (s.close > segStart) segments.push([segStart, s.close]);
    }
    return segments;
  }

  /**
   * The first session strictly after `ref`, or `undefined`. A numeric `ref`
   * compares against session opens (so a `ref` mid-session returns the *next*
   * session); a `YYYY-MM-DD` `ref` compares by trading date.
   */
  nextSession(ref: number | string): Session | undefined {
    // First index strictly after ref, by the ref's own key space.
    const i =
      typeof ref === 'number'
        ? this.#lastOpenAtOrBefore(ref) + 1
        : this.#firstDateAfter(ref);
    return i < this.#sessions.length ? this.#sessions[i] : undefined;
  }

  /**
   * The last session strictly before `ref`, or `undefined`. A numeric `ref`
   * compares against session opens (a `ref` mid-session returns *that* session,
   * whose open precedes it); a `YYYY-MM-DD` `ref` compares by trading date.
   */
  previousSession(ref: number | string): Session | undefined {
    const firstAtOrAfter =
      typeof ref === 'number'
        ? this.#firstOpenAtOrAfter(ref)
        : this.#firstDateAtOrAfter(ref);
    return firstAtOrAfter - 1 >= 0
      ? this.#sessions[firstAtOrAfter - 1]
      : undefined;
  }

  /** First index whose session `open` is `>= instant` (lower bound). */
  #firstOpenAtOrAfter(instant: number): number {
    let lo = 0;
    let hi = this.#opens.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#opens[mid]! < instant) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index whose session date is `> date` (ISO strings sort chronologically). */
  #firstDateAfter(date: string): number {
    let lo = 0;
    let hi = this.#sessions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#sessions[mid]!.date <= date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index whose session date is `>= date`. */
  #firstDateAtOrAfter(date: string): number {
    let lo = 0;
    let hi = this.#sessions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#sessions[mid]!.date < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the rightmost session with `open <= instant`, or -1. */
  #lastOpenAtOrBefore(instant: number): number {
    let lo = 0;
    let hi = this.#opens.length; // first index with open > instant
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#opens[mid]! <= instant) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
}
