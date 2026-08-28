import { describe, expect, it } from 'vitest';
import { Sequence, TimeRange, TimeSeries } from '../src/index.js';

const DAY = 86_400_000;
const MINUTE = 60_000;

/**
 * Bars every `stepMs` from `startUtc`, each carrying `volume: 1`, so a sum
 * over any grid reads back as "how many input events were accounted for".
 */
const bars = (startUtc: number, n: number, stepMs = DAY) =>
  TimeSeries.fromColumns({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'volume', kind: 'number' },
    ],
    columns: {
      time: Array.from({ length: n }, (_, i) => startUtc + i * stepMs),
      volume: Array.from({ length: n }, () => 1),
    },
  });

const totalOf = (series: TimeSeries<never>) =>
  series.events.reduce(
    (sum, event) => sum + ((event.get('volume') as number) ?? 0),
    0,
  );

describe('aggregate — the bucket containing the first event is emitted', () => {
  // The three shapes measured in
  // docs/notes/tidal-aggregate-leading-bucket-2026-08.md. Each previously
  // dropped every event between the first event and the first grid boundary
  // at or after it — silently, with no error and no undefined.
  it('accounts for every bar rolling 60 daily bars from mid-January to months', () => {
    const series = bars(Date.UTC(2024, 0, 10), 60);
    const rolled = series.aggregate(
      Sequence.calendar('month', { timeZone: 'UTC' }),
      {
        volume: 'sum',
      },
    );

    expect(totalOf(rolled as never)).toBe(60);
    // The leading bucket is January, which starts *before* the first bar.
    expect(rolled.events[0]!.begin()).toBe(Date.UTC(2024, 0, 1));
    expect(rolled.events[0]!.get('volume')).toBe(22);
    expect(rolled.events.length).toBe(3);
  });

  it('accounts for every bar rolling 14 daily bars from a Wednesday to weeks', () => {
    const series = bars(Date.UTC(2024, 0, 3), 14);
    const rolled = series.aggregate(
      Sequence.calendar('week', { timeZone: 'UTC', weekStartsOn: 1 }),
      { volume: 'sum' },
    );

    expect(totalOf(rolled as never)).toBe(14);
    // Monday 1 Jan — the week containing Wednesday 3 Jan.
    expect(rolled.events[0]!.begin()).toBe(Date.UTC(2024, 0, 1));
    expect(rolled.events[0]!.get('volume')).toBe(5);
  });

  it('accounts for every bar rolling intraday minute bars to days', () => {
    // Three sessions of 390 one-minute bars, each opening at 13:30Z — a first
    // event that is never a day boundary.
    const times: number[] = [];
    for (let session = 0; session < 3; session += 1) {
      const open = Date.UTC(2024, 0, 3, 13, 30) + session * DAY;
      for (let bar = 0; bar < 390; bar += 1) {
        times.push(open + bar * MINUTE);
      }
    }
    const series = TimeSeries.fromColumns({
      name: 'x',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'volume', kind: 'number' },
      ],
      columns: { time: times, volume: times.map(() => 1) },
    });

    const rolled = series.aggregate(
      Sequence.calendar('day', { timeZone: 'UTC' }),
      {
        volume: 'sum',
      },
    );

    expect(totalOf(rolled as never)).toBe(1170);
    expect(rolled.events.length).toBe(3);
    expect(rolled.events.every((e) => e.get('volume') === 390)).toBe(true);
  });

  it('accounts for every event on a fixed-step grid too', () => {
    // Hourly grid, first event 20 minutes into the hour.
    const series = bars(Date.UTC(2024, 0, 1, 9, 20), 5, 30 * MINUTE);
    const rolled = series.aggregate(Sequence.every('1h'), { volume: 'sum' });

    expect(totalOf(rolled as never)).toBe(5);
    expect(rolled.events[0]!.begin()).toBe(Date.UTC(2024, 0, 1, 9, 0));
  });

  it('emits no extra leading bucket when the first event is already on a boundary', () => {
    // The case every pre-existing fixture hit, and the reason the drop stayed
    // invisible for four waves: UTC-midnight daily bars anchored on 1 Jan 2024
    // (a Monday that is also a month start) land exactly on the boundary, so
    // flooring is a no-op. This pins that it stays one.
    const series = bars(Date.UTC(2024, 0, 1), 60);
    const rolled = series.aggregate(
      Sequence.calendar('month', { timeZone: 'UTC' }),
      {
        volume: 'sum',
      },
    );

    expect(totalOf(rolled as never)).toBe(60);
    expect(rolled.events[0]!.begin()).toBe(Date.UTC(2024, 0, 1));
    expect(rolled.events[0]!.get('volume')).toBe(31);
    // Jan (31) + Feb (29, 2024 being a leap year) = the 60 bars exactly.
    expect(rolled.events.length).toBe(2);
  });

  it('honours an explicit range verbatim, so a caller-side floor is idempotent', () => {
    // Consumers who worked around the drop by pre-flooring the range keep the
    // exact same result through this change — the floor now just agrees with
    // what the default does.
    const series = bars(Date.UTC(2024, 0, 10), 60);
    const grid = Sequence.calendar('month', { timeZone: 'UTC' });
    const floored = series.aggregate(
      grid,
      { volume: 'sum' },
      {
        range: new TimeRange({
          start: Date.UTC(2024, 0, 1),
          end: Date.UTC(2024, 0, 10) + 59 * DAY,
        }),
      },
    );

    expect(totalOf(floored as never)).toBe(60);
    expect(floored.events[0]!.begin()).toBe(Date.UTC(2024, 0, 1));
  });

  it('an explicit range on a grid boundary excludes what precedes it', () => {
    // NOTE: this case starts on a month boundary, where 'overlap' is a no-op —
    // so it pins the range-clipping behaviour but says nothing about coverage.
    // The off-boundary case below is the one that exercises the fix.
    const series = bars(Date.UTC(2024, 0, 10), 60);
    const clipped = series.aggregate(
      Sequence.calendar('month', { timeZone: 'UTC' }),
      {
        volume: 'sum',
      },
      {
        range: new TimeRange({
          start: Date.UTC(2024, 1, 1),
          end: Date.UTC(2024, 0, 10) + 59 * DAY,
        }),
      },
    );

    expect(clipped.events[0]!.begin()).toBe(Date.UTC(2024, 1, 1));
    expect(totalOf(clipped as never)).toBe(38);
  });
});

