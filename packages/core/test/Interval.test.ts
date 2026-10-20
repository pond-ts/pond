import { describe, expect, it } from 'vitest';
import { Interval, TimeRange, TimeSeries } from '../src/index.js';

describe('Interval', () => {
  it('constructs a labeled interval', () => {
    const interval = new Interval({
      value: 'bucket-a',
      start: 1000,
      end: 2000,
    });

    expect(interval.type()).toBe('interval');
    expect(interval.begin()).toBe(1000);
    expect(interval.end()).toBe(2000);
    expect(interval.valueOf()).toBe('bucket-a');
    expect(interval.asString()).toBe('bucket-a');
    expect(interval.duration()).toBe(1000);
  });

  it('refuses a label that is not a string or a number [PND-JSONLABEL]', () => {
    for (const value of [true, false, null, [1], { a: 1 }]) {
      expect(
        () => new Interval({ value: value as never, start: 0, end: 1 }),
      ).toThrow(/interval label must be a string or a number/);
    }
    // fromJSON used to store these as numbers (true -> 1, null -> 0).
    expect(() =>
      TimeSeries.fromJSON({
        name: 'x',
        schema: [
          { name: 'interval', kind: 'interval' },
          { name: 'v', kind: 'number' },
        ] as const,
        rows: [[[true as never, 0, 1], 1]],
      }),
    ).toThrow(/interval label must be a string or a number; got boolean/);
  });

  it('uses label plus extent for equality and preserves label on trim', () => {
    const first = new Interval({ value: 'a', start: 0, end: 10 });
    const same = new Interval({ value: 'a', start: 0, end: 10 });
    const differentLabel = new Interval({ value: 'b', start: 0, end: 10 });

    expect(first.equals(same)).toBe(true);
    expect(first.equals(differentLabel)).toBe(false);
    expect(first.compare(differentLabel)).toBeLessThan(0);
    expect(first.trim(new TimeRange({ start: 5, end: 8 }))).toEqual(
      new Interval({ value: 'a', start: 5, end: 8 }),
    );
  });

  it('builds labeled local-day and calendar intervals from string references', () => {
    expect(Interval.fromDate('2025-01-01', { timeZone: 'UTC' })).toEqual(
      new Interval({
        value: '2025-01-01',
        start: Date.parse('2025-01-01T00:00:00.000Z'),
        end: Date.parse('2025-01-02T00:00:00.000Z'),
      }),
    );
    expect(
      Interval.fromCalendar('month', '2025-01', {
        timeZone: 'UTC',
        value: 'jan-2025',
      }),
    ).toEqual(
      new Interval({
        value: 'jan-2025',
        start: Date.parse('2025-01-01T00:00:00.000Z'),
        end: Date.parse('2025-02-01T00:00:00.000Z'),
      }),
    );
  });
});
