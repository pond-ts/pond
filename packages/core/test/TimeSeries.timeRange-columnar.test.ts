import { describe, expect, it } from 'vitest';
import { TimeRange, TimeSeries } from '../src/index.js';

// Pins the columnar `timeRange()` rewrite (audit v2 §3.3). The method
// now reads the key column's begin/end axis instead of reducing over
// materialized Events. The behavior contract is unchanged — these tests
// guard the cases where the columnar read could diverge from the old
// `this.events.reduce`, especially the non-monotone-end branch.

describe('TimeSeries.timeRange (columnar)', () => {
  const timeSchema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const;

  const rangeSchema = [
    { name: 'range', kind: 'timeRange' },
    { name: 'value', kind: 'number' },
  ] as const;

  it('time-keyed: extent is first begin .. last begin', () => {
    const ts = new TimeSeries({
      name: 'cpu',
      schema: timeSchema,
      rows: [
        [0, 1],
        [1_000, 2],
        [2_000, 3],
      ],
    });
    expect(ts.timeRange()).toEqual(new TimeRange({ start: 0, end: 2_000 }));
  });

  it('single time-keyed event: extent is the point itself', () => {
    const ts = new TimeSeries({
      name: 'cpu',
      schema: timeSchema,
      rows: [[5_000, 42]],
    });
    expect(ts.timeRange()).toEqual(new TimeRange({ start: 5_000, end: 5_000 }));
  });

  it('empty series: timeRange is undefined', () => {
    const ts = new TimeSeries({ name: 'cpu', schema: timeSchema, rows: [] });
    expect(ts.timeRange()).toBeUndefined();
  });

  // The load-bearing case: ends are NOT monotonic. A long early event
  // outlasts every later row, so the maximum end is its end (100), NOT
  // the final row's end (40). A "use the last row's end" shortcut would
  // get this wrong; the scan must consider every end.
  it('range-keyed: max end comes from a long early event, not the last row', () => {
    const ts = new TimeSeries({
      name: 'windowed',
      schema: rangeSchema,
      rows: [
        [new TimeRange({ start: 0, end: 100 }), 1],
        [new TimeRange({ start: 10, end: 20 }), 2],
        [new TimeRange({ start: 30, end: 40 }), 3],
      ],
    });
    expect(ts.timeRange()).toEqual(new TimeRange({ start: 0, end: 100 }));
    // The corrected extent flows through the derived predicates.
    expect(ts.contains(new TimeRange({ start: 50, end: 90 }))).toBe(true);
    expect(ts.overlaps(new TimeRange({ start: 90, end: 200 }))).toBe(true);
  });

  it('range-keyed: monotone ends still resolve to the last end', () => {
    const ts = new TimeSeries({
      name: 'windowed',
      schema: rangeSchema,
      rows: [
        [new TimeRange({ start: 0, end: 10 }), 1],
        [new TimeRange({ start: 10, end: 20 }), 2],
        [new TimeRange({ start: 30, end: 40 }), 3],
      ],
    });
    expect(ts.timeRange()).toEqual(new TimeRange({ start: 0, end: 40 }));
  });
});
