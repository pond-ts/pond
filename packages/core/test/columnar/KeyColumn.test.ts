import { describe, expect, it } from 'vitest';

import {
  Float64Column,
  IntervalKeyColumn,
  MAX_COLUMN_LENGTH,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  stringColumnDictEncoded,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
  validityFromBits,
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

  it('end === begin for time keys (same buffer reference)', () => {
    const col = timeKeyColumnFromArray([1000, 2000, 3000]);
    expect(col.end).toBe(col.begin);
    expect(col.endAt(0)).toBe(col.beginAt(0));
    expect(col.endAt(1)).toBe(col.beginAt(1));
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

  it('factory rejects begin > end pairs', () => {
    expect(() => timeRangeKeyColumnFromPairs([[200, 100]])).toThrow(RangeError);
  });

  it('direct constructor also rejects inverted pairs eagerly', () => {
    const begin = Float64Array.of(0, 200);
    const end = Float64Array.of(10, 100);
    expect(() => new TimeRangeKeyColumn(begin, end, 2)).toThrow(
      /row 1 has begin 200 > end 100/,
    );
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
      { forceDict: true },
    );
    return new IntervalKeyColumn(begin, end, labels, 3);
  }

  it('builds with label StringColumn and reports labelKind', () => {
    const col = makeIntervalCol();
    expect(col.kind).toBe('interval');
    expect(col.length).toBe(3);
    expect(col.labelKind).toBe('string');
    expect(col.labelAt(1)).toBe('d-2025-01-02');
  });

  it('rejects label column with mismatched length', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnDictEncoded(['x'], Int32Array.of(0));
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      RangeError,
    );
  });

  it('rejects inverted begin/end pairs eagerly at construction', () => {
    const begin = Float64Array.of(0, 5);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1));
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      /row 1 has begin 5 > end 2/,
    );
  });

  it('rejects rows whose label column marks them invalid', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnFromArray([undefined, 'b'], { forceDict: true });
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      /row 0 has no label/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Finite-timestamp validation                                                 */
/* -------------------------------------------------------------------------- */

describe('Finite-timestamp validation', () => {
  it('TimeKeyColumn rejects NaN', () => {
    expect(() => new TimeKeyColumn(Float64Array.of(0, NaN, 2), 3)).toThrow(
      /begin\[1\].*must be a finite number/,
    );
  });

  it('TimeKeyColumn rejects Infinity', () => {
    expect(() => new TimeKeyColumn(Float64Array.of(0, Infinity), 2)).toThrow(
      /begin\[1\]/,
    );
    expect(() => new TimeKeyColumn(Float64Array.of(-Infinity, 0), 2)).toThrow(
      /begin\[0\]/,
    );
  });

  it('TimeKeyColumn factory rejects non-finite timestamps from arrays', () => {
    expect(() => timeKeyColumnFromArray([1, NaN, 3])).toThrow(
      /must be a finite number/,
    );
  });

  it('TimeRangeKeyColumn rejects NaN in begin or end', () => {
    expect(
      () =>
        new TimeRangeKeyColumn(
          Float64Array.of(0, NaN),
          Float64Array.of(1, 2),
          2,
        ),
    ).toThrow(/begin\[1\]/);
    expect(
      () =>
        new TimeRangeKeyColumn(
          Float64Array.of(0, 1),
          Float64Array.of(NaN, 2),
          2,
        ),
    ).toThrow(/end\[0\]/);
  });

  it('IntervalKeyColumn rejects non-finite timestamps', () => {
    const labels = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1));
    expect(
      () =>
        new IntervalKeyColumn(
          Float64Array.of(NaN, 1),
          Float64Array.of(0.5, 2),
          labels,
          2,
        ),
    ).toThrow(/begin\[0\]/);
  });
});

/* -------------------------------------------------------------------------- */
/* IntervalKeyColumn label discriminator                                       */
/* -------------------------------------------------------------------------- */

describe('IntervalKeyColumn label discriminator', () => {
  it('accepts Float64Column for numeric labels', () => {
    const begin = Float64Array.of(0, 86_400_000);
    const end = Float64Array.of(86_400_000, 172_800_000);
    const numericLabels = new Float64Column(Float64Array.of(1, 2), 2);
    const col = new IntervalKeyColumn(begin, end, numericLabels, 2);
    expect(col.labelKind).toBe('number');
    expect(col.labels).toBe(numericLabels);
    expect(col.labelAt(0)).toBe(1);
    expect(col.labelAt(1)).toBe(2);
  });

  it('rejects a BooleanColumn cast as label storage', async () => {
    const { BooleanColumn } = await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const booleanLabels = new BooleanColumn(new Uint8Array([0b11]), 2);
    expect(
      () =>
        new IntervalKeyColumn(
          begin,
          end,
          booleanLabels as unknown as Parameters<typeof IntervalKeyColumn>[2],
          2,
        ),
    ).toThrow(/labels must be a StringColumn.*or Float64Column/);
  });

  it('rejects a Float64Column with NaN labels', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const numericLabels = new Float64Column(Float64Array.of(NaN, 5), 2);
    expect(() => new IntervalKeyColumn(begin, end, numericLabels, 2)).toThrow(
      /numeric label NaN is not a finite number/,
    );
  });

  it('rejects a Float64Column with Infinity labels', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const numericLabels = new Float64Column(Float64Array.of(5, Infinity), 2);
    expect(() => new IntervalKeyColumn(begin, end, numericLabels, 2)).toThrow(
      /numeric label Infinity is not a finite number/,
    );
  });

  it('rejects validity-marked-invalid label rows via labelAt undefined', () => {
    // Float64Column with explicit validity marking row 0 invalid.
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const validity = validityFromBits(new Uint8Array([0b10]), 2);
    const labels = new Float64Column(Float64Array.of(0, 5), 2, validity);
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      /row 0 has no label/,
    );
  });
});
