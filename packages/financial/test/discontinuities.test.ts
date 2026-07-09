import { describe, it, expect } from 'vitest';
import {
  segmentDiscontinuity,
  TradingCalendar,
  type LiveSegment,
  type Session,
} from '../src/index.js';

describe('segmentDiscontinuity', () => {
  // Two live spans with a gap between them: [0,100) — gap — [200,300).
  const segs: LiveSegment[] = [
    [0, 100],
    [200, 300],
  ];
  const p = segmentDiscontinuity(segs);

  it('distance excises the gap, stays proportional within a span', () => {
    expect(p.distance(0, 100)).toBe(100); // whole first span
    expect(p.distance(0, 250)).toBe(150); // 100 + (250-200); gap 100..200 free
    expect(p.distance(0, 300)).toBe(200); // total live ms
    expect(p.distance(120, 180)).toBe(0); // both inside the gap
    expect(p.distance(50, 60)).toBe(10); // within a span
  });

  it('distance is signed', () => {
    expect(p.distance(250, 0)).toBe(-150);
  });

  it('clampUp/clampDown snap values inside an internal gap', () => {
    expect(p.clampUp(150)).toBe(200); // gap → next span start
    expect(p.clampDown(150)).toBe(100); // gap → prev span end
    expect(p.clampUp(50)).toBe(50); // inside a span → unchanged
    expect(p.clampDown(250)).toBe(250);
  });

  it('offset inverts distance, skipping the gap', () => {
    expect(p.offset(0, 150)).toBe(250); // 100 to end of span0, then 50 into span1
    expect(p.offset(50, 60)).toBe(210); // 50 within span0, 10 into span1 past the gap
    expect(p.offset(0, p.distance(0, 250))).toBe(250);
  });

  it('clamps live values outside the range', () => {
    expect(p.distance(0, 9999)).toBe(200); // past the end → total
    expect(p.offset(0, 9999)).toBe(300); // past the end → last span end
    expect(p.offset(0, -50)).toBe(0); // before the start → first span start
  });

  it('snaps out-of-range values to the nearest live edge in direction', () => {
    expect(p.clampUp(-5)).toBe(0); // before all → first span start
    expect(p.clampDown(400)).toBe(300); // past all → last span end
    expect(p.clampUp(400)).toBe(400); // up past the last span → no target
    expect(p.clampDown(-5)).toBe(-5); // down before the first span → no target
  });

  it('an empty segment list is a degenerate no-op', () => {
    const e = segmentDiscontinuity([]);
    expect(e.distance(0, 100)).toBe(0);
    expect(e.clampUp(50)).toBe(50);
  });

  it('treats a segment’s exclusive end consistently (half-open)', () => {
    // 100 is the exclusive end of span0 — a gap point, not live.
    expect(p.clampUp(100)).toBe(200); // gap → next start
    expect(p.clampDown(100)).toBe(100); // already the prev span end
    expect(p.distance(0, 100)).toBe(100); // full span0 length
    // Offsetting a full span from its start lands on the NEXT live instant:
    // span0's exclusive end shares its live-ms (100) with span1's start, and
    // the inverse resolves up to the live edge (200), not the gap point (100).
    expect(p.offset(0, p.distance(0, 100))).toBe(200);
  });

  it('adjacent (touching) segments stay continuously live', () => {
    const t = segmentDiscontinuity([
      [0, 100],
      [100, 200],
    ]);
    expect(t.distance(0, 200)).toBe(200); // no gap between them
    expect(t.clampUp(100)).toBe(100); // the shared boundary is live
    expect(t.clampDown(100)).toBe(100);
  });

  it('a single segment behaves like an offset identity within it', () => {
    const s = segmentDiscontinuity([[1000, 2000]]);
    expect(s.distance(1200, 1700)).toBe(500);
    expect(s.offset(1200, 500)).toBe(1700);
    expect(s.clampUp(500)).toBe(1000); // before → start
    expect(s.clampDown(5000)).toBe(2000); // after → end
  });

  it('drops zero/negative-length segments at the boundary', () => {
    const z = segmentDiscontinuity([
      [0, 100],
      [150, 150], // zero-length — ignored
      [200, 300],
    ]);
    expect(z.distance(0, 300)).toBe(200); // same as without the empty span
    expect(z.clampUp(150)).toBe(200); // the empty span is not a live target
  });

  it('boundaries lists gap-preceded segment starts strictly inside the range', () => {
    expect(p.boundaries!(-10, 400)).toEqual([200]); // the one collapse point
    expect(p.boundaries!(0, 150)).toEqual([]); // 200 not in range
    expect(p.boundaries!(200, 400)).toEqual([]); // strict: 200 == from excluded
    expect(p.boundaries!(150, 400)).toEqual([200]);
  });

  it('boundaries skips touching (gapless) segment joins', () => {
    const t = segmentDiscontinuity([
      [0, 100],
      [100, 200], // touches — no gap
    ]);
    expect(t.boundaries!(-10, 300)).toEqual([]);
  });
});

