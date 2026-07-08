import { normalizeSessions, type Session } from './session.js';
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
    let firstAtOrAfter: number;
    if (typeof ref === 'number') {
      // First index with open >= ref.
      let lo = 0;
      let hi = this.#opens.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.#opens[mid]! < ref) lo = mid + 1;
        else hi = mid;
      }
      firstAtOrAfter = lo;
    } else {
      firstAtOrAfter = this.#firstDateAtOrAfter(ref);
    }
    return firstAtOrAfter - 1 >= 0
      ? this.#sessions[firstAtOrAfter - 1]
      : undefined;
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
