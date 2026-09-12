import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Sequence, TimeRange, TimeSeries, TimeZone } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BarChart } from '../src/BarChart.js';
import { XAxis } from '../src/XAxis.js';
import { identityProvider, scaleTradingTime } from '../src/tradingTimeScale.js';
import {
  bandNext,
  bandShaded,
  bandStartOf,
  bucketKey,
  localTickCalendar,
  zonedTickCalendar,
} from '../src/tickLadder.js';

afterEach(cleanup);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Every expectation here is **derived** through the same `TimeZone` the axis
 * renders with, or through core's `Sequence.calendar` — never a hardcoded
 * label literal. The one place a literal appears is where the point is the
 * literal itself (`%Z` → `EDT`).
 */

describe('zonedTickCalendar — agrees with Sequence.calendar', () => {
  it('day boundaries the identity provider enumerates are the calendar-day bucket starts', () => {
    // The plan's cross-package contract, pinned executable: the day ticks a
    // zoned axis places over a DST month are the bucket starts
    // `Sequence.calendar('day', { timeZone })` cuts for the same range.
    for (const timeZone of [
      'America/New_York',
      'Australia/Sydney',
      'Asia/Kolkata',
    ]) {
      const from = Date.UTC(2025, 2, 1, 12);
      const to = Date.UTC(2025, 3, 15, 12);
      const boundaries = identityProvider({ timeZone }).boundaries!(from, to);
      const buckets = Sequence.calendar('day', { timeZone }).bounded(
        new TimeRange({ start: from, end: to }),
      );
      const starts: number[] = [];
      for (let i = 0; i < buckets.length; i += 1)
        starts.push(buckets.at(i)!.begin());
      // `bounded` (sample: 'begin') keeps starts in [from, to]; boundaries are
      // strictly inside (from, to). Same set once the closed edges are dropped.
      expect(boundaries).toEqual(starts.filter((t) => t > from && t < to));
      expect(boundaries.length).toBeGreaterThan(40);
    }
  });

  it('the local calendar is bit-for-bit the runtime-local Date arithmetic', () => {
    // The default path must not move: the zoned calendar for the runtime's
    // own zone gives the same answers as the Date-based local one.
    const runtime = zonedTickCalendar(TimeZone.local());
    for (
      let t = Date.UTC(2025, 0, 1);
      t < Date.UTC(2026, 0, 1);
      t += 37 * HOUR + 1
    ) {
      expect(runtime.startOfDay(t)).toBe(localTickCalendar.startOfDay(t));
      expect(runtime.nextDay(t)).toBe(localTickCalendar.nextDay(t));
      expect(runtime.startOfWeek(t)).toBe(localTickCalendar.startOfWeek(t));
      expect(runtime.parts(t)).toEqual(localTickCalendar.parts(t));
    }
    for (let m = 1; m <= 12; m += 1) {
      expect(runtime.monthStart(2025, m)).toBe(
        localTickCalendar.monthStart(2025, m),
      );
      expect(runtime.daysInMonth(2025, m)).toBe(
        localTickCalendar.daysInMonth(2025, m),
      );
    }
    // Month overflow / underflow normalise the same way.
    expect(runtime.monthStart(2025, 13)).toBe(
      localTickCalendar.monthStart(2025, 13),
    );
    expect(runtime.monthStart(2025, 0)).toBe(
      localTickCalendar.monthStart(2025, 0),
    );
  });

  it('bucketKey / bandStartOf / bandNext / bandShaded take the zone', () => {
    const syd = TimeZone.of('Australia/Sydney');
    const cal = zonedTickCalendar(syd);
    // 2025-01-31T14:00Z is already 1 Feb 01:00 in Sydney (AEDT, +11).
    const t = Date.UTC(2025, 0, 31, 14);
    expect(bucketKey(t, 'month', cal)).toBe(2025 * 12 + 1);
    expect(bucketKey(t, 'day', cal)).toBe(syd.startOf('day', t));
    expect(bandStartOf(t, 'month', cal)).toBe(syd.startOf('month', t));
    expect(bandNext(t, 'month', cal)).toBe(syd.next('month', t));
    expect(bandStartOf(t, 'year', cal)).toBe(syd.startOf('year', t));
    expect(bandNext(t, 'day', cal)).toBe(syd.next('day', t));
    // Zebra parity keys on the zone's own day ordinal, so consecutive Sydney
    // days alternate even when they straddle a UTC day.
    expect(bandShaded(t, 'day', cal)).not.toBe(
      bandShaded(syd.next('day', t), 'day', cal),
    );
  });
});