describe('segmentDiscontinuity — uniform spacing', () => {
  // A wide span [0,100) and a narrow one [200,220) — 5× the width difference.
  const segs: LiveSegment[] = [
    [0, 100],
    [200, 220],
  ];
  const u = segmentDiscontinuity(segs, { spacing: 'uniform' });

  it('gives each segment one unit of distance regardless of width', () => {
    expect(u.distance(0, 100)).toBe(1); // the wide span
    expect(u.distance(200, 220)).toBe(1); // the narrow span — equal
    expect(u.distance(0, 220)).toBe(2); // total
  });

  it('interpolates by time-fraction within a segment', () => {
    expect(u.distance(0, 50)).toBeCloseTo(0.5, 12); // halfway through the wide span
    expect(u.distance(200, 210)).toBeCloseTo(0.5, 12); // halfway through the narrow span
  });

  it('offset inverts distance across the collapsed gap', () => {
    expect(u.offset(0, 1)).toBe(200); // one unit → the second segment's start
    expect(u.offset(0, 1.5)).toBe(210); // +0.5 into the 20-wide narrow span
  });

  it('clampUp/clampDown and boundaries match the proportional provider', () => {
    const p = segmentDiscontinuity(segs);
    for (const t of [-10, 50, 150, 210, 300]) {
      expect(u.clampUp(t)).toBe(p.clampUp(t));
      expect(u.clampDown(t)).toBe(p.clampDown(t));
    }
    expect(u.boundaries!(-10, 300)).toEqual(p.boundaries!(-10, 300));
  });
});

const H = 3_600_000;
const D0 = Date.UTC(2021, 0, 4); // Mon
const D2 = Date.UTC(2021, 0, 6); // Wed (Tue is a gap)

describe('TradingCalendar.discontinuities — synthetic', () => {
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
  const p = cal.discontinuities();

  it('collapses the overnight gap between sessions', () => {
    // Mon close → Wed open: ~2 days wall-clock, zero trading-time.
    expect(p.distance(D0 + 12 * H, D2 + 9 * H)).toBe(0);
  });

  it('collapses the intraday lunch break', () => {
    // Wed 09:30 → 11:30 is 2h wall-clock spanning the 10–11 lunch → 1h live.
    expect(
      p.distance(D2 + 9 * H + 30 * 60_000, D2 + 11 * H + 30 * 60_000),
    ).toBe(60 * 60_000);
  });

  it('total trading-time is the sum of tradeable spans, not the wall-clock span', () => {
    // Mon 3h + Wed (3h − 1h lunch = 2h) = 5h, vs a ~2-day wall-clock span.
    expect(p.distance(D0 + 9 * H, D2 + 12 * H)).toBe(5 * H);
  });
});

