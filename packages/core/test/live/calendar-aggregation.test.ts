/**
 * Live `aggregate` over calendar sequences: buckets follow the sequence's
 * time zone, so their length varies (DST days, months).
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries, Sequence } from '../../src/index.js';

const HOUR = 3_600_000;
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const hours = (e: { begin(): number; end(): number }) =>
  (e.end() - e.begin()) / HOUR;

describe('LiveAggregation with calendar sequences', () => {
  it('New York days across the DST change: 24h, 23h, 24h', () => {
    const live = new LiveSeries({ name: 'x', schema });
    const days = live.aggregate(
      Sequence.calendar('day', { timeZone: 'America/New_York' }),
      { v: 'sum' },
    );
    const t0 = Date.UTC(2026, 2, 7, 12); // 07:00 in New York
    for (let h = 0; h < 72; h += 6) live.push([t0 + h * HOUR, 1]);
    const closed = days.closed().events;
    expect(closed.map(hours)).toEqual([24, 23, 24]);
    expect(closed.map((e) => e.begin())).toEqual([
      Date.UTC(2026, 2, 7, 5),
      Date.UTC(2026, 2, 8, 5),
      Date.UTC(2026, 2, 9, 4),
    ]);
    expect(closed.map((e) => e.get('v'))).toEqual([3, 4, 4]);
  });

  it('a late event goes to its own bucket, not the last one looked up', () => {
    const live = new LiveSeries({
      name: 'x',
      schema,
      ordering: 'reorder',
      graceWindow: '2d',
    });
    const days = live.aggregate(Sequence.calendar('day', { timeZone: 'UTC' }), {
      v: 'sum',
    });
    const day = 24 * HOUR;
    live.push([0, 1]);
    live.push([day + 1, 10]);
    live.push([5, 100]); // back into day 0, still open
    live.push([4 * day, 0]); // closes days 0 and 1
    expect(days.closed().events.map((e) => e.get('v'))).toEqual([101, 10]);
  });

  it('months in London', () => {
    const live = new LiveSeries({ name: 'x', schema });
    const months = live.aggregate(
      Sequence.calendar('month', { timeZone: 'Europe/London' }),
      { v: 'count' },
    );
    for (const [m, d] of [
      [0, 15],
      [1, 1],
      [1, 28],
      [2, 31],
    ] as const) {
      live.push([Date.UTC(2026, m, d, 12), 1]);
    }
    const closed = months.closed().events;
    expect(closed.map((e) => e.get('v'))).toEqual([1, 2]);
    expect(closed.map(hours)).toEqual([31 * 24, 28 * 24]);
    // March in London starts at midnight GMT; BST starts on the 29th.
    expect(months.snapshot().events.at(-1)!.begin()).toBe(Date.UTC(2026, 2, 1));
  });
});
