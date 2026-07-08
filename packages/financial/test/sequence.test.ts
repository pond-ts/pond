import { describe, it, expect } from 'vitest';
import { TimeSeries, BoundedSequence } from 'pond-ts';
import { TradingCalendar, type Session } from '../src/index.js';

const H = 3_600_000;
const MIN = 60_000;
const D0 = Date.UTC(2021, 0, 4); // Mon
const D2 = Date.UTC(2021, 0, 6); // Wed  (Tue 2021-01-05 is treated as a holiday)

// Two 09:00–12:00 UTC sessions with Tuesday missing (a mid-week gap), and a
// lunch break on Wednesday to exercise break-aware bar splitting.
const sessions: Session[] = [
  { date: '2021-01-04', open: D0 + 9 * H, close: D0 + 12 * H },
  {
    date: '2021-01-06',
    open: D2 + 9 * H,
    close: D2 + 12 * H,
    breaks: [{ start: D2 + 10 * H, end: D2 + 11 * H }],
  },
];
const cal = TradingCalendar.fromSessions(sessions);

describe('sessionSequence', () => {
  it('emits one interval per session, labelled by date, skipping the gap', () => {
    const seq = cal.sessionSequence();
    expect(seq).toBeInstanceOf(BoundedSequence);
    const ivals = seq.intervals();
    expect(ivals.map((i) => i.value)).toEqual(['2021-01-04', '2021-01-06']);
    expect(ivals.map((i) => [i.begin(), i.end()])).toEqual([
      [D0 + 9 * H, D0 + 12 * H],
      [D2 + 9 * H, D2 + 12 * H], // spans the lunch — daily bar covers the break
    ]);
  });

  it('restricts to the given range', () => {
    const seq = cal.sessionSequence({ start: D2, end: D2 + 24 * H });
    expect(seq.intervals().map((i) => i.value)).toEqual(['2021-01-06']);
  });
});

describe('barSequence', () => {
  it('subdivides each session into period bars, breaking at the lunch', () => {
    const seq = cal.barSequence('1h');
    const spans = seq.intervals().map((i) => [i.begin(), i.end()]);
    expect(spans).toEqual([
      // Monday: 3 clean hourly bars.
      [D0 + 9 * H, D0 + 10 * H],
      [D0 + 10 * H, D0 + 11 * H],
      [D0 + 11 * H, D0 + 12 * H],
      // Wednesday: 09–10, then the 10–11 lunch is skipped, then 11–12.
      [D2 + 9 * H, D2 + 10 * H],
      [D2 + 11 * H, D2 + 12 * H],
    ]);
  });

  it('truncates the final bar of a segment at the close (force-close)', () => {
    // 90-minute bars on a 3-hour session → 09:00, 10:30, and a short 11:30–12:00.
    const seq = cal.barSequence('90m', { start: D0, end: D0 + 24 * H });
    expect(seq.intervals().map((i) => [i.begin(), i.end()])).toEqual([
      [D0 + 9 * H, D0 + 10 * H + 30 * MIN],
      [D0 + 10 * H + 30 * MIN, D0 + 12 * H],
    ]);
  });

  it('accepts a numeric (ms) period and rejects non-positive periods', () => {
    // 3h bars: Monday = one [09,12) bar; Wednesday's lunch splits it into
    // [09,10) and [11,12) — 3 bars total.
    expect(cal.barSequence(3 * H).intervals().length).toBe(3);
    expect(() => cal.barSequence(0)).toThrow(/> 0/);
    expect(() => cal.barSequence('5x' as never)).toThrow(/invalid duration/);
  });
});

describe('empty / out-of-range', () => {
  it('an empty calendar yields empty sequences', () => {
    const empty = TradingCalendar.fromSessions([]);
    expect(empty.sessionSequence().intervals()).toEqual([]);
    expect(empty.barSequence('1h').intervals()).toEqual([]);
  });

  it('a range covering no session yields an empty sequence', () => {
    const gap = { start: Date.UTC(2021, 0, 5), end: Date.UTC(2021, 0, 5, 23) }; // Tuesday
    expect(cal.sessionSequence(gap).intervals()).toEqual([]);
    expect(cal.barSequence('1h', gap).intervals()).toEqual([]);
  });
});

describe('flow-through: BoundedSequence → aggregate', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'price', kind: 'number' },
  ] as const;

  // Points in each Monday & Wednesday bar, plus two that fall in closed time:
  // one in the Tuesday gap and one after Monday's close.
  const series = new TimeSeries({
    name: 'px',
    schema,
    rows: [
      [D0 + 9 * H + 30 * MIN, 10],
      [D0 + 10 * H + 30 * MIN, 11],
      [D0 + 11 * H + 30 * MIN, 12],
      [D0 + 12 * H + 30 * MIN, 999], // after Monday close — closed time
      [Date.UTC(2021, 0, 5) + 10 * H, 888], // Tuesday — no session
      [D2 + 9 * H + 30 * MIN, 20],
      [D2 + 11 * H + 30 * MIN, 22],
    ],
  });

  it('daily sessionSequence buckets to two sessions, dropping closed-time points', () => {
    const agg = series.aggregate(cal.sessionSequence(), { price: 'last' });
    const rows = agg.toArray();
    expect(rows.length).toBe(2);
    expect(rows.map((e) => e.get('price'))).toEqual([12, 22]);
    // The 888 (Tue) and 999 (after close) points landed in no bucket.
    const allValues = rows.map((e) => e.get('price'));
    expect(allValues).not.toContain(888);
    expect(allValues).not.toContain(999);
  });

  it('intraday barSequence never produces a weekend/gap bucket', () => {
    const agg = series.aggregate(cal.barSequence('1h'), { price: 'last' });
    // 5 bars (3 Mon + 2 Wed). Every bucket begins inside a real session.
    expect(agg.toArray().length).toBe(5);
    for (const e of agg.toArray()) {
      expect(cal.sessionContaining(e.begin())).toBeDefined();
    }
  });
});
