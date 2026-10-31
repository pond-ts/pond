/**
 * [PND-SMOOTHMID]: `movingAverage` and `loess` place a time-range or interval
 * row at its midpoint. Keys sort by begin, so a long range before a short one
 * puts the midpoints out of order; the window sweep and the loess neighbour
 * search must still see them in time order.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

// Midpoints 5, 1, 2, 3: the first row's range covers the rest.
const ranges = () =>
  TimeSeries.fromJSON({
    name: 'r',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ],
    rows: [
      [[0, 10], 1],
      [[1, 1], 100],
      [[2, 2], 3],
      [[3, 3], 5],
    ],
  });

const values = (s: TimeSeries<any>) =>
  s.toJSON().rows.map((row) => row[1] as number | null);

describe('smooth on time ranges whose midpoints run backwards', () => {
  it('movingAverage windows by midpoint, not by row position', () => {
    // Trailing 2ms windows: (3, 5] holds only row 0; (-1, 1] only row 1;
    // (0, 2] rows 1 and 2; (1, 3] rows 2 and 3.
    const out = ranges().smooth('v', 'movingAverage', { window: '2ms' });
    expect(values(out)).toEqual([1, 100, 51.5, 4]);
  });

  it('loess fits each row from its nearest midpoints', () => {
    // span 0.5 of 4 values: the two nearest. Row 0 (midpoint 5) is
    // nearest itself and row 3 (midpoint 3), so row 1's 100 is not used.
    const out = ranges().smooth('v', 'loess', { span: 0.5 });
    expect(values(out)[0]).toBe(1);
  });

  it('gives the same answer as the same rows keyed by their midpoints', () => {
    const byTime = TimeSeries.fromJSON({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ],
      rows: [
        [1, 100],
        [2, 3],
        [3, 5],
        [5, 1],
      ],
    });
    for (const alignment of ['trailing', 'leading', 'centered'] as const) {
      const r = values(
        ranges().smooth('v', 'movingAverage', { window: '3ms', alignment }),
      );
      const t = values(
        byTime.smooth('v', 'movingAverage', { window: '3ms', alignment }),
      );
      expect([r[1], r[2], r[3], r[0]]).toEqual(t);
    }
    const r = values(ranges().smooth('v', 'loess', { span: 0.75 }));
    const t = values(byTime.smooth('v', 'loess', { span: 0.75 }));
    expect([r[1], r[2], r[3], r[0]]).toEqual(t);
  });
});
