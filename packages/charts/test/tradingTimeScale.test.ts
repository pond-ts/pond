import { describe, expect, it } from 'vitest';
import {
  coarsenCalendar,
  scaleTradingTime,
  type DiscontinuityProvider,
} from '../src/tradingTimeScale.js';

/**
 * A minimal segment-based provider, inline so the charts test stays decoupled
 * from `@pond-ts/financial` (a real `TradingCalendar.discontinuities()` provider
 * satisfies the same structural shape). Live domain = sorted `[start, end)`
 * spans; everything between is excised.
 */
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

/** A provider with no boundaries (a single live span) — exercises the
 *  even-spacing tick fallback when there is no calendar structure. */
function singleSpanProvider(a: number, b: number): DiscontinuityProvider {
  const self: DiscontinuityProvider = {
    distance: (from, to) =>
      Math.min(b, Math.max(a, to)) - Math.min(b, Math.max(a, from)),
    offset: (v, amt) => Math.min(b, Math.max(a, v)) + amt,
    clampUp: (t) => t,
    clampDown: (t) => t,
    copy: () => self,
  };
  return self;
}

const H = 3_600_000;
// Two 6-hour sessions with a long overnight gap between them.
const S0 = 0;
const S1 = 100 * H; // a big wall-clock gap
const provider = segmentProvider([
  [S0, S0 + 6 * H],
  [S1, S1 + 6 * H],
]);