describe('scaleTradingTime({ timeZone }) — ticks, labels, readouts in the zone', () => {
  const ny = TimeZone.of('America/New_York');

  it('day ticks land on the zone midnights across the spring-forward, labels read the zone date', () => {
    const start = Date.UTC(2025, 2, 6, 5); // Mar 6 00:00 EST
    const end = Date.UTC(2025, 2, 13, 4); // Mar 13 00:00 EDT
    const s = scaleTradingTime(identityProvider({ timeZone: ny.id }), {
      timeZone: ny.id,
    })
      .domain([start, end])
      .range([0, 700]);
    const ticks = s.ticks(8);
    expect(s.grain(8)).toBe('day');
    for (const t of ticks) {
      expect(t).toBe(ny.startOf('day', t));
    }
    // The spring-forward day is 23 h long — the tick after it comes an hour earlier in UTC.
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]!);
    expect(gaps).toContain(23 * HOUR);
    const flat = s.flatFormat(8);
    for (const t of ticks) {
      expect(flat(t)).toBe(String(ny.parts(t).day));
    }
    // The readout at day grain is a date in the zone.
    const readout = s.readoutFormat(8);
    const p = ny.parts(ticks[0]!);
    expect(readout(ticks[0]!)).toBe(
      `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.month - 1]} ${p.day}, ${p.year}`,
    );
  });

  it("a daily bar at a foreign midnight reads its own date, not the viewer's", () => {
    // The F-charts-7 shape: a Sydney daily bar keyed at Sydney midnight is
    // the previous calendar day in UTC and in most viewer zones. In the
    // Sydney axis it reads the Sydney date, whatever the runner's zone.
    const syd = TimeZone.of('Australia/Sydney');
    const dayStart = syd.instant({ year: 2025, month: 2, day: 1 }); // 2025-01-31T13:00Z
    const s = scaleTradingTime(identityProvider({ timeZone: syd.id }), {
      timeZone: syd.id,
    })
      .domain([dayStart - 10 * DAY, dayStart + 10 * DAY])
      .range([0, 600]);
    expect(s.readoutFormat(6)(dayStart)).toBe('Feb 1, 2025');
    expect(s.tickFormat(6, '%Y-%m-%d %H:%M')(new Date(dayStart))).toBe(
      '2025-02-01 00:00',
    );
  });

  it('sub-day anchors re-anchor at each zone midnight, so 6 h ticks read 00/06/12/18 across DST', () => {
    const start = ny.instant({ year: 2025, month: 3, day: 8 });
    const end = ny.instant({ year: 2025, month: 3, day: 11 });
    const s = scaleTradingTime(identityProvider({ timeZone: ny.id }), {
      timeZone: ny.id,
    })
      .domain([start, end])
      .range([0, 1200]);
    const ticks = s.ticks(14);
    expect(s.grain(14)).toBe('hour');
    const hours = new Set(ticks.map((t) => ny.parts(t).hour));
    // Every anchor sits on a wall-clock multiple of the step in the zone, on
    // the DST day too — the anchors after 02:00 → 03:00 land on 06/12/18 EDT
    // rather than drifting to 07/13/19.
    for (const h of hours) expect(h % 6).toBe(0);
    expect(hours.has(0)).toBe(true);
    expect(hours.has(12)).toBe(true);
  });

  it('%Z and %z read the zone, not the shifted UTC', () => {
    const summer = Date.UTC(2025, 6, 4, 16);
    const winter = Date.UTC(2025, 0, 4, 16);
    const s = scaleTradingTime(identityProvider({ timeZone: ny.id }), {
      timeZone: ny.id,
    })
      .domain([winter, summer])
      .range([0, 600]);
    const f = s.tickFormat(6, '%H:%M %Z (%z)');
    expect(f(new Date(summer))).toBe(
      `12:00 ${ny.abbreviation(summer)} (-0400)`,
    );
    expect(f(new Date(winter))).toBe(
      `11:00 ${ny.abbreviation(winter)} (-0500)`,
    );
    // A literal percent survives the substitution, and an escaped `%%Z` is
    // the two characters `%Z`, not the zone name.
    expect(s.tickFormat(6, '%H%% %Z')(new Date(summer))).toBe(
      `12% ${ny.abbreviation(summer)}`,
    );
    expect(s.tickFormat(6, '%H %%Z %%z')(new Date(summer))).toBe('12 %Z %z');
    expect(s.tickFormat(6, '%%%Z')(new Date(summer))).toBe(
      `%${ny.abbreviation(summer)}`,
    );
  });

  it('a half-hour zone puts day ticks at 18:30Z and month bands at the zone month start', () => {
    const kol = TimeZone.of('Asia/Kolkata');
    const start = kol.instant({ year: 2025, month: 5, day: 20 });
    const end = kol.instant({ year: 2025, month: 6, day: 12 });
    const s = scaleTradingTime(identityProvider({ timeZone: kol.id }), {
      timeZone: kol.id,
    })
      .domain([start, end])
      .range([0, 900]);
    for (const t of s.ticks(12)) {
      expect(t % DAY).toBe((18 * HOUR + 30 * 60_000) % DAY);
    }
    const bands = s.bands(12);
    const june = bands.find((b) => b.label === 'June');
    expect(june?.start).toBe(kol.instant({ year: 2025, month: 6, day: 1 }));
  });

  it('the multi-scale default and boundaryContext also read in the zone', () => {
    // A domain opening at a New York midnight: the boundary-row context under
    // hour ticks is that date in New York, and the default (non-anchor)
    // formatter picks its unit from the zone's clock.
    const start = ny.instant({ year: 2025, month: 7, day: 4 });
    const s = scaleTradingTime(identityProvider({ timeZone: ny.id }), {
      timeZone: ny.id,
    })
      .domain([start, start + 12 * HOUR])
      .range([0, 800]);
    expect(s.grain(10)).toBe('hour');
    expect(s.boundaryContext(10)).toBe('Jul 04');
    // 15:00 New York, not the same instant in the runner's zone.
    const off = start + 15 * HOUR + 30 * 60_000;
    expect(s.tickFormat(10)(new Date(off))).toBe('03:30');
  });

  it('copy() carries the zone', () => {
    const s = scaleTradingTime(identityProvider({ timeZone: 'Asia/Tokyo' }), {
      timeZone: 'Asia/Tokyo',
    }).domain([Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 8)]);
    const c = s.copy();
    expect(c.ticks(7)).toEqual(s.ticks(7));
    expect(c.tickFormat(7, '%H')(new Date(Date.UTC(2025, 0, 2)))).toBe('09');
  });

  it('rejects an unknown zone', () => {
    expect(() =>
      scaleTradingTime(identityProvider(), { timeZone: 'Nowhere/City' }),
    ).toThrow(RangeError);
  });
});