describe('TradingCalendar.discontinuities — real NYSE week', () => {
  // A real NYSE week with Good Friday (2025-04-18) closed.
  const nyse = TradingCalendar.fromRules(
    {
      timeZone: 'America/New_York',
      open: '09:30',
      close: '16:00',
      holidays: ['2025-04-18'],
    },
    { from: '2025-04-14', to: '2025-04-18' },
  );
  const p = nyse.discontinuities();
  const sess = nyse.sessions();

  it('every overnight gap collapses to zero', () => {
    for (let i = 1; i < sess.length; i++) {
      expect(p.distance(sess[i - 1]!.close, sess[i]!.open)).toBe(0);
    }
  });

  it('spans exactly N sessions × 6.5h of trading time across the week', () => {
    // Mon–Thu trade (Good Friday closed) → 4 sessions × 6.5h.
    expect(sess.length).toBe(4);
    const first = sess[0]!;
    const last = sess[sess.length - 1]!;
    expect(p.distance(first.open, last.close)).toBe(4 * 6.5 * H);
    // …while the wall-clock span is ~4 days.
    expect(last.close - first.open).toBeGreaterThan(3 * 24 * H);
  });

  it('stays proportional within a session', () => {
    const s = sess[0]!;
    expect(p.distance(s.open, s.open + 90 * 60_000)).toBe(90 * 60_000);
  });

  it('boundaries are the session opens (overnight-gap ends)', () => {
    // 4 sessions Mon–Thu → 3 interior session opens (Tue, Wed, Thu) are dividers.
    const b = p.boundaries!(sess[0]!.open, sess[sess.length - 1]!.close);
    expect(b).toEqual([sess[1]!.open, sess[2]!.open, sess[3]!.open]);
  });
});

describe('discontinuities boundaries — with an intraday break', () => {
  it('includes the post-lunch re-open as a boundary', () => {
    const D0 = Date.UTC(2021, 0, 4);
    const D2 = Date.UTC(2021, 0, 6);
    const cal = TradingCalendar.fromSessions([
      { date: '2021-01-04', open: D0 + 9 * H, close: D0 + 12 * H },
      {
        date: '2021-01-06',
        open: D2 + 9 * H,
        close: D2 + 12 * H,
        breaks: [{ start: D2 + 10 * H, end: D2 + 11 * H }],
      },
    ]);
    const b = cal.discontinuities().boundaries!(D0 + 9 * H, D2 + 12 * H);
    // Wed open (overnight gap) + Wed 11:00 (lunch re-open).
    expect(b).toEqual([D2 + 9 * H, D2 + 11 * H]);
  });
});

