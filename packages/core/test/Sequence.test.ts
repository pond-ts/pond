import { describe, expect, it } from 'vitest';
import {
  BoundedSequence,
  Interval,
  Sequence,
  TimeRange,
} from '../src/index.js';

describe('Sequence', () => {
  it('uses bounded sequences for explicit interval lists', () => {
    const sequence = new BoundedSequence([
      new Interval({ value: 'a', start: 0, end: 10 }),
      new Interval({ value: 'b', start: 10, end: 20 }),
    ]);

    expect(sequence.length).toBe(2);
    expect(sequence.first()).toEqual(
      new Interval({ value: 'a', start: 0, end: 10 }),
    );
    expect(sequence.last()).toEqual(
      new Interval({ value: 'b', start: 10, end: 20 }),
    );
    expect(sequence.timeRange()).toEqual(new TimeRange({ start: 0, end: 20 }));
  });

  it('allows gaps in explicit bounded sequences', () => {
    const sequence = new BoundedSequence([
      new Interval({ value: 'a', start: 0, end: 10 }),
      new Interval({ value: 'b', start: 20, end: 30 }),
    ]);

    expect(sequence.length).toBe(2);
    expect(sequence.first()).toEqual(
      new Interval({ value: 'a', start: 0, end: 10 }),
    );
    expect(sequence.last()).toEqual(
      new Interval({ value: 'b', start: 20, end: 30 }),
    );
    expect(sequence.timeRange()).toEqual(new TimeRange({ start: 0, end: 30 }));
  });

  it('rejects unsorted explicit intervals', () => {
    expect(
      () =>
        new BoundedSequence([
          new Interval({ value: 'b', start: 10, end: 20 }),
          new Interval({ value: 'a', start: 0, end: 10 }),
        ]),
    ).toThrowError('sorted by start time');
  });

  it('rejects overlapping explicit intervals', () => {
    expect(
      () =>
        new BoundedSequence([
          new Interval({ value: 'a', start: 0, end: 10 }),
          new Interval({ value: 'b', start: 5, end: 15 }),
        ]),
    ).toThrowError('must not overlap');
  });

  it('rejects zero-duration explicit intervals', () => {
    expect(
      () =>
        new BoundedSequence([new Interval({ value: 'a', start: 0, end: 0 })]),
    ).toThrowError('positive duration');
  });

  it('bounds fixed-step sequences using begin and center sampling', () => {
    const sequence = Sequence.every(10, { anchor: 0 });

    const begin = sequence.bounded(new TimeRange({ start: 10, end: 30 }));
    const center = sequence.bounded(new TimeRange({ start: 10, end: 30 }), {
      sample: 'center',
    });

    expect(begin.length).toBe(3);
    expect(begin.at(0)).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(begin.at(2)).toEqual(
      new Interval({ value: 30, start: 30, end: 40 }),
    );
    expect(center.length).toBe(2);
    expect(center.at(0)).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(center.at(1)).toEqual(
      new Interval({ value: 20, start: 20, end: 30 }),
    );
  });

  it('bounds fixed-step sequences using end sampling', () => {
    // sample: 'end' uses left-exclusive inclusion (sample > range.begin)
    // so the [0,10) interval whose end-sample is exactly 10 is dropped,
    // even though begin sampling on the same range includes [10,20).
    const sequence = Sequence.every(10, { anchor: 0 });
    const end = sequence.bounded(new TimeRange({ start: 10, end: 30 }), {
      sample: 'end',
    });

    expect(end.length).toBe(2);
    expect(end.at(0)).toEqual(new Interval({ value: 10, start: 10, end: 20 }));
    expect(end.at(1)).toEqual(new Interval({ value: 20, start: 20, end: 30 }));
  });

  it('bounds end-sampled sequences with a non-zero anchor', () => {
    // anchor 5 shifts the grid; intervals start at ...,-5,5,15,25,35,...
    // end samples are 5, 15, 25, 35. Range (10, 30] includes 15 and 25.
    const sequence = Sequence.every(10, { anchor: 5 });
    const end = sequence.bounded(new TimeRange({ start: 10, end: 30 }), {
      sample: 'end',
    });

    expect(end.length).toBe(2);
    expect(end.at(0)).toEqual(new Interval({ value: 5, start: 5, end: 15 }));
    expect(end.at(1)).toEqual(new Interval({ value: 15, start: 15, end: 25 }));
  });

  it('returns no intervals for end sampling on a zero-length range', () => {
    const sequence = Sequence.every(10, { anchor: 0 });
    const end = sequence.bounded(new TimeRange({ start: 10, end: 10 }), {
      sample: 'end',
    });
    expect(end.length).toBe(0);
  });

  it('end sampling works on calendar sequences', () => {
    // Daily UTC sequence; range covers two day-ends in 2025-03.
    const sequence = Sequence.calendar('day', { timeZone: 'UTC' });
    const end = sequence.bounded(
      new TimeRange({
        start: Date.parse('2025-03-09T00:00:00Z'),
        end: Date.parse('2025-03-11T00:00:00Z'),
      }),
      { sample: 'end' },
    );
    // Day-end samples land at 03-10T00 and 03-11T00 (both in range).
    // The 03-09T00 day-end sample equals range.begin() and is excluded
    // by the left-exclusive 'end' rule.
    expect(end.length).toBe(2);
    expect(end.at(0)?.begin()).toBe(Date.parse('2025-03-09T00:00:00Z'));
    expect(end.at(1)?.begin()).toBe(Date.parse('2025-03-10T00:00:00Z'));
  });

  it('exposes anchor and step metadata for procedural sequences', () => {
    const sequence = Sequence.hourly({ anchor: 1_000 });

    expect(sequence.anchor()).toBe(1_000);
    expect(sequence.stepMs()).toBe(3_600_000);
  });

  it('builds timezone-aware daily calendar buckets across DST changes', () => {
    const sequence = Sequence.calendar('day', { timeZone: 'America/New_York' });
    const bounded = sequence.bounded(
      new TimeRange({
        start: Date.parse('2025-03-08T05:00:00.000Z'),
        end: Date.parse('2025-03-10T04:00:00.000Z'),
      }),
    );

    expect(sequence.kind()).toBe('calendar');
    expect(sequence.timeZone()).toBe('America/New_York');
    expect(bounded.length).toBe(3);
    expect(bounded.at(0)).toEqual(
      new Interval({
        value: Date.parse('2025-03-08T05:00:00.000Z'),
        start: Date.parse('2025-03-08T05:00:00.000Z'),
        end: Date.parse('2025-03-09T05:00:00.000Z'),
      }),
    );
    expect(bounded.at(1)?.duration()).toBe(23 * 60 * 60 * 1_000);
    expect(bounded.at(2)).toEqual(
      new Interval({
        value: Date.parse('2025-03-10T04:00:00.000Z'),
        start: Date.parse('2025-03-10T04:00:00.000Z'),
        end: Date.parse('2025-03-11T04:00:00.000Z'),
      }),
    );
  });

  it('builds timezone-aware weekly calendar buckets with configurable week start', () => {
    const sequence = Sequence.calendar('week', {
      timeZone: 'UTC',
      weekStartsOn: 1,
    });
    const bounded = sequence.bounded(
      new TimeRange({
        start: Date.parse('2025-01-01T00:00:00.000Z'),
        end: Date.parse('2025-01-15T00:00:00.000Z'),
      }),
    );

    expect(bounded.length).toBe(2);
    expect(bounded.at(0)).toEqual(
      new Interval({
        value: Date.parse('2025-01-06T00:00:00.000Z'),
        start: Date.parse('2025-01-06T00:00:00.000Z'),
        end: Date.parse('2025-01-13T00:00:00.000Z'),
      }),
    );
    expect(bounded.at(1)?.duration()).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('builds timezone-aware monthly calendar buckets', () => {
    const sequence = Sequence.calendar('month', { timeZone: 'UTC' });
    const bounded = sequence.bounded(
      new TimeRange({
        start: Date.parse('2025-01-15T00:00:00.000Z'),
        end: Date.parse('2025-03-01T00:00:00.000Z'),
      }),
    );

    expect(bounded.length).toBe(2);
    expect(bounded.at(0)).toEqual(
      new Interval({
        value: Date.parse('2025-02-01T00:00:00.000Z'),
        start: Date.parse('2025-02-01T00:00:00.000Z'),
        end: Date.parse('2025-03-01T00:00:00.000Z'),
      }),
    );
    expect(bounded.at(1)).toEqual(
      new Interval({
        value: Date.parse('2025-03-01T00:00:00.000Z'),
        start: Date.parse('2025-03-01T00:00:00.000Z'),
        end: Date.parse('2025-04-01T00:00:00.000Z'),
      }),
    );
  });

  it('defaults calendar sequences to UTC', () => {
    const sequence = Sequence.calendar('day');
    const bounded = sequence.bounded(
      new TimeRange({
        start: Date.parse('2025-01-01T00:00:00.000Z'),
        end: Date.parse('2025-01-02T00:00:00.000Z'),
      }),
    );

    expect(sequence.timeZone()).toBe('UTC');
    expect(bounded.length).toBe(2);
    expect(bounded.at(0)).toEqual(
      new Interval({
        value: Date.parse('2025-01-01T00:00:00.000Z'),
        start: Date.parse('2025-01-01T00:00:00.000Z'),
        end: Date.parse('2025-01-02T00:00:00.000Z'),
      }),
    );
  });

  it('rejects fixed-step metadata access on calendar sequences', () => {
    const sequence = Sequence.calendar('day', { timeZone: 'UTC' });

    expect(() => sequence.anchor()).toThrowError('fixed millisecond anchor');
    expect(() => sequence.stepMs()).toThrowError('fixed millisecond step size');
  });
});

import { toPlainDateStart } from '../src/core/calendar.js';

describe('calendar math — fractional epoch milliseconds', () => {
  // Regression: `Temporal.Instant.fromEpochMilliseconds` refuses a fractional
  // epoch ms ("epoch milliseconds must be an integer"), and a fraction is not
  // a caller error. A chart's wheel-zoom derives its view range from pixel
  // positions via `xScale.invert()`, so an ordinary gesture produces
  // `1.7e12 + 0.37`; realizing a calendar sequence over that range threw, and
  // the exception unmounted the whole page.
  const JAN = Date.UTC(2020, 0, 1);
  const APR = Date.UTC(2020, 3, 1);

  it('does not throw on a fractional instant', () => {
    expect(() => toPlainDateStart(JAN + 0.37, 'UTC', 'month', 1)).not.toThrow();
  });

  it('puts a fraction in the same bucket as the millisecond containing it', () => {
    // The sub-millisecond part cannot change which calendar bucket an instant
    // falls in — boundaries are themselves whole milliseconds.
    for (const unit of ['day', 'week', 'month'] as const) {
      expect(toPlainDateStart(JAN + 0.37, 'UTC', unit, 1).toString()).toBe(
        toPlainDateStart(JAN, 'UTC', unit, 1).toString(),
      );
    }
  });

  it('floors rather than rounds — 0.99 cannot advance the bucket', () => {
    // One microsecond before a month boundary is still the previous month;
    // rounding up would skip a bucket exactly where a zoom tends to land.
    const lastMsOfMarch = APR - 1;
    expect(
      toPlainDateStart(lastMsOfMarch + 0.99, 'UTC', 'month', 1).toString(),
    ).toBe(toPlainDateStart(lastMsOfMarch, 'UTC', 'month', 1).toString());
  });

  it('floors negative epochs toward the containing millisecond', () => {
    // Pre-1970 `Math.floor` and `Math.trunc` disagree: -5.5 lies inside the
    // millisecond spanning [-6, -5), so it must floor to -6, not -5.
    expect(toPlainDateStart(-5.5, 'UTC', 'day', 1).toString()).toBe(
      toPlainDateStart(-6, 'UTC', 'day', 1).toString(),
    );
  });

  it('realizes a calendar sequence over a fractional range', () => {
    const sequence = Sequence.calendar('month', { timeZone: 'UTC' });
    const bounded = () =>
      sequence.bounded(new TimeRange({ start: JAN + 0.37, end: APR + 0.91 }));
    expect(bounded).not.toThrow();
    // Every emitted boundary is a whole millisecond, and the fraction shifts
    // nothing but inclusion at the edges: `JAN + 0.37` is after January's
    // start, so January is legitimately not in range.
    const b = bounded();
    const begins = Array.from({ length: b.length }, (_, i) => b.at(i)!.begin());
    expect(begins.every(Number.isInteger)).toBe(true);
    const whole = sequence.bounded(
      new TimeRange({ start: JAN + 1, end: APR + 1 }),
    );
    expect(begins).toEqual(
      Array.from({ length: whole.length }, (_, i) => whole.at(i)!.begin()),
    );
  });
});
