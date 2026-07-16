import { describe, expect, it } from 'vitest';
import {
  boundaryGrainFor,
  boundaryTicks,
  buildTicks,
  bucketKey,
  coarsenCalendar,
  flatBaseFormatFor,
  flatFormats,
  type TickGranularity,
} from '../src/tickLadder.js';
import { identityProvider } from '../src/tradingTimeScale.js';
import type { DiscontinuityProvider } from '../src/tradingTimeScale.js';

const H = 3_600_000;
const DAY = 24 * H;

/** A segment-based provider (live `[start, end)` spans; gaps excised). */
function segmentProvider(
  segments: ReadonlyArray<readonly [number, number]>,
): DiscontinuityProvider {
  const cum = [0];
  for (const [a, b] of segments) cum.push(cum[cum.length - 1]! + (b - a));
  const total = cum[cum.length - 1]!;
  const liveMs = (t: number): number => {
    if (t <= segments[0]![0]) return 0;
    if (t >= segments[segments.length - 1]![1]) return total;
    for (let i = 0; i < segments.length; i++) {
      const [a, b] = segments[i]!;
      if (t < a) return cum[i]!;
      if (t < b) return cum[i]! + (t - a);
    }
    return total;
  };
  const instantFor = (L: number): number => {
    if (L <= 0) return segments[0]![0];
    if (L >= total) return segments[segments.length - 1]![1];
    for (let i = 0; i < segments.length; i++) {
      if (L < cum[i + 1]!) return segments[i]![0] + (L - cum[i]!);
    }
    return segments[segments.length - 1]![1];
  };
  const self: DiscontinuityProvider = {
    distance: (from, to) => liveMs(to) - liveMs(from),
    offset: (v, amt) => instantFor(liveMs(v) + amt),
    clampUp: (t) => t,
    clampDown: (t) => t,
    copy: () => self,
    boundaries: (from, to) => {
      const out: number[] = [];
      for (let i = 1; i < segments.length; i++) {
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

/** `n` daily 09:30–16:00-local-ish sessions from `startDay` (a local date). */
function dailySessions(
  startDay: number,
  n: number,
): Array<readonly [number, number]> {
  return Array.from({ length: n }, (_, i) => [
    startDay + i * DAY + 9.5 * H,
    startDay + i * DAY + 16 * H,
  ]);
}

function grainOf(
  segments: ReadonlyArray<readonly [number, number]>,
  cap: number,
): { granularity: TickGranularity; count: number } {
  const prov = segmentProvider(segments);
  const domainEnd = segments[segments.length - 1]![1];
  const opens = [
    segments[0]![0],
    ...prov.boundaries!(segments[0]![0], domainEnd),
  ];
  const { ticks, granularity } = buildTicks(prov, opens, domainEnd, cap);
  expect(ticks.length).toBeLessThanOrEqual(Math.max(cap, 1));
  expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  return { granularity, count: ticks.length };
}

describe('buildTicks — the grain matrix over (span, cap)', () => {
  // A local-time anchor well away from DST transitions.
  const d0 = new Date(2026, 0, 5).getTime(); // Mon Jan 5 2026, local midnight

  it('one 6.5h session ladders down to hours as the cap grows', () => {
    const one = dailySessions(d0, 1);
    expect(grainOf(one, 2).granularity).toBe('hour6');
    expect(grainOf(one, 4).granularity).toBe('hour3');
    expect(grainOf(one, 8).granularity).toBe('hour1');
  });

  it('a week of sessions: day grain at a modest cap, hours with room', () => {
    const week = dailySessions(d0, 5);
    expect(grainOf(week, 6)).toEqual({ granularity: 'day', count: 5 });
    expect(grainOf(week, 12).granularity).toBe('hour6');
  });

  it('a month of sessions thins to an even day-stride, not a cliff to weekly', () => {
    // 28 contiguous days over a cap of 8: the day count exceeds the cap, but
    // rather than dropping ~7× straight to weekly (the old density cliff), it
    // thins to an evenly spaced day-stride — still day grain, ~cap ticks, with
    // a single uniform gap between marks (no round-number bias).
    const month = dailySessions(d0, 28);
    const { granularity, count } = grainOf(month, 8);
    expect(granularity).toBe('day');
    expect(count).toBeGreaterThan(4); // not the 4-tick weekly collapse
    expect(count).toBeLessThanOrEqual(8);
    const prov = segmentProvider(month);
    const opens = [
      month[0]![0],
      ...prov.boundaries!(month[0]![0], month[27]![1]),
    ];
    const ticks = buildTicks(prov, opens, month[27]![1], 8).ticks;
    // Uniform spacing: every consecutive gap is the same whole number of days.
    const DAY_MS = 24 * H;
    const gaps = ticks
      .slice(1)
      .map((t, i) => Math.round((t - ticks[i]!) / DAY_MS));
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBeGreaterThan(1); // actually thinned, not every day
  });

  it('a longer run still reaches week grain once the day-stride overflows', () => {
    // ~8 weeks of daily sessions at a cap of 8: even the coarsest day-stride
    // (every 6th) exceeds the cap, so it falls through to weekly.
    const eightWeeks = dailySessions(d0, 56);
    expect(grainOf(eightWeeks, 8).granularity).toBe('week');
  });

  it('a year of sessions coarsens to months', () => {
    const year = dailySessions(d0, 365);
    const { granularity, count } = grainOf(year, 13);
    expect(granularity).toBe('month');
    expect(count).toBeGreaterThanOrEqual(12);
  });

  it('several years coarsen to quarters, then years, at narrower caps', () => {
    const years = dailySessions(d0, 900);
    expect(grainOf(years, 12).granularity).toBe('quarter');
    expect(grainOf(years, 4).granularity).toBe('year');
  });

  it('hour anchors are clock-aligned and only inside live sessions', () => {
    const one = dailySessions(d0, 1); // 09:30–16:00 local
    const prov = segmentProvider(one);
    const { ticks, granularity } = buildTicks(
      prov,
      [one[0]![0]],
      one[0]![1],
      8,
    );
    expect(granularity).toBe('hour1');
    // The open itself, then 10:00, 11:00, … 15:00 local — aligned, in-session.
    expect(ticks[0]).toBe(one[0]![0]);
    for (const t of ticks.slice(1)) {
      expect(new Date(t).getMinutes()).toBe(0);
      expect(t).toBeGreaterThan(one[0]![0]);
      expect(t).toBeLessThan(one[0]![1]);
    }
  });

  it('a lunch-break session gets no anchor inside the break', () => {
    // Morning 09:00–12:00, afternoon 13:30–16:00 — a mid-day discontinuity.
    const morning = [d0 + 9 * H, d0 + 12 * H] as const;
    const afternoon = [d0 + 13.5 * H, d0 + 16 * H] as const;
    const prov = segmentProvider([morning, afternoon]);
    const opens = [morning[0], afternoon[0]];
    const { ticks } = buildTicks(prov, opens, afternoon[1], 10);
    for (const t of ticks) {
      expect(t >= morning[1] && t < afternoon[0]).toBe(false);
    }
    // The afternoon reopen is itself an anchor.
    expect(ticks).toContain(afternoon[0]);
  });

  it('the identity provider runs the same ladder over calendar days', () => {
    const prov = identityProvider();
    const from = new Date(2026, 0, 1).getTime();
    const to = new Date(2027, 0, 1).getTime();
    const opens = [from, ...prov.boundaries!(from, to)];
    const { granularity, ticks } = buildTicks(prov, opens, to, 13);
    expect(granularity).toBe('month');
    expect(ticks.length).toBe(12);
    // Every tick is a local month start.
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getDate()).toBe(1);
      expect(d.getHours()).toBe(0);
    }
  });

  it('drops a cramped leading partial-period anchor (the "Jun 23Jul 07" pile-up)', () => {
    // A year of continuous days starting Jun 23 — the domain-start tick sits
    // ~8 live days from the Jul 01 month tick (< half a month), so it's
    // dropped rather than colliding with it.
    const prov = identityProvider();
    const from = new Date(2025, 5, 23).getTime();
    const to = new Date(2026, 5, 23).getTime();
    const opens = [from, ...prov.boundaries!(from, to)];
    const { ticks, granularity } = buildTicks(prov, opens, to, 13);
    expect(granularity).toBe('month');
    expect(ticks[0]).not.toBe(from);
    expect(new Date(ticks[0]!).getDate()).toBe(1); // Jul 01, a full period
    // A start near a period boundary keeps its lead anchor: from Jun 2 the
    // lead gap (~29 live days) is nearly a full month.
    const from2 = new Date(2025, 5, 2).getTime();
    const opens2 = [from2, ...prov.boundaries!(from2, to)];
    expect(buildTicks(prov, opens2, to, 13).ticks[0]).toBe(from2);
  });

  it('a sub-hour continuous domain descends to minute grain, never one day tick', () => {
    // A ~40-minute window (the annotation-story shape) must tick on minutes —
    // before the second/minute rungs existed it collapsed to a single
    // day-grain tick at the domain start.
    const prov = identityProvider();
    const from = new Date(2026, 0, 1, 5, 10).getTime();
    const to = new Date(2026, 0, 1, 5, 50).getTime();
    const { granularity, ticks } = buildTicks(prov, [from], to, 10);
    expect(granularity).toBe('minute5');
    expect(ticks.length).toBeGreaterThan(3);
    expect(
      ticks.slice(1).every((t) => new Date(t).getMinutes() % 5 === 0),
    ).toBe(true);
  });

  it('a seconds-wide domain descends to second grain', () => {
    const prov = identityProvider();
    const from = new Date(2026, 0, 1, 5, 10, 2).getTime();
    const to = from + 60_000; // one minute
    const { granularity, ticks } = buildTicks(prov, [from], to, 8);
    expect(granularity).toBe('second15');
    expect(ticks.length).toBeGreaterThan(2);
  });

  it('an intraday continuous domain gets clock-aligned hour ticks', () => {
    const prov = identityProvider();
    const from = new Date(2026, 0, 5, 9, 13).getTime(); // an arbitrary instant
    const to = new Date(2026, 0, 5, 17, 0).getTime();
    const opens = [from, ...prov.boundaries!(from, to)];
    const { granularity, ticks } = buildTicks(prov, opens, to, 10);
    expect(granularity).toBe('hour1');
    // The domain start, then 10:00, 11:00, … — aligned to the clock.
    expect(ticks[0]).toBe(from);
    expect(ticks.slice(1).every((t) => new Date(t).getMinutes() === 0)).toBe(
      true,
    );
  });
});

describe('grain stability under a sliding live window', () => {
  it('a fixed-span window keeps one grain at every slide phase (no flicker)', () => {
    // The LiveSine bug: a 240s window sliding 1s/frame holds 8 or 9 aligned
    // 30s marks depending on phase; with a cap of 8 the exact count flipped
    // the grain second30 ↔ minute1 for single frames. Selection now uses the
    // span estimate, which is constant while sliding.
    const prov = identityProvider();
    const span = 239_000; // 240 × 1s points
    const start = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const grains = new Set<string>();
    for (let slide = 0; slide < 180; slide++) {
      const from = start + slide * 1_000;
      const to = from + span;
      const opens = [from, ...prov.boundaries!(from, to)];
      grains.add(buildTicks(prov, opens, to, 8).granularity);
    }
    expect([...grains]).toHaveLength(1);
  });

  it('the stable grain matches the density budget (count may exceed cap by ~1)', () => {
    const prov = identityProvider();
    const start = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const { ticks, granularity } = buildTicks(
      prov,
      [start],
      start + 239_000,
      8,
    );
    expect(granularity).toBe('second30');
    expect(ticks.length).toBeGreaterThanOrEqual(8);
    expect(ticks.length).toBeLessThanOrEqual(10);
  });
});

describe('near-cap multi-session enumeration (the #465 truncation edge)', () => {
  it('every session keeps its ticks when each session gains a phase tick at a near-cap estimate', () => {
    // 16 sessions of 08:59–15:01: each spans 6h02m, so the span estimate
    // counts 6 hour-marks per session (16 + 96 = 112 total), but the real
    // enumeration lands 7 aligned marks in each (09:00 … 15:00 — a phase
    // tick gained per session). At cap 112 the hour1 rung is admitted with
    // the estimate exactly at the cap while the real count is 128; the old
    // `cap + 4` enumeration bail truncated mid-array yet still passed the
    // earns-its-labels acceptance, so the final sessions were returned with
    // no ticks at all (the lopsided axis from the PR #465 spot-check).
    const d0 = new Date(2026, 0, 5).getTime(); // Mon Jan 5 2026, local
    const sessions = Array.from(
      { length: 16 },
      (_, i) =>
        [
          d0 + i * DAY + 8 * H + 59 * 60_000,
          d0 + i * DAY + 15 * H + 60_000,
        ] as const,
    );
    const prov = segmentProvider(sessions);
    const domainEnd = sessions[sessions.length - 1]![1];
    const opens = [
      sessions[0]![0],
      ...prov.boundaries!(sessions[0]![0], domainEnd),
    ];
    expect(opens).toHaveLength(16);
    const { ticks, granularity } = buildTicks(prov, opens, domainEnd, 112);
    expect(granularity).toBe('hour1');
    // Complete enumeration: 16 opens + 16 × 7 marks, minus the cramped
    // 08:59 lead (1min from the 09:00 mark) that buildTicks always drops.
    expect(ticks).toHaveLength(127);
    // Every session is represented — in particular the final ones, which
    // the truncated array cut off entirely.
    for (const open of opens.slice(1)) expect(ticks).toContain(open);
    expect(ticks[ticks.length - 1]).toBe(
      sessions[sessions.length - 1]![0] + 60_000 + 6 * H, // final 15:00 mark
    );
  });
});

describe('boundaryTicks — the second-row flags', () => {
  it('flags crossings only — never the first tick (context is pinned, not ridden)', () => {
    // Month-grain ticks straddling a year turn: Nov, Dec, Jan, Feb. Only the
    // Jan tick is a crossing; the left-edge context is boundaryContext's job.
    const ticks = [
      new Date(2025, 10, 3).getTime(),
      new Date(2025, 11, 1).getTime(),
      new Date(2026, 0, 2).getTime(),
      new Date(2026, 1, 2).getTime(),
    ];
    expect(boundaryTicks(ticks, 'month')).toEqual([ticks[2]]);
  });

  it('flags every day change under an hour grain', () => {
    const day1 = new Date(2026, 0, 5, 10).getTime();
    const day2 = new Date(2026, 0, 6, 10).getTime();
    const ticks = [day1, day1 + 3 * H, day2, day2 + 3 * H];
    expect(boundaryTicks(ticks, 'hour3')).toEqual([day2]);
  });

  it('day/week grain boundaries on the year, not the month (no repeated unit)', () => {
    // A `Jan 05` label already carries the month — the boundary row adds only
    // the year, and only when it changes (plus the first tick).
    expect(boundaryGrainFor('day')).toBe('year');
    expect(boundaryGrainFor('week')).toBe('year');
    const ticks = [
      new Date(2025, 11, 30, 9, 30).getTime(),
      new Date(2025, 11, 31, 9, 30).getTime(),
      new Date(2026, 0, 2, 9, 30).getTime(),
      new Date(2026, 0, 5, 9, 30).getTime(),
    ];
    expect(boundaryTicks(ticks, 'day')).toEqual([ticks[2]]);
  });

  it('year grain has no boundary row', () => {
    expect(boundaryGrainFor('year')).toBeUndefined();
    const ticks = [
      new Date(2024, 0, 2).getTime(),
      new Date(2025, 0, 2).getTime(),
    ];
    expect(boundaryTicks(ticks, 'year')).toEqual([]);
  });

  it('bucketKey groups same-local-day instants at day grain', () => {
    const a = new Date(2026, 0, 5, 9, 30).getTime();
    const b = new Date(2026, 0, 5, 15, 0).getTime();
    const c = new Date(2026, 0, 6, 9, 30).getTime();
    expect(bucketKey(a, 'day')).toBe(bucketKey(b, 'day'));
    expect(bucketKey(a, 'day')).not.toBe(bucketKey(c, 'day'));
  });
});

describe('flatFormats — the single-row inline promotions', () => {
  const at = (y: number, m: number, d: number, h = 0) =>
    new Date(y, m, d, h).getTime();

  it('day grain: bare day-of-month, month name at the month turn', () => {
    // … 30 31 Feb 2 3 — Feb 01 promotes to the month, the rest stay terse.
    const ticks = [
      at(2026, 0, 30),
      at(2026, 0, 31),
      at(2026, 1, 1),
      at(2026, 1, 2),
      at(2026, 1, 3),
    ];
    expect(flatFormats(ticks, 'day', at(2026, 0, 29))).toEqual([
      '%-d',
      '%-d',
      '%b',
      '%-d',
      '%-d',
    ]);
  });

  it('day grain: the year wins over the month at Jan 01 (coarsest promotion)', () => {
    const ticks = [
      at(2025, 11, 30),
      at(2025, 11, 31),
      at(2026, 0, 1),
      at(2026, 0, 2),
    ];
    expect(flatFormats(ticks, 'day', at(2025, 11, 29))).toEqual([
      '%-d',
      '%-d',
      '%Y', // not '%b' — Jan 01 opens the year, the coarser period
      '%-d',
    ]);
  });

  it('month grain: month abbrev, the year at January', () => {
    // Nov Dec 2026 Feb Mar — the January tick carries the year.
    const ticks = [
      at(2025, 10, 1),
      at(2025, 11, 1),
      at(2026, 0, 1),
      at(2026, 1, 1),
      at(2026, 2, 1),
    ];
    expect(flatFormats(ticks, 'month', at(2025, 9, 1))).toEqual([
      '%b',
      '%b',
      '%Y',
      '%b',
      '%b',
    ]);
  });

  it('sub-day grain: clock time, the date at a plain midnight', () => {
    // 22:00 23:00 [Feb 3] 01:00 — the day turn promotes to `%b %-d`, keeping
    // its month so the date reads unambiguously among clock ticks.
    const ticks = [
      at(2026, 1, 2, 22),
      at(2026, 1, 2, 23),
      at(2026, 1, 3, 0),
      at(2026, 1, 3, 1),
    ];
    expect(flatFormats(ticks, 'hour1', at(2026, 1, 2, 21))).toEqual([
      '%H:%M',
      '%H:%M',
      '%b %-d',
      '%H:%M',
    ]);
  });

  it('week grain: bare day-of-month, the month at the first week of a new month', () => {
    // Monday-anchored week ticks; the first week landing in February promotes
    // to the month, the rest read their bare day-of-month.
    const ticks = [
      at(2026, 0, 19),
      at(2026, 0, 26),
      at(2026, 1, 2),
      at(2026, 1, 9),
    ];
    expect(flatFormats(ticks, 'week', at(2026, 0, 12))).toEqual([
      '%-d',
      '%-d',
      '%b',
      '%-d',
    ]);
  });

  it('sub-day grain: the month (not the date) at a midnight that opens a month', () => {
    // Feb 01 00:00 turns both the day and the month; the coarser month wins, so
    // it reads the bare month (`%b`), not the day-turn `%b %-d`.
    const ticks = [
      at(2026, 0, 31, 22),
      at(2026, 0, 31, 23),
      at(2026, 1, 1, 0),
      at(2026, 1, 1, 1),
    ];
    expect(flatFormats(ticks, 'hour1', at(2026, 0, 31, 21))).toEqual([
      '%H:%M',
      '%H:%M',
      '%b',
      '%H:%M',
    ]);
  });

  it('sub-day grain: the year at a midnight that is also Jan 01', () => {
    const ticks = [at(2025, 11, 31, 23), at(2026, 0, 1, 0), at(2026, 0, 1, 1)];
    expect(flatFormats(ticks, 'hour1', at(2025, 11, 31, 22))).toEqual([
      '%H:%M',
      '%Y', // day + month + year all turn; the year wins
      '%H:%M',
    ]);
  });

  it('second grain shows seconds in its base label', () => {
    expect(flatBaseFormatFor('second15')).toBe('%H:%M:%S');
    expect(flatBaseFormatFor('minute5')).toBe('%H:%M');
    expect(flatBaseFormatFor('hour3')).toBe('%H:%M');
  });

  it('year grain never promotes — every tick is the bare year', () => {
    const ticks = [at(2024, 0, 1), at(2025, 0, 1), at(2026, 0, 1)];
    expect(flatFormats(ticks, 'year', at(2023, 0, 1))).toEqual([
      '%Y',
      '%Y',
      '%Y',
    ]);
  });

  it('seeds from the domain start: a first tick crossing the edge promotes', () => {
    // Domain opens Dec 31; the first tick Jan 01 IS a crossing → year.
    expect(
      flatFormats([at(2026, 0, 1), at(2026, 0, 2)], 'day', at(2025, 11, 31)),
    ).toEqual(['%Y', '%-d']);
    // A first tick sharing the edge's period is not a crossing (no flicker on
    // a live window opening mid-month).
    expect(
      flatFormats([at(2026, 0, 15), at(2026, 0, 16)], 'day', at(2026, 0, 14)),
    ).toEqual(['%-d', '%-d']);
  });

  it('without a domain start the first tick is never promoted', () => {
    expect(flatFormats([at(2026, 0, 1), at(2026, 0, 2)], 'day')).toEqual([
      '%-d',
      '%-d',
    ]);
  });
});

describe('coarsenCalendar (day-and-coarser compat surface)', () => {
  it('keeps returning every open below the cap, now as day grain', () => {
    const opens = [0, DAY, 2 * DAY].map(
      (t) => new Date(2026, 0, 5).getTime() + t + 9.5 * H,
    );
    expect(coarsenCalendar(opens, 6)).toEqual({
      ticks: opens,
      granularity: 'day',
    });
  });

  it('thins to an even day-stride before weekly (the anti-cliff rungs)', () => {
    // 40 consecutive days over a cap of 10: too many for every-day, but an even
    // day-stride keeps it at day grain instead of collapsing to weekly — and
    // the marks are uniformly spaced, not snapped to round day numbers.
    const start = new Date(2026, 0, 1).getTime();
    const opens = Array.from({ length: 40 }, (_, i) => start + i * DAY);
    const { ticks, granularity } = coarsenCalendar(opens, 10);
    expect(granularity).toBe('day');
    expect(ticks.length).toBeGreaterThan(4); // denser than the weekly collapse
    expect(ticks.length).toBeLessThanOrEqual(10);
    // One uniform gap between every consecutive mark (even spacing).
    const gaps = ticks
      .slice(1)
      .map((t, i) => Math.round((t - ticks[i]!) / DAY));
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBeGreaterThan(1);
  });
});