describe('what an explicit range bounds — the grid, not the event scan', () => {
  // Found by post-merge adversarial review of #677: the original wording
  // claimed an explicit `range` was "honoured verbatim", and the test meant to
  // pin it started on a month boundary, where 'overlap' does nothing. Both the
  // claim and the test were wrong. These pin what actually happens.
  it('fills a leading bucket from events that precede range.begin()', () => {
    // 60 daily bars from 1 Jan; window opens 10 Jan, mid-bucket. The January
    // bucket is emitted complete (31) — including the nine bars from 1–9 Jan
    // that sit *outside* the requested window.
    const series = bars(Date.UTC(2024, 0, 1), 60);
    const windowed = series.aggregate(
      Sequence.calendar('month', { timeZone: 'UTC' }),
      { volume: 'sum' },
      {
        range: new TimeRange({
          start: Date.UTC(2024, 0, 10),
          end: Date.UTC(2024, 1, 20),
        }),
      },
    );

    expect(windowed.events[0]!.begin()).toBe(Date.UTC(2024, 0, 1));
    expect(windowed.events[0]!.get('volume')).toBe(31);
    // The consequence worth stating: the window's own span is 41 days, but the
    // result accounts for more than that, because a bucket is a property of
    // the data and the grid rather than of the window it is viewed through.
    expect(totalOf(windowed as never)).toBe(60);
  });

  it('reads a bucket the same under any range containing it', () => {
    // The property the above buys, and the reason it is not a bug: an edge
    // bucket does not change value as a viewport slides across it.
    const series = bars(Date.UTC(2024, 0, 1), 60);
    const grid = Sequence.calendar('month', { timeZone: 'UTC' });
    const januaryUnder = (startDay: number) =>
      series
        .aggregate(
          grid,
          { volume: 'sum' },
          {
            range: new TimeRange({
              start: Date.UTC(2024, 0, startDay),
              end: Date.UTC(2024, 1, 20),
            }),
          },
        )
        .events[0]!.get('volume');

    expect(januaryUnder(3)).toBe(31);
    expect(januaryUnder(10)).toBe(31);
    expect(januaryUnder(25)).toBe(31);
  });

  it('uses a pre-realized BoundedSequence exactly as given', () => {
    // A BoundedSequence is an explicit bucket list, so coverage does not apply
    // — pond will not extend it with a bucket the caller did not ask for. This
    // is the documented escape hatch for anyone who wants the old edge.
    const series = bars(Date.UTC(2024, 0, 1), 60);
    const grid = Sequence.calendar('month', { timeZone: 'UTC' });
    const range = new TimeRange({
      start: Date.UTC(2024, 0, 10),
      end: Date.UTC(2024, 1, 20),
    });

    const asGiven = series.aggregate(grid.bounded(range), { volume: 'sum' });
    expect(asGiven.events[0]!.begin()).toBe(Date.UTC(2024, 1, 1));

    // The same window through the Sequence + range path does cover.
    const covering = series.aggregate(grid, { volume: 'sum' }, { range });
    expect(covering.events[0]!.begin()).toBe(Date.UTC(2024, 0, 1));
  });
});

describe('align / materialize keep sample-point selection', () => {
  // The distinction the fix turns on: alignment's sample point *becomes the
  // output key*, so a bucket starting before the range would key a point
  // outside the range the caller asked for. Only aggregate treats buckets as
  // containers that must account for every instant.
  it('align emits no grid point before the range', () => {
    const series = bars(Date.UTC(2024, 0, 10), 60);
    const aligned = series.align(
      Sequence.calendar('month', { timeZone: 'UTC' }),
    );

    expect(aligned.events[0]!.begin()).toBe(Date.UTC(2024, 1, 1));
  });

  it('materialize emits no grid point before the range', () => {
    const series = bars(Date.UTC(2024, 0, 10), 60);
    const materialized = series.materialize(
      Sequence.calendar('month', { timeZone: 'UTC' }),
    );

    expect(materialized.events[0]!.begin()).toBe(Date.UTC(2024, 1, 1));
  });
});

