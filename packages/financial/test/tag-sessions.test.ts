import { describe, it, expect } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { TradingCalendar, type Session } from '../src/index.js';

const H = 3_600_000;
const MIN = 60_000;
const D0 = Date.UTC(2021, 0, 4); // Mon
const D2 = Date.UTC(2021, 0, 6); // Wed (Tue is a gap)

const sessions: Session[] = [
  { date: '2021-01-04', open: D0 + 9 * H, close: D0 + 12 * H },
  { date: '2021-01-06', open: D2 + 9 * H, close: D2 + 12 * H },
];
const cal = TradingCalendar.fromSessions(sessions);
const MON_ID = D0 + 9 * H;
const WED_ID = D2 + 9 * H;

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
] as const;

describe('tagSessions', () => {
  it('tags each event with its session open id, undefined in closed time', () => {
    const series = new TimeSeries({
      name: 'px',
      schema,
      rows: [
        [D0 + 8 * H, 1], // before Monday open — closed
        [D0 + 10 * H, 2], // Monday session
        [D0 + 13 * H, 3], // after Monday close — closed
        [Date.UTC(2021, 0, 5) + 10 * H, 4], // Tuesday gap — no session
        [D2 + 10 * H, 5], // Wednesday session
        [D2 + 20 * H, 6], // after Wednesday close — closed
      ],
    });
    const tagged = cal.tagSessions(series);
    expect(tagged.toArray().map((e) => e.get('session'))).toEqual([
      undefined,
      MON_ID,
      undefined,
      undefined,
      WED_ID,
      undefined,
    ]);
  });

  it('types the session column as number | undefined (closed time is undefined)', () => {
    const series = new TimeSeries({
      name: 'px',
      schema,
      rows: [[D0 + 10 * H, 2]],
    });
    const tagged = cal.tagSessions(series);
    const e = tagged.at(0)!;
    const id: number | undefined = e.get('session');
    expect(id).toBe(MON_ID);
    // The column must NOT type as a bare `number` — it holds undefined in
    // closed time, so consuming it as number would crash at runtime.
    // @ts-expect-error session may be undefined
    const bad: number = e.get('session');
    void bad;
  });

  it('honors a custom column name', () => {
    const series = new TimeSeries({
      name: 'px',
      schema,
      rows: [[D0 + 10 * H, 2]],
    });
    const tagged = cal.tagSessions(series, { column: 'sid' });
    expect(tagged.at(0)?.get('sid')).toBe(MON_ID);
  });

  it('throws if the column already exists', () => {
    const series = new TimeSeries({
      name: 'px',
      schema,
      rows: [[D0 + 10 * H, 2]],
    });
    expect(() => cal.tagSessions(series, { column: 'price' })).toThrow();
  });

  it("stamped:'close' — a bar stamped at the close belongs to the closing session", () => {
    // The real-fixture finding: a feed stamps each bar at its close, so the last
    // Monday bar is stamped at 12:00 (== Monday's close). Under the default
    // open-stamp `[open, close)` that lands in closed time; close-stamping owns
    // `(open, close]`, so it belongs to Monday.
    const series = new TimeSeries({
      name: 'px',
      schema,
      rows: [
        [D0 + 9 * H, 1], // exactly Monday's open — the previous bar's close-stamp
        [D0 + 10 * H, 2], // mid Monday
        [D0 + 12 * H, 3], // exactly Monday's close — the last Monday bar
        [D2 + 12 * H, 4], // exactly Wednesday's close — the last Wednesday bar
      ],
    });

    // Default (open-stamped): the 12:00 close bars fall in closed time.
    expect(
      cal
        .tagSessions(series)
        .toArray()
        .map((e) => e.get('session')),
    ).toEqual([MON_ID, MON_ID, undefined, undefined]);

    // Close-stamped: the 12:00 bars join their closing session; the 9:00 open
    // instant is now the *previous* bar's close, so it no longer joins Monday.
    expect(
      cal
        .tagSessions(series, { stamped: 'close' })
        .toArray()
        .map((e) => e.get('session')),
    ).toEqual([undefined, MON_ID, MON_ID, WED_ID]);
  });

  it("stamped:'close' — a boundary instant between contiguous sessions joins the one that closed", () => {
    // Two back-to-back sessions with no gap (a 24h market split at midnight):
    // the shared boundary is session A's close and session B's open.
    const A = Date.UTC(2021, 0, 4);
    const MID = A + 24 * H; // midnight Jan 5 — A's close and B's open
    const contiguous = TradingCalendar.fromSessions([
      { date: '2021-01-04', open: A, close: MID },
      { date: '2021-01-05', open: MID, close: MID + 12 * H },
    ]);
    const series = new TimeSeries({
      name: 'px',
      schema,
      rows: [[MID, 1]], // the shared midnight boundary
    });
    // Close-stamped → the closing session (A). Open-stamped → the opening one (B).
    expect(
      contiguous
        .tagSessions(series, { stamped: 'close' })
        .at(0)
        ?.get('session'),
    ).toBe(A);
    expect(contiguous.tagSessions(series).at(0)?.get('session')).toBe(MID);
  });

  it('the session id is the align/rolling stopgap: partitionBy(session) does not bridge sessions', () => {
    // price known on Monday, missing at Wednesday's first bar, known after.
    const optionalSchema = [
      { name: 'time', kind: 'time' },
      { name: 'price', kind: 'number', required: false },
    ] as const;
    const series = new TimeSeries({
      name: 'px',
      schema: optionalSchema,
      rows: [
        [D0 + 9 * H + 30 * MIN, 10],
        [D0 + 10 * H + 30 * MIN, 12],
        [D2 + 9 * H + 30 * MIN, undefined], // Wednesday's first bar — missing
        [D2 + 10 * H + 30 * MIN, 22],
      ],
    });
    const tagged = cal.tagSessions(series);

    // Plain forward-fill bridges the overnight gap: Wednesday's missing value
    // inherits Monday's last (12).
    const bridged = tagged.fill({ price: 'hold' });
    expect(bridged.toArray().map((e) => e.get('price'))).toEqual([
      10, 12, 12, 22,
    ]);

    // Partitioned by session, Wednesday's leading gap has no prior value in its
    // own partition, so it stays missing — the fill does not cross the closure.
    const perSession = tagged
      .partitionBy('session')
      .fill({ price: 'hold' })
      .collect();
    expect(perSession.toArray().map((e) => e.get('price'))).toEqual([
      10,
      12,
      undefined,
      22,
    ]);
  });
});