describe('TradingCalendar.discontinuities — uniform spacing', () => {
  const M = Date.UTC(2021, 0, 4); // Mon — a 6h full day
  const T = Date.UTC(2021, 0, 5); // Tue — a 3h half day
  const cal = TradingCalendar.fromSessions([
    { date: '2021-01-04', open: M + 9 * H, close: M + 15 * H },
    { date: '2021-01-05', open: T + 9 * H, close: T + 12 * H },
  ]);
  const prop = cal.discontinuities();
  const uni = cal.discontinuities({ spacing: 'uniform' });

  it('each session is one equal unit regardless of duration', () => {
    // Proportional: the 6h full day is twice the 3h half day.
    expect(prop.distance(M + 9 * H, M + 15 * H)).toBe(6 * H);
    expect(prop.distance(T + 9 * H, T + 12 * H)).toBe(3 * H);
    // Uniform: both sessions span exactly one unit; the whole calendar is 2.
    expect(uni.distance(M + 9 * H, M + 15 * H)).toBe(1);
    expect(uni.distance(T + 9 * H, T + 12 * H)).toBe(1);
    expect(uni.distance(M + 9 * H, T + 12 * H)).toBe(2);
  });

  it('interpolates linearly within a session', () => {
    // Halfway through the 6h session (in time) → 0.5 units; a quarter → 0.25.
    expect(uni.distance(M + 9 * H, M + 12 * H)).toBeCloseTo(0.5, 9);
    expect(uni.distance(M + 9 * H, M + 10.5 * H)).toBeCloseTo(0.25, 9);
  });

  it('offset is the inverse of distance', () => {
    // Advance 1.5 units from the first open → the boundary (1.0) is Tuesday's
    // open, +0.5 into the 3h half day = Tue 10:30.
    expect(uni.offset(M + 9 * H, 1.5)).toBe(T + 10.5 * H);
  });

  it('the collapsed overnight gap is zero-width under either metric', () => {
    expect(uni.distance(M + 15 * H, T + 9 * H)).toBe(0);
  });

  it('boundaries are the same session opens as the proportional metric', () => {
    const range = { from: M + 9 * H, to: T + 12 * H };
    expect(uni.boundaries!(range.from, range.to)).toEqual([T + 9 * H]);
    expect(prop.boundaries!(range.from, range.to)).toEqual([T + 9 * H]);
  });

  it('with a period, each session-aligned bar is one unit (incl. a truncated stub)', () => {
    const c = TradingCalendar.fromSessions([
      { date: '2021-01-04', open: M + 9 * H, close: M + 12 * H + 30 * 60_000 },
    ]);
    const u = c.discontinuities({ spacing: 'uniform', period: '1h' });
    // Bars [9,10] [10,11] [11,12] and a 30m stub [12,12:30] → 4 units total.
    expect(u.distance(M + 9 * H, M + 12 * H + 30 * 60_000)).toBe(4);
    expect(u.distance(M + 9 * H, M + 10 * H)).toBe(1); // the first bar
    // A truncated final bar is still a full unit despite being half as long.
    expect(u.distance(M + 12 * H, M + 12 * H + 30 * 60_000)).toBe(1);
  });

  it('period-uniform bars are break-split, so a lunch re-open is a boundary', () => {
    const c = TradingCalendar.fromSessions([
      {
        date: '2021-01-04',
        open: M + 9 * H,
        close: M + 12 * H,
        breaks: [{ start: M + 10 * H, end: M + 11 * H }],
      },
    ]);
    const u = c.discontinuities({ spacing: 'uniform', period: '30m' });
    // Tradeable spans [9,10] and [11,12] → the 11:00 re-open is the collapse point.
    expect(u.boundaries!(M + 9 * H, M + 12 * H)).toEqual([M + 11 * H]);
    // Two 30m bars each side → 4 units, the lunch collapsed.
    expect(u.distance(M + 9 * H, M + 12 * H)).toBe(4);
  });

  it('session-uniform (no period) treats a session as one slot — no break divider', () => {
    // The variant where uniform and proportional legitimately diverge on
    // boundaries: proportional splits on the lunch break, session-uniform does
    // not (a daily slot spans the lunch), so only the overnight open is a
    // divider. Two sessions, the second with a lunch break.
    const c = TradingCalendar.fromSessions([
      { date: '2021-01-04', open: M + 9 * H, close: M + 12 * H },
      {
        date: '2021-01-05',
        open: T + 9 * H,
        close: T + 12 * H,
        breaks: [{ start: T + 10 * H, end: T + 11 * H }],
      },
    ]);
    const from = M + 9 * H;
    const to = T + 12 * H;
    // Proportional: overnight open (Tue) + the lunch re-open are both dividers.
    expect(c.discontinuities().boundaries!(from, to)).toEqual([
      T + 9 * H,
      T + 11 * H,
    ]);
    // Session-uniform: only the overnight open — the lunch is inside the slot.
    expect(
      c.discontinuities({ spacing: 'uniform' }).boundaries!(from, to),
    ).toEqual([T + 9 * H]);
    // And each session is one unit even though the second contains a break.
    const u = c.discontinuities({ spacing: 'uniform' });
    expect(u.distance(from, to)).toBe(2);
  });
});
