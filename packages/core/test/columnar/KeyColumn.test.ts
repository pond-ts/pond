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

  it('factory rejects begin > end pairs', () => {
    expect(() => timeRangeKeyColumnFromPairs([[200, 100]])).toThrow(RangeError);
  });

  it('direct constructor also rejects inverted pairs eagerly', () => {
    // Pre-fix: the constructor accepted inverted pairs and deferred
    // the error to keyAt time. Now it matches the factory's eager
    // validation, with the row index in the message.
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

  it('rejects inverted begin/end pairs eagerly at construction', () => {
    // Same eager-validation contract as TimeRangeKeyColumn.
    const begin = Float64Array.of(0, 5);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1));
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      /row 1 has begin 5 > end 2/,
    );
  });

  it('rejects rows whose label column marks them invalid (Codex round 1)', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    // Use the factory's `undefined`-aware path: derives validity
    // automatically marking row 0 as invalid.
    const labels = stringColumnFromArray([undefined, 'b'], { forceDict: true });
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      /row 0 has no label/,
    );
  });

  it('accepts every-row-defined label column', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnFromArray(['a', 'b'], { forceDict: true });
    const col = new IntervalKeyColumn(begin, end, labels, 2);
    expect(col.labelAt(0)).toBe('a');
    expect(col.keyAt(0)).toBeInstanceOf(Interval);
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

/* -------------------------------------------------------------------------- */
/* Codex round-1 regressions: finite-timestamp + label-defined-ness eager     */
/* validation across all three KeyColumn variants.                            */
/* -------------------------------------------------------------------------- */

describe('Finite-timestamp validation (Codex round 1)', () => {
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

describe('IntervalKeyColumn rejects undefined label rows (Codex round 1)', () => {
  it('rejects fallback-mode label column with undefined slot', () => {
    const begin = Float64Array.of(0, 1, 2);
    const end = Float64Array.of(1, 2, 3);
    // Fallback mode with one undefined slot in the middle.
    const labels = stringColumnFromArray(['a', undefined, 'c']);
    expect(() => new IntervalKeyColumn(begin, end, labels, 3)).toThrow(
      /row 1 has no label/,
    );
  });

  it('rejects dict-mode label column with invalid validity bit', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnFromArray(['a', undefined], {
      forceDict: true,
    });
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      /row 1 has no label/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-2 regressions: numeric interval labels + ArrayColumn mutation  */
/* -------------------------------------------------------------------------- */

describe('IntervalKeyColumn numeric labels (Codex round 2)', () => {
  it('accepts a Float64Column as label storage', async () => {
    const { Float64Column } = await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 86_400_000);
    const end = Float64Array.of(86_400_000, 172_800_000);
    const numericLabels = new Float64Column(Float64Array.of(1, 2), 2);
    const col = new IntervalKeyColumn(begin, end, numericLabels, 2);
    expect(col.labelKind).toBe('number');
    expect(col.labels).toBe(numericLabels);
    expect(col.labelAt(0)).toBe(1);
    expect(col.labelAt(1)).toBe(2);
  });

  it('keyAt round-trips numeric labels without stringification', async () => {
    const { Float64Column } = await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 100);
    const end = Float64Array.of(50, 200);
    const numericLabels = new Float64Column(Float64Array.of(42, 7), 2);
    const col = new IntervalKeyColumn(begin, end, numericLabels, 2);
    const k0 = col.keyAt(0);
    const k1 = col.keyAt(1);
    expect(k0).toBeInstanceOf(Interval);
    // Pin that the label is genuinely a number, not stringified.
    expect(typeof (k0 as Interval).value).toBe('number');
    expect((k0 as Interval).value).toBe(42);
    expect((k1 as Interval).value).toBe(7);
  });

  it('string-labeled column reports labelKind = "string"', () => {
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const labels = stringColumnFromArray(['x', 'y'], { forceDict: true });
    const col = new IntervalKeyColumn(begin, end, labels, 2);
    expect(col.labelKind).toBe('string');
    expect(typeof col.labelAt(0)).toBe('string');
  });

  it('rejects numeric label column with non-finite labels', async () => {
    // Float64Column.constructor already rejects NaN/Infinity for
    // validity-marked-defined cells via reads-undefined path... but
    // when labels are numeric, the label-defined check fires.
    const { Float64Column, validityFromBits } =
      await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    // Use validity to mark row 0 as invalid; row 1 has a valid finite label.
    const validity = validityFromBits(new Uint8Array([0b10]), 2);
    const labels = new Float64Column(Float64Array.of(0, 5), 2, validity);
    expect(() => new IntervalKeyColumn(begin, end, labels, 2)).toThrow(
      /row 0 has no label/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-3 regression: hardened label-column discrimination              */
/* -------------------------------------------------------------------------- */

describe('IntervalKeyColumn label discriminator (Codex round 3)', () => {
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

  it('rejects an ArrayColumn cast as label storage', async () => {
    const { arrayColumnFromArray } =
      await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const arrayLabels = arrayColumnFromArray([[1], [2]]);
    expect(
      () =>
        new IntervalKeyColumn(
          begin,
          end,
          arrayLabels as unknown as Parameters<typeof IntervalKeyColumn>[2],
          2,
        ),
    ).toThrow(/got kind 'array'/);
  });

  it('rejects a Float64Column with NaN labels', async () => {
    const { Float64Column } = await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const numericLabels = new Float64Column(Float64Array.of(NaN, 5), 2);
    expect(() => new IntervalKeyColumn(begin, end, numericLabels, 2)).toThrow(
      /numeric label NaN is not a finite number/,
    );
  });

  it('rejects a Float64Column with Infinity labels', async () => {
    const { Float64Column } = await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const numericLabels = new Float64Column(Float64Array.of(5, Infinity), 2);
    expect(() => new IntervalKeyColumn(begin, end, numericLabels, 2)).toThrow(
      /numeric label Infinity is not a finite number/,
    );
  });

  it('accepts only valid finite numeric labels', async () => {
    const { Float64Column } = await import('../../src/columnar/index.js');
    const begin = Float64Array.of(0, 1);
    const end = Float64Array.of(1, 2);
    const numericLabels = new Float64Column(Float64Array.of(7, 13), 2);
    const col = new IntervalKeyColumn(begin, end, numericLabels, 2);
    expect(col.labelKind).toBe('number');
    expect(col.labelAt(0)).toBe(7);
    expect(col.labelAt(1)).toBe(13);
  });

  it('string-labeled column passes the per-row type assertion', () => {
    // Defense-in-depth check: labelKind discriminator + per-row typeof
    // assertion. Most callers can't trip this because StringColumn
    // enforces its own type contract — but the explicit typeof check
    // guards against a future Column-kind that returns mixed types.
    const begin = Float64Array.of(0);
    const end = Float64Array.of(1);
    const labels = stringColumnFromArray(['hello'], { forceDict: true });
    const col = new IntervalKeyColumn(begin, end, labels, 1);
    expect(col.labelKind).toBe('string');
    expect(typeof col.labelAt(0)).toBe('string');
  });
});