describe('Sequence.bounded coverage', () => {
  it("'sample' is the default and drops the bucket containing range.begin()", () => {
    const grid = Sequence.calendar('month', { timeZone: 'UTC' });
    const range = new TimeRange({
      start: Date.UTC(2024, 0, 10),
      end: Date.UTC(2024, 2, 10),
    });

    expect(grid.bounded(range).first()!.begin()).toBe(Date.UTC(2024, 1, 1));
    expect(grid.bounded(range, { coverage: 'sample' }).first()!.begin()).toBe(
      Date.UTC(2024, 1, 1),
    );
  });

  it("'overlap' includes it, and changes only the leading edge", () => {
    const grid = Sequence.calendar('month', { timeZone: 'UTC' });
    const range = new TimeRange({
      start: Date.UTC(2024, 0, 10),
      end: Date.UTC(2024, 2, 10),
    });

    const sampled = grid.bounded(range);
    const overlapped = grid.bounded(range, { coverage: 'overlap' });

    expect(overlapped.first()!.begin()).toBe(Date.UTC(2024, 0, 1));
    expect(overlapped.length).toBe(sampled.length + 1);
    // The trailing edge is untouched: both keep the bucket that starts inside
    // the range and runs past its end.
    expect(overlapped.last()!.begin()).toBe(sampled.last()!.begin());
  });

  it("'overlap' on a fixed grid picks the bucket containing range.begin()", () => {
    const grid = Sequence.every('1h');
    const range = new TimeRange({
      start: Date.UTC(2024, 0, 1, 9, 20),
      end: Date.UTC(2024, 0, 1, 11, 20),
    });

    expect(grid.bounded(range, { coverage: 'overlap' }).first()!.begin()).toBe(
      Date.UTC(2024, 0, 1, 9, 0),
    );
    expect(grid.bounded(range).first()!.begin()).toBe(
      Date.UTC(2024, 0, 1, 10, 0),
    );
  });

  it("'overlap' is a no-op when range.begin() sits on a boundary", () => {
    const grid = Sequence.every('1h');
    const range = new TimeRange({
      start: Date.UTC(2024, 0, 1, 9, 0),
      end: Date.UTC(2024, 0, 1, 11, 0),
    });

    expect(grid.bounded(range, { coverage: 'overlap' }).intervals()).toEqual(
      grid.bounded(range).intervals(),
    );
  });

  it("'overlap' moves the trailing edge too against a non-default sample", () => {
    // 'overlap' drops the sample offset that 'sample' shifts *both* edges by,
    // so "only the leading edge differs" holds at the default 'begin' only.
    // `aggregate` hardcodes 'begin', so this is a `bounded` contract detail —
    // pinned because the docstring now claims exactly this.
    const grid = Sequence.calendar('month', { timeZone: 'UTC' });
    const range = new TimeRange({
      start: Date.UTC(2024, 0, 10),
      end: Date.UTC(2024, 1, 20),
    });

    expect(grid.bounded(range, { sample: 'end' }).last()!.begin()).toBe(
      Date.UTC(2024, 0, 1),
    );
    expect(
      grid
        .bounded(range, { sample: 'end', coverage: 'overlap' })
        .last()!
        .begin(),
    ).toBe(Date.UTC(2024, 1, 1));
  });

  it("'overlap' floors correctly on the negative side of the anchor", () => {
    // The fix swaps `ceil` for `floor` on the first index, and the two differ
    // in *sign behaviour*, not just by one: for a pre-epoch instant the
    // quotient is negative, where `ceil` rounds toward the epoch and `floor`
    // away from it. Only `floor` names the containing bucket on both sides.
    const grid = Sequence.every('1h');
    const range = new TimeRange({
      start: Date.UTC(1969, 11, 31, 22, 20),
      end: Date.UTC(1970, 0, 1, 1, 0),
    });

    expect(grid.bounded(range, { coverage: 'overlap' }).first()!.begin()).toBe(
      Date.UTC(1969, 11, 31, 22, 0),
    );
  });

  it("'overlap' over a single instant is the flooring primitive", () => {
    // What the report asked for as ask #3: consumers compensating for the drop
    // had to re-derive pond's own calendar anchoring by hand.
    const t = Date.UTC(2024, 0, 10, 13, 30);
    const month = Sequence.calendar('month', { timeZone: 'UTC' });
    const week = Sequence.calendar('week', {
      timeZone: 'UTC',
      weekStartsOn: 1,
    });

    const floorWith = (grid: Sequence) =>
      grid.bounded({ start: t, end: t }, { coverage: 'overlap' });

    expect(floorWith(month).length).toBe(1);
    expect(floorWith(month).first()!.begin()).toBe(Date.UTC(2024, 0, 1));
    expect(floorWith(week).first()!.begin()).toBe(Date.UTC(2024, 0, 8));
  });
});
