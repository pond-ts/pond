import { describe, expect, it } from 'vitest';

import { Interval } from '../../src/Interval.js';
import { Time } from '../../src/Time.js';
import { TimeRange } from '../../src/TimeRange.js';
import {
  IntervalKeyColumn,
  MAX_COLUMN_LENGTH,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  stringColumnDictEncoded,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* TimeKeyColumn                                                              */
/* -------------------------------------------------------------------------- */

describe('TimeKeyColumn', () => {
  it('builds from an array of timestamps', () => {
    const col = timeKeyColumnFromArray([1000, 2000, 3000]);
    expect(col.kind).toBe('time');
    expect(col.length).toBe(3);
    expect(col.beginAt(0)).toBe(1000);
    expect(col.beginAt(2)).toBe(3000);
  });

  it('end === begin for time keys', () => {
    const col = timeKeyColumnFromArray([1000, 2000, 3000]);
    expect(col.end).toBe(col.begin);
    expect(col.endAt(0)).toBe(col.beginAt(0));
    expect(col.endAt(1)).toBe(col.beginAt(1));
  });

  it('keyAt returns a Time instance', () => {
    const col = timeKeyColumnFromArray([1000, 2000]);
    const key = col.keyAt(0);
    expect(key).toBeInstanceOf(Time);
    expect(key.begin()).toBe(1000);
    expect(key.end()).toBe(1000);
  });

  it('keyAt cache pins reference identity across calls', () => {
    const col = timeKeyColumnFromArray([1000, 2000]);
    const a = col.keyAt(0);
    const b = col.keyAt(0);
    expect(a).toBe(b); // strict-equal reference
  });

  it('keyAt out of range throws', () => {
    const col = timeKeyColumnFromArray([1000]);
    expect(() => col.keyAt(-1)).toThrow(RangeError);
    expect(() => col.keyAt(1)).toThrow(RangeError);
  });

  it('beginAt / endAt out of range throws', () => {
    const col = timeKeyColumnFromArray([1000]);
    expect(() => col.beginAt(-1)).toThrow(RangeError);
    expect(() => col.beginAt(1)).toThrow(RangeError);
    expect(() => col.endAt(1)).toThrow(RangeError);
  });

  it('rejects buffer underflow', () => {
    expect(() => new TimeKeyColumn(new Float64Array(1), 2)).toThrow(RangeError);
  });

  it('rejects negative length', () => {
    expect(() => new TimeKeyColumn(new Float64Array(2), -1)).toThrow(
      RangeError,
    );
  });

  it('rejects MAX_COLUMN_LENGTH + 1', () => {
    expect(
      () => new TimeKeyColumn(new Float64Array(0), MAX_COLUMN_LENGTH + 1),
    ).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* TimeRangeKeyColumn                                                         */
/* -------------------------------------------------------------------------- */

describe('TimeRangeKeyColumn', () => {
  it('builds from begin / end pairs', () => {
    const col = timeRangeKeyColumnFromPairs([
      [1000, 2000],
      [2000, 5000],
      [5000, 5500],
    ]);
    expect(col.kind).toBe('timeRange');
    expect(col.length).toBe(3);
    expect(col.beginAt(1)).toBe(2000);
    expect(col.endAt(1)).toBe(5000);
  });

  it('keyAt returns a TimeRange instance', () => {
    const col = timeRangeKeyColumnFromPairs([[100, 200]]);
    const key = col.keyAt(0);
    expect(key).toBeInstanceOf(TimeRange);
    expect(key.begin()).toBe(100);
    expect(key.end()).toBe(200);
  });

  it('keyAt cache pins reference identity', () => {
    const col = timeRangeKeyColumnFromPairs([[100, 200]]);
    expect(col.keyAt(0)).toBe(col.keyAt(0));
  });

  it('rejects begin > end pairs', () => {
    expect(() => timeRangeKeyColumnFromPairs([[200, 100]])).toThrow(RangeError);
  });

  it('rejects buffer underflow on either side', () => {
    expect(
      () => new TimeRangeKeyColumn(new Float64Array(1), new Float64Array(2), 2),
    ).toThrow(/begin/);
    expect(
      () => new TimeRangeKeyColumn(new Float64Array(2), new Float64Array(1), 2),
    ).toThrow(/end/);
  });
});

/* -------------------------------------------------------------------------- */
/* IntervalKeyColumn                                                          */
/* -------------------------------------------------------------------------- */

describe('IntervalKeyColumn', () => {
  function makeIntervalCol(): IntervalKeyColumn {
    const begin = Float64Array.of(0, 86_400_000, 172_800_000);
    const end = Float64Array.of(86_400_000, 172_800_000, 259_200_000);
    const labels = stringColumnFromArray(
      ['d-2025-01-01', 'd-2025-01-02', 'd-2025-01-03'],
      {
        forceDict: true,
      },
    );
    return new IntervalKeyColumn(begin, end, labels, 3);
  }

  it('builds with label StringColumn', () => {
    const col = makeIntervalCol();
    expect(col.kind).toBe('interval');
    expect(col.length).toBe(3);
    expect(col.labelAt(1)).toBe('d-2025-01-02');
  });

  it('keyAt returns an Interval instance', () => {
    const col = makeIntervalCol();
    const key = col.keyAt(1);
    expect(key).toBeInstanceOf(Interval);
    expect(key.begin()).toBe(86_400_000);
    expect(key.end()).toBe(172_800_000);
    expect((key as Interval).value).toBe('d-2025-01-02');
  });

  it('keyAt cache pins reference identity', () => {
    const col = makeIntervalCol();
    expect(col.keyAt(0)).toBe(col.keyAt(0));
    expect(col.keyAt(2)).toBe(col.keyAt(2));
  });

  it('rejects label column with mismatched length', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnDictEncoded(['x'], Int32Array.of(0));
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      RangeError,
    );
  });

  it('keyAt on a row with invalid label throws (cannot materialize a labeled interval)', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    // Use the public factory's `undefined`-aware path: derives validity
    // automatically marking row 0 as invalid.
    const labels = stringColumnFromArray([undefined, 'b'], { forceDict: true });
    const col = new IntervalKeyColumn(begin, end, labels, 2);
    expect(() => col.keyAt(0)).toThrow(/no interval label/);
    expect(col.keyAt(1)).toBeInstanceOf(Interval);
  });
});

/* -------------------------------------------------------------------------- */
/* Cache behavior across all variants                                         */
/* -------------------------------------------------------------------------- */

describe('Key cache identity across variants', () => {
  it('repeated keyAt calls on the same row return the same reference', () => {
    const timeCol = timeKeyColumnFromArray([100, 200]);
    expect(timeCol.keyAt(1)).toBe(timeCol.keyAt(1));

    const trCol = timeRangeKeyColumnFromPairs([
      [0, 10],
      [10, 20],
    ]);
    expect(trCol.keyAt(0)).toBe(trCol.keyAt(0));
  });

  it('different rows produce different EventKey instances', () => {
    const col = timeKeyColumnFromArray([100, 200, 300]);
    const a = col.keyAt(0);
    const b = col.keyAt(1);
    expect(a).not.toBe(b);
    expect(a.begin()).toBe(100);
    expect(b.begin()).toBe(200);
  });

  it('cache survives across mixed-row access patterns', () => {
    const col = timeKeyColumnFromArray([100, 200, 300, 400]);
    const k0 = col.keyAt(0);
    const k2 = col.keyAt(2);
    const k0Again = col.keyAt(0);
    const k2Again = col.keyAt(2);
    expect(k0).toBe(k0Again);
    expect(k2).toBe(k2Again);
  });
});