describe('scaleTradingTime', () => {
  const scale = scaleTradingTime(provider)
    .domain([S0, S1 + 6 * H])
    .range([0, 1200]);

  it('maps the domain endpoints to the range endpoints', () => {
    expect(scale(S0)).toBe(0);
    expect(scale(S1 + 6 * H)).toBe(1200);
  });

  it('collapses the overnight gap — both sessions get equal pixel width', () => {
    // Total trading time = 12h over 1200px → 100px/hour. Each 6h session = 600px.
    expect(scale(S0 + 6 * H)).toBeCloseTo(600, 6); // end of session 0
    expect(scale(S1)).toBeCloseTo(600, 6); // start of session 1 — same pixel
    expect(scale(S1 + 3 * H)).toBeCloseTo(900, 6); // mid session 1
  });

  it('is proportional within a session', () => {
    expect(scale(S0 + 3 * H)).toBeCloseTo(300, 6);
    expect(scale(S0 + 1 * H)).toBeCloseTo(100, 6);
  });

  it('invert round-trips a live instant', () => {
    for (const t of [S0 + H, S0 + 5 * H, S1 + H, S1 + 5 * H]) {
      expect(scale.invert(scale(t))).toBeCloseTo(t, 3);
    }
  });

  it('invert of a pixel in the collapsed gap lands at a session edge', () => {
    // The 600px point is the shared boundary; invert resolves to a live instant
    // (the start of session 1, since the boundary resolves up).
    const t = scale.invert(600);
    expect(t).toBe(S1);
  });

  it('ticks anchor on the session opens, never inside the collapsed gap', () => {
    // A tight cap → day grain: exactly the left edge (S0) + the collapse point.
    expect(scale.ticks(2)).toEqual([S0, S1]);
    // A roomy cap descends to an hour grain: the opens are still anchors, the
    // extra ticks are clock-aligned instants inside a live session — none in
    // the collapsed gap.
    const dense = scale.ticks(10);
    // S1 (a mid-domain session open) is always an anchor; S0 may be dropped
    // as a cramped lead when the runtime-local clock puts the first aligned
    // instant under half a step away — the first tick still sits in session 0.
    expect(dense).toContain(S1);
    expect(dense[0]!).toBeGreaterThanOrEqual(S0);
    expect(dense[0]!).toBeLessThan(S0 + 6 * H);
    expect(dense.length).toBeGreaterThan(2);
    expect(dense.length).toBeLessThanOrEqual(10);
    for (const t of dense) {
      const inS0 = t >= S0 && t < S0 + 6 * H;
      const inS1 = t >= S1 && t < S1 + 6 * H;
      expect(inS0 || inS1).toBe(true);
    }
  });

  it('coarsens many session opens to a calendar grain (not every-nth)', () => {
    // ~90 consecutive daily sessions (Jan–Mar 2025) → month grain, one tick per
    // month start, not an arbitrary every-nth session.
    const DAY = 24 * H;
    const start = Date.UTC(2025, 0, 1) + 14 * H; // ~09:30 ET, well inside the day
    const daily = segmentProvider(
      Array.from({ length: 90 }, (_, i) => [
        start + i * DAY,
        start + i * DAY + 6 * H,
      ]),
    );
    const s = scaleTradingTime(daily)
      .domain([start, start + 90 * DAY])
      .range([0, 1200]);
    const ticks = s.ticks(6);
    // Three calendar months spanned → about three ticks (never the ~90 sessions).
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    // Each tick is the first session of a distinct local month.
    const months = ticks.map((t) => new Date(t).getMonth());
    expect(new Set(months).size).toBe(months.length);
  });

  it('tickFormat labels ticks at the chosen grain; the boundary row carries the rest', () => {
    // Real session instants so the formats are legible — built in *local*
    // time, since the ladder buckets and labels by the runtime-local calendar
    // (a UTC-built 09:30 would be a different local date west of UTC-9:30).
    const jan = new Date(2026, 0, 5, 9, 30).getTime();
    const feb = new Date(2026, 1, 2, 9, 30).getTime();
    const cal = segmentProvider([
      [jan, jan + 6 * H],
      [feb, feb + 6 * H],
    ]);
    const s = scaleTradingTime(cal)
      .domain([jan, feb + 6 * H])
      .range([0, 1200]);
    // A tight cap → day grain: the anchors read as dates.
    expect(s.tickFormat(2)(new Date(feb))).toMatch(/Feb 02/);
    // A roomy cap → an hour grain: anchors read as clock times, and the date
    // context moves to the boundary (second) row — each session opens a new
    // local day, so both opens carry it; a mid-session tick doesn't.
    const dense = s.ticks(10);
    const fmt = s.tickFormat(10);
    expect(fmt(new Date(jan))).toMatch(/^\d{2}:\d{2}$/);
    const boundary = s.tickBoundaries(10);
    // The first tick is not a crossing — the left-edge context is pinned via
    // boundaryContext (a property of the domain start, not of any tick).
    expect(boundary(jan)).toBeUndefined();
    expect(s.boundaryContext(10)).toMatch(/Jan 05/);
    expect(boundary(feb)).toMatch(/Feb 02/);
    const midSession = dense.find((t) => t !== jan && t < jan + 6 * H)!;
    expect(boundary(midSession)).toBeUndefined();
  });

  it('tickBoundaries puts the year under a month-grain axis, once per year turn', () => {
    // ~8 months of daily opens straddling a year boundary → month grain at a
    // cap of 9. The first tick carries the year, the January tick carries the
    // new year, and no other tick repeats it.
    const DAY = 24 * H;
    const start = new Date(2025, 8, 1, 14).getTime(); // Sep 2025 … Apr 2026 (local)
    const daily = segmentProvider(
      Array.from({ length: 240 }, (_, i) => [
        start + i * DAY,
        start + i * DAY + 6 * H,
      ]),
    );
    const s = scaleTradingTime(daily)
      .domain([start, start + 240 * DAY])
      .range([0, 1200]);
    const ticks = s.ticks(9);
    const boundary = s.tickBoundaries(9);
    expect(s.tickFormat(9)(new Date(ticks[1]!))).toMatch(/^[A-Z][a-z]{2}$/);
    const labels = ticks.map((t) => boundary(t));
    expect(labels[0]).toBeUndefined(); // context is pinned, not on the tick
    expect(s.boundaryContext(9)).toBe('2025'); // the domain start's year
    expect(labels.filter((l) => l === '2026')).toHaveLength(1); // the year turn
    expect(labels.filter((l) => l !== undefined)).toHaveLength(1);
  });

  it('a fractional pan/zoom domain still labels every tick at the grain', () => {
    // Pan/zoom domains come from `scale.invert(pixel)` — fractional ms. A
    // fractional anchor used to miss its own anchor set after the formatter's
    // `new Date(ms)` truncation, so ticks fell through to the d3 multi-scale
    // default and rendered as bare millisecond labels (".259").
    const jan = new Date(2026, 0, 5, 9, 30).getTime();
    const cal = segmentProvider([[jan, jan + 6 * H]]);
    const s = scaleTradingTime(cal)
      .domain([jan + 17 * 60_000 + 0.259, jan + 5 * H + 0.741])
      .range([0, 720]);
    const ticks = s.ticks(10);
    const fmt = s.tickFormat(10);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) {
      expect(Number.isInteger(t)).toBe(true);
      // Every tick is an anchor labelled at the clock grain — never the d3
      // default's millisecond/second fallthrough.
      expect(fmt(new Date(t))).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('domain/range are getter/setters and copy is independent', () => {
    const s = scaleTradingTime(provider);
    expect(s.domain([10, 20])).toBe(s); // setter returns the scale (chainable)
    expect(s.domain()).toEqual([10, 20]); // getter
    s.range([0, 100]);
    const c = s.copy();
    c.domain([30, 40]);
    expect(s.domain()).toEqual([10, 20]); // original unchanged
    expect(c.range()).toEqual([0, 100]); // copied range carried over
  });

  it('is a degenerate no-op on a zero-width domain', () => {
    const s = scaleTradingTime(provider).domain([S0, S0]).range([0, 1200]);
    expect(s(S0)).toBe(0);
  });

  it('extrapolates within the calendar but clamps beyond its extremes', () => {
    // Domain is the second session only; the first session is in-calendar but
    // before the domain → negative pixel (extrapolated, so it gets culled).
    const s = scaleTradingTime(provider)
      .domain([S1, S1 + 6 * H])
      .range([0, 600]);
    expect(s(S1 - 100 * H)).toBeLessThan(0); // a live instant before the domain
    // Beyond the calendar's absolute start there is no trading time → clamps.
    expect(s(S0 - 50 * H)).toBe(s(S0)); // both pin to the same edge pixel
  });

  it('returns a single tick for count < 1', () => {
    const s = scaleTradingTime(provider)
      .domain([S0, S1 + 6 * H])
      .range([0, 1200]);
    expect(s.ticks(0)).toEqual([S0]);
  });

  it('falls back to interior even-spaced ticks with no calendar boundaries', () => {
    // A single-span provider has no session opens → the even-spacing fallback,
    // with endpoints excluded so none sits on the plot edge.
    const s = scaleTradingTime(singleSpanProvider(0, 1000))
      .domain([0, 1000])
      .range([0, 1200]);
    const px = s.ticks(6).map((t) => s(t));
    expect(px.length).toBe(5); // count-1 interior
    expect(Math.min(...px)).toBeGreaterThan(0);
    expect(Math.max(...px)).toBeLessThan(1200);
  });

  it('labels a year-grain axis with the year, a finer axis with the date', () => {
    const DAY = 24 * H;
    // ~3 years of daily opens → year grain → "%Y" labels.
    const start = Date.UTC(2023, 0, 3) + 14 * H;
    const years = segmentProvider(
      Array.from({ length: 3 * 250 }, (_, i) => [
        start + i * DAY,
        start + i * DAY + 6 * H,
      ]),
    );
    const s = scaleTradingTime(years)
      .domain([start, start + 3 * 250 * DAY])
      .range([0, 1200]);
    const fmt = s.tickFormat(6);
    const firstTick = s.ticks(6)[0]!;
    expect(fmt(new Date(firstTick))).toMatch(/^\d{4}$/); // a bare year
  });
});

describe('coarsenCalendar', () => {
  const DAY = 24 * H;
  // 120 consecutive daily opens starting 2025-01-06 (a Monday), mid-morning.
  const start = Date.UTC(2025, 0, 6) + 14 * H;
  const daily = Array.from({ length: 120 }, (_, i) => start + i * DAY);

  it('returns every open (day grain) when they already fit', () => {
    const few = daily.slice(0, 4);
    expect(coarsenCalendar(few, 6)).toEqual({
      ticks: few,
      granularity: 'day',
    });
  });

  it('steps to week grain — one tick per Monday-anchored week', () => {
    // ~4 weeks of opens, count 6 → week grain (session count 28 > 6, weeks ~5).
    const month = daily.slice(0, 28);
    const { ticks, granularity } = coarsenCalendar(month, 6);
    expect(granularity).toBe('week');
    // First tick is the run's start; each subsequent is a new local week.
    expect(ticks[0]).toBe(month[0]);
    const weekOf = (t: number) => {
      const d = new Date(t);
      const dow = (d.getDay() + 6) % 7;
      return new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate() - dow,
      ).getTime();
    };
    expect(new Set(ticks.map(weekOf)).size).toBe(ticks.length);
  });

  it('steps to month grain over a quarter of daily opens', () => {
    const { ticks, granularity } = coarsenCalendar(daily.slice(0, 90), 6);
    expect(granularity).toBe('month');
    const months = ticks.map((t) => new Date(t).getMonth());
    expect(new Set(months).size).toBe(months.length); // distinct months
  });

  it('steps to quarter grain when months still overflow', () => {
    // ~18 months of monthly opens, count 6 → months (18) > 6 → quarters (~6).
    const monthly = Array.from(
      { length: 18 },
      (_, i) => Date.UTC(2024, i, 2) + 14 * H,
    );
    const { ticks, granularity } = coarsenCalendar(monthly, 6);
    expect(granularity).toBe('quarter');
    expect(ticks.length).toBeLessThanOrEqual(6);
    const q = (t: number) => {
      const d = new Date(t);
      return d.getFullYear() * 4 + Math.floor(d.getMonth() / 3);
    };
    expect(new Set(ticks.map(q)).size).toBe(ticks.length); // distinct quarters
  });

  it('never returns more than count — decimates year starts past yearly grain', () => {
    // One open per year for 30 years, count 6 → even yearly (30) overflows, so
    // the fallback decimates the year starts to <= count.
    const yearly = Array.from(
      { length: 30 },
      (_, i) => Date.UTC(2000 + i, 0, 3) + 14 * H,
    );
    const { ticks, granularity } = coarsenCalendar(yearly, 6);
    expect(granularity).toBe('year');
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks.length).toBeGreaterThan(0);
    // Still ascending and a subset of the input.
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(ticks.every((t) => yearly.includes(t))).toBe(true);
  });

  it('the dividers a chart draws (ticks ∩ boundaries) are a coarse subset, aligned with labels', () => {
    // The container draws session dividers at exactly the axis ticks that are
    // collapse boundaries — this pins that they coarsen with the labels rather
    // than marking every session (Layers: xTickVals.filter(t => boundary)).
    const DAYc = 24 * H;
    const start = Date.UTC(2025, 0, 6) + 14 * H;
    const openList = Array.from({ length: 90 }, (_, i) => start + i * DAYc);
    const prov = segmentProvider(
      openList.map((o) => [o, o + 6 * H] as [number, number]),
    );
    const s = scaleTradingTime(prov)
      .domain([openList[0]!, openList[89]! + 6 * H])
      .range([0, 1200]);
    const tickSet = new Set(s.ticks(5));
    const bounds = prov.boundaries!(openList[0]!, openList[89]! + 6 * H);
    const dividers = bounds.filter((b) => tickSet.has(b));
    // Far fewer dividers than the ~89 session boundaries — coarsened to months…
    expect(dividers.length).toBeLessThan(bounds.length / 10);
    expect(dividers.length).toBeGreaterThan(0);
    // …and every divider coincides with a labelled tick (alignment).
    expect(dividers.every((d) => tickSet.has(d))).toBe(true);
  });

  // The Tidal 1-year daily view (charts 0.44 friction report): `count` caps the
  // calendar buckets, and grains jump 4–12× up the ladder, so a small fixed
  // count over-coarsens long daily runs. The container now sizes the cap from
  // plot width instead of passing a constant 5.
  describe('cap semantics on a year of weekday opens (mid-year anchored)', () => {
    /** `n` weekday opens (14:00 UTC) from Mon 2025-06-23 — mid-year anchored,
     *  as a "1Y back from today" trading view is. */
    const openRun = (n: number): number[] => {
      const start = Date.UTC(2025, 5, 23);
      const out: number[] = [];
      for (let d = 0; out.length < n; d++) {
        const day = start + d * DAY;
        const dow = new Date(day).getUTCDay();
        if (dow !== 0 && dow !== 6) out.push(day + 14 * H);
      }
      return out;
    };

    it('a small cap (the old fixed 5) collapses a year-and-change to 2 year-grain ticks', () => {
      // ~13 months — what "1 year back from today" renders as in a real UI:
      // 6 quarter buckets > 5, so a cap of 5 falls through to year grain —
      // the report's 2-tick axis.
      const { ticks, granularity } = coarsenCalendar(openRun(280), 5);
      expect(granularity).toBe('year');
      expect(ticks.length).toBe(2);
    });

    it('a width-sized cap keeps a 1-year daily view at month grain', () => {
      // floor(900px / 65px-per-tick) = 13 — what the container derives for the
      // report's ~900px repro. A 12-month run spans 13 month buckets
      // (Jun'25…Jun'26 inclusive), which fit exactly.
      const { ticks, granularity } = coarsenCalendar(openRun(260), 13);
      expect(granularity).toBe('month');
      expect(ticks.length).toBeGreaterThanOrEqual(12);
      expect(ticks.length).toBeLessThanOrEqual(13);
      // Each tick is the first open of a distinct local month.
      const monthOf = (t: number) => {
        const dd = new Date(t);
        return dd.getFullYear() * 12 + dd.getMonth();
      };
      expect(new Set(ticks.map(monthOf)).size).toBe(ticks.length);
    });
  });
});