describe('the local default path is the pre-seam code', () => {
  it('sub-day anchors of a session spanning a local DST midnight step fixed ms, as before', () => {
    // Review finding on #732: `stepAnchors` must keep `t + step` stepping for
    // the local calendar, so a futures-style session that crosses a DST
    // midnight ticks exactly as it did before the seam. Reference: the
    // pre-seam loop, reimplemented here with local Date arithmetic — fixed
    // ms from the session open's own local midnight, `t += step`. Runs on
    // whatever zone the runner is in; on a DST zone the session below
    // straddles a transition, on UTC it is a plain equivalence check.
    const localMidnight = (t: number) => {
      const d = new Date(t);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    const oldAnchors = (open: number, end: number, step: number) => {
      const out = [open];
      const m = localMidnight(open + 1);
      for (
        let t = m + Math.ceil((open + 1 - m) / step) * step;
        t < end;
        t += step
      ) {
        out.push(t);
      }
      return out;
    };
    // Sessions opening 18:00 local and running 47 h, one per week across
    // the year: every DST transition of the runner's zone is crossed by one.
    for (let week = 0; week < 52; week += 1) {
      const d = new Date(2025, 0, 4 + week * 7, 18); // local 18:00
      const open = d.getTime();
      const end = open + 47 * HOUR;
      const provider = {
        clampUp: (t: number) => t,
        clampDown: (t: number) => t,
        distance: (a: number, b: number) => b - a,
        offset: (v: number, amt: number) => v + amt,
        copy() {
          return this;
        },
        boundaries: () => [] as number[],
      };
      // The ladder picks the finest clock rung with `1 + floor(47h / step)`
      // anchors under the cap: 17 → 3 h (16 fit; 1 h would need 48), 9 → 6 h,
      // 5 → 12 h.
      for (const [cap, step] of [
        [17, 3 * HOUR],
        [9, 6 * HOUR],
        [5, 12 * HOUR],
      ] as const) {
        const s = scaleTradingTime(provider)
          .domain([open, end])
          .range([0, 4000]);
        const ticks = s.ticks(cap);
        expect(s.grain(cap)).toBe('hour');
        // The ladder may drop the window-edge open and a cramped lead; compare
        // the interior anchors, which must be exactly the old sequence.
        const expected = oldAnchors(open, end, step).filter(
          (t) => t > open + step / 2,
        );
        const got = ticks.filter((t) => t > open + step / 2);
        expect(got, `week ${week} step ${step / HOUR}h`).toEqual(expected);
      }
    }
  });
});

describe('scale.withTimeZone — one mapping, another calendar', () => {
  it('keeps the pixel mapping and re-derives ticks and labels in the new zone', () => {
    const start = Date.UTC(2025, 5, 2);
    const utc = scaleTradingTime(identityProvider({ timeZone: 'UTC' }), {
      timeZone: 'UTC',
    })
      .domain([start, start + 3 * DAY])
      .range([0, 900]);
    const tokyo = utc.withTimeZone('Asia/Tokyo');
    expect(tokyo.timeZone()).toBe('Asia/Tokyo');
    expect(utc.timeZone()).toBe('UTC');
    for (const t of [start, start + 5 * HOUR, start + 2.5 * DAY]) {
      expect(tokyo(t)).toBe(utc(t));
      expect(tokyo.invert(utc(t))).toBe(t);
    }
    const jst = TimeZone.of('Asia/Tokyo');
    const utcTicks = utc.ticks(6);
    const tokyoTicks = tokyo.ticks(6);
    expect(tokyoTicks).not.toEqual(utcTicks);
    for (const t of tokyoTicks) expect(t).toBe(jst.startOf('day', t));
    for (const t of utcTicks) expect(t % DAY).toBe(0);
    expect(tokyo.tickFormat(6, '%H:%M')(new Date(start))).toBe('09:00');
    // `undefined` goes back to the runtime-local calendar.
    expect(tokyo.withTimeZone(undefined).timeZone()).toBeUndefined();
  });
});

describe('<ChartContainer timeZone> — the prop and the calendar default', () => {
  const series = (start: number, hours: number) =>
    new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: Array.from({ length: hours }, (_, i) => [start + i * HOUR, i % 7]),
    });

  it('labels the axis in the given zone', () => {
    const kol = TimeZone.of('Asia/Kolkata');
    const start = kol.instant({ year: 2025, month: 3, day: 3 });
    const { getAllByText } = render(
      <ChartContainer
        range={[start, start + 6 * DAY]}
        width={900}
        showAxis={false}
        timeZone="Asia/Kolkata"
      >
        <ChartRow height={120}>
          <Layers>
            <LineChart series={series(start, 6 * 24)} column="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    // Day grain: flat labels are bare day-of-month in Kolkata. Derive them.
    for (let d = 1; d <= 5; d += 1) {
      const t = start + d * DAY;
      expect(getAllByText(String(kol.parts(t).day)).length).toBeGreaterThan(0);
    }
  });

  it("inherits the calendar's zone when no prop is given, and the prop wins", () => {
    const tokyo = TimeZone.of('Asia/Tokyo');
    const start = tokyo.instant({ year: 2025, month: 3, day: 3 });
    const calendar = {
      timeZone: 'Asia/Tokyo',
      discontinuities: () => identityProvider({ timeZone: 'Asia/Tokyo' }),
    };
    const renderWith = (timeZone?: string) =>
      render(
        <ChartContainer
          range={[start + 4 * HOUR, start + 20 * HOUR]}
          width={800}
          showAxis={false}
          calendar={calendar}
          {...(timeZone === undefined ? {} : { timeZone })}
        >
          <ChartRow height={120}>
            <Layers>
              <LineChart series={series(start, 24)} column="v" />
            </Layers>
          </ChartRow>
          <XAxis />
        </ChartContainer>,
      );
    // Tokyo: an hour grain reads Tokyo clock times.
    const inherited = renderWith();
    expect(inherited.getAllByText('12:00').length).toBeGreaterThan(0);
    cleanup();
    // The explicit prop overrides the calendar: 12:00 Tokyo is 03:00 UTC.
    const overridden = renderWith('UTC');
    expect(overridden.getAllByText('03:00').length).toBeGreaterThan(0);
  });

  it('two strips, two zones: <XAxis timeZone> renders its own zone over the shared mapping', () => {
    const start = Date.UTC(2025, 5, 2);
    const { getAllByText } = render(
      <ChartContainer
        range={[start + 2 * HOUR, start + 18 * HOUR]}
        width={800}
        showAxis={false}
        timeZone="UTC"
      >
        <XAxis side="top" timeZone="Asia/Tokyo" label="Tokyo" />
        <ChartRow height={120}>
          <Layers>
            <LineChart series={series(start, 24)} column="v" />
          </Layers>
        </ChartRow>
        <XAxis label="UTC" />
      </ChartContainer>,
    );
    // The same instant, 03:00Z, reads 12:00 on the Tokyo strip and 03:00 on
    // the UTC one; both strips are present at once.
    expect(getAllByText('12:00').length).toBeGreaterThan(0);
    expect(getAllByText('03:00').length).toBeGreaterThan(0);
    expect(getAllByText('Tokyo').length).toBe(1);
    expect(getAllByText('UTC').length).toBe(1);
  });

  it('a zone change on rerender relabels the axis', () => {
    const start = Date.UTC(2025, 5, 2);
    const chart = (timeZone: string) => (
      <ChartContainer
        range={[start + 2 * HOUR, start + 18 * HOUR]}
        width={800}
        showAxis={false}
        timeZone={timeZone}
      >
        <ChartRow height={120}>
          <Layers>
            <LineChart series={series(start, 24)} column="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>
    );
    // The rendered tick labels as a set; each zone's set must differ from
    // the last, carry a label that is only right in that zone (03:00Z reads
    // `03:00` in UTC; 15:30Z reads `21:00` in Kolkata; Tokyo's midnight at
    // 15:00Z is the day turn `Jun 3`), and switching back restores the
    // original set exactly.
    const labels = (c: HTMLElement) =>
      new Set(
        Array.from(c.querySelectorAll('*'))
          .filter((el) => el.children.length === 0)
          .map((t) => t.textContent ?? '')
          .filter((t) => /^\d{2}:\d{2}$|^[A-Z][a-z]{2} \d{1,2}$/.test(t)),
      );
    const { rerender, container } = render(chart('UTC'));
    const utc = labels(container);
    expect(utc.has('03:00')).toBe(true);
    rerender(chart('Asia/Kolkata'));
    const kolkata = labels(container);
    expect(kolkata.has('21:00')).toBe(true);
    expect(kolkata).not.toEqual(utc);
    rerender(chart('Asia/Tokyo'));
    const tokyo = labels(container);
    expect(tokyo.has('Jun 3')).toBe(true);
    expect(tokyo).not.toEqual(kolkata);
    rerender(chart('UTC'));
    expect(labels(container)).toEqual(utc);
  });

  it("daily buckets cut in a zone sit exactly between that zone's day ticks", () => {
    // Hourly data across the New York spring-forward, aggregated to calendar
    // days in New York and drawn as bars in a New York axis: every bucket
    // edge is a day tick, including the 23 h day.
    const ny = TimeZone.of('America/New_York');
    const start = ny.instant({ year: 2025, month: 3, day: 6 });
    const hourly = series(start, 8 * 24);
    const daily = hourly.aggregate(
      Sequence.calendar('day', { timeZone: 'America/New_York' }),
      { v: 'sum' },
    );
    // 192 hourly points from Mar 6 00:00: the 23 h spring-forward day means
    // they reach 01:00 on Mar 14 — a ninth (partial) New York day.
    expect(daily.length).toBe(9);
    const edges = new Set<number>();
    for (const e of daily.events) {
      const k = e.key() as { begin(): number; end(): number };
      edges.add(k.begin());
      edges.add(k.end());
      expect(k.begin()).toBe(ny.startOf('day', k.begin()));
    }
    const s = scaleTradingTime(identityProvider({ timeZone: ny.id }), {
      timeZone: ny.id,
    })
      .domain([start, start + 8 * DAY])
      .range([0, 900]);
    for (const t of s.ticks(9)) expect(edges.has(t)).toBe(true);
    // The 23 h bucket is there, and it is Mar 9.
    const short = daily.events.find((e) => {
      const k = e.key() as { begin(): number; end(): number };
      return k.end() - k.begin() === 23 * HOUR;
    });
    expect(short).toBeDefined();
    expect(ny.parts((short!.key() as { begin(): number }).begin()).day).toBe(9);
    // And the chart renders the bars in that zone without complaint.
    const { getAllByText } = render(
      <ChartContainer
        range={[start, start + 8 * DAY - HOUR]}
        width={900}
        showAxis={false}
        timeZone="America/New_York"
      >
        <ChartRow height={120}>
          <Layers>
            <BarChart series={daily} column="v" gap={2} />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    expect(getAllByText('9').length).toBeGreaterThan(0); // Mar 9, the 23 h day
  });

  it('throws a RangeError naming an unknown zone', () => {
    const start = Date.UTC(2025, 0, 1);
    const orig = console.error;
    console.error = () => {};
    try {
      expect(() =>
        render(
          <ChartContainer
            range={[start, start + DAY]}
            width={400}
            timeZone="Mars/Olympus"
          >
            <ChartRow height={80}>
              <Layers>
                <LineChart series={series(start, 24)} column="v" />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        ),
      ).toThrow(/unknown time zone "Mars\/Olympus"/);
    } finally {
      console.error = orig;
    }
  });
});
