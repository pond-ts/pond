/**
 * The session model — the data shape a trading calendar is defined by.
 *
 * A {@link Session} is one trading day: a tz-naive date label plus its
 * `[open, close)` extent in epoch-milliseconds and any intraday breaks. This is
 * the representation `exchange_calendars` exposes as its *schedule*, and — per
 * the trading-calendar RFC (Amendment 2, Tidal Ask 1) — the **first-class
 * construction input**, not merely an internal form: a consumer whose feed
 * hands it dated session instants builds a calendar straight from these,
 * without reverse-engineering rules.
 */

/** An intraday non-trading interval within a session (e.g. a lunch break). Half-open `[start, end)` epoch-ms. */
export interface SessionBreak {
  readonly start: number;
  readonly end: number;
}

/** One trading day. `[open, close)` is half-open (the open instant trades, the close instant does not), matching pond's bucket convention. */
export interface Session {
  /** Trading date as a tz-naive ISO date `YYYY-MM-DD` — the session's identity and label. */
  readonly date: string;
  /** Session open, epoch-ms, inclusive. */
  readonly open: number;
  /** Session close, epoch-ms, exclusive. Always `> open`. */
  readonly close: number;
  /** Optional intraday breaks, each `[start, end)` within `(open, close)`, sorted and non-overlapping. */
  readonly breaks?: readonly SessionBreak[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalize a session list into the calendar's canonical form:
 * sorted by `open`, dates unique, each session well-formed (`open < close`,
 * breaks inside `(open, close)`, sorted, non-overlapping). Throws on any
 * violation — a calendar must never be built from an inconsistent schedule.
 * Sessions must also be **non-overlapping** with each other (a later session's
 * `open` is `>=` the previous session's `close`).
 */
export function normalizeSessions(input: Iterable<Session>): Session[] {
  const sessions = [...input];
  for (const s of sessions) {
    if (!DATE_RE.test(s.date)) {
      throw new TypeError(
        `session date must be an ISO YYYY-MM-DD string; got ${JSON.stringify(s.date)}`,
      );
    }
    if (!Number.isFinite(s.open) || !Number.isFinite(s.close)) {
      throw new TypeError(
        `session ${s.date}: open/close must be finite epoch-ms`,
      );
    }
    if (s.close <= s.open) {
      throw new RangeError(
        `session ${s.date}: close (${s.close}) must be > open (${s.open})`,
      );
    }
    if (s.breaks) {
      let prevEnd = s.open;
      for (const b of s.breaks) {
        if (!Number.isFinite(b.start) || !Number.isFinite(b.end)) {
          throw new TypeError(
            `session ${s.date}: break bounds must be finite epoch-ms`,
          );
        }
        if (b.end <= b.start) {
          throw new RangeError(`session ${s.date}: break end must be > start`);
        }
        if (b.start < prevEnd || b.end > s.close) {
          throw new RangeError(
            `session ${s.date}: breaks must be sorted, non-overlapping, and within (open, close)`,
          );
        }
        prevEnd = b.end;
      }
    }
  }

  sessions.sort((a, b) => a.open - b.open);

  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1]!;
    const cur = sessions[i]!;
    if (cur.date === prev.date) {
      throw new RangeError(`duplicate session date: ${cur.date}`);
    }
    if (cur.open < prev.close) {
      throw new RangeError(
        `sessions overlap: ${prev.date} [${prev.open}, ${prev.close}) and ${cur.date} [${cur.open}, ${cur.close})`,
      );
    }
    // Date labels must agree with open order — the calendar's by-date bisection
    // relies on the session list being sorted by date and by open together.
    if (cur.date < prev.date) {
      throw new RangeError(
        `session date order disagrees with open times: ${prev.date} opens before ${cur.date}`,
      );
    }
  }

  return sessions;
}
