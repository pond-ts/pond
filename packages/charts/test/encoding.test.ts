import { describe, expect, it } from 'vitest';
import { finiteExtent, resolveEncoding } from '../src/encoding.js';
import type { ChartSeries } from '../src/data.js';

/** A scatter columnar view; only `length` matters for indexing here. */
const cs = (n: number): ChartSeries => ({
  x: new Float64Array(n),
  y: new Float64Array(n),
  length: n,
});

/** A column reader backed by a fixed map of name → values. */
const reader =
  (cols: Record<string, number[]>) =>
  (name: string): Float64Array => {
    const c = cols[name];
    if (c === undefined) throw new RangeError(`unknown column '${name}'`);
    return Float64Array.from(c);
  };

const BASE_R = 4;
const BASE_C = '#2563eb';

describe('finiteExtent', () => {
  it('returns [min, max] of finite values, ignoring NaN', () => {
    expect(finiteExtent(Float64Array.from([3, NaN, 1, 9]))).toEqual([1, 9]);
  });
  it('returns null when nothing is finite', () => {
    expect(finiteExtent(Float64Array.from([NaN, NaN]))).toBeNull();
  });
});

describe('resolveEncoding — radius', () => {
  it('omitted ⇒ the base radius for every point', () => {
    const e = resolveEncoding(
      cs(3),
      BASE_R,
      BASE_C,
      undefined,
      undefined,
      reader({}),
    );
    expect([0, 1, 2].map((i) => e.radiusAt(i))).toEqual([4, 4, 4]);
  });

  it('a number ⇒ that fixed radius for every point', () => {
    const e = resolveEncoding(cs(2), BASE_R, BASE_C, 7, undefined, reader({}));
    expect([0, 1].map((i) => e.radiusAt(i))).toEqual([7, 7]);
  });

  it('a column maps the finite extent linearly onto [minR, maxR]', () => {
    // values 0..10 → range [2, 12]: min→2, max→12, mid(5)→7.
    const e = resolveEncoding(
      cs(3),
      BASE_R,
      BASE_C,
      { column: 'v', range: [2, 12] },
      undefined,
      reader({ v: [0, 5, 10] }),
    );
    expect(e.radiusAt(0)).toBeCloseTo(2);
    expect(e.radiusAt(1)).toBeCloseTo(7);
    expect(e.radiusAt(2)).toBeCloseTo(12);
  });

  it('a non-finite cell falls back to the base radius', () => {
    const e = resolveEncoding(
      cs(3),
      BASE_R,
      BASE_C,
      { column: 'v', range: [2, 12] },
      undefined,
      reader({ v: [0, NaN, 10] }),
    );
    expect(e.radiusAt(1)).toBe(BASE_R);
  });

  it('an all-non-finite column degrades to the base radius (no scale)', () => {
    const e = resolveEncoding(
      cs(2),
      BASE_R,
      BASE_C,
      { column: 'v', range: [2, 12] },
      undefined,
      reader({ v: [NaN, NaN] }),
    );
    expect([0, 1].map((i) => e.radiusAt(i))).toEqual([4, 4]);
  });

  it('a degenerate (flat) extent maps every point to the low stop', () => {
    // all values equal → t=0 → minR.
    const e = resolveEncoding(
      cs(2),
      BASE_R,
      BASE_C,
      { column: 'v', range: [2, 12] },
      undefined,
      reader({ v: [5, 5] }),
    );
    expect([0, 1].map((i) => e.radiusAt(i))).toEqual([2, 2]);
  });
});

describe('resolveEncoding — colour', () => {
  it('omitted ⇒ the base colour for every point', () => {
    const e = resolveEncoding(
      cs(2),
      BASE_R,
      BASE_C,
      undefined,
      undefined,
      reader({}),
    );
    expect([0, 1].map((i) => e.colorAt(i))).toEqual([BASE_C, BASE_C]);
  });

  it('a column interpolates a two-stop hex ramp across the finite extent', () => {
    // values 0..10, ramp #000000 → #ffffff: min→black, max→white, mid→grey.
    const e = resolveEncoding(
      cs(3),
      BASE_R,
      BASE_C,
      undefined,
      { column: 'c', range: ['#000000', '#ffffff'] },
      reader({ c: [0, 5, 10] }),
    );
    expect(e.colorAt(0)).toBe('rgb(0, 0, 0)');
    expect(e.colorAt(2)).toBe('rgb(255, 255, 255)');
    expect(e.colorAt(1)).toBe('rgb(128, 128, 128)'); // round(127.5) = 128
  });

  it('supports 3-digit hex stops', () => {
    const e = resolveEncoding(
      cs(2),
      BASE_R,
      BASE_C,
      undefined,
      { column: 'c', range: ['#000', '#fff'] },
      reader({ c: [0, 10] }),
    );
    expect(e.colorAt(0)).toBe('rgb(0, 0, 0)');
    expect(e.colorAt(1)).toBe('rgb(255, 255, 255)');
  });

  it('a non-finite cell falls back to the base colour', () => {
    const e = resolveEncoding(
      cs(3),
      BASE_R,
      BASE_C,
      undefined,
      { column: 'c', range: ['#000000', '#ffffff'] },
      reader({ c: [0, NaN, 10] }),
    );
    expect(e.colorAt(1)).toBe(BASE_C);
  });

  it('an all-non-finite colour column degrades to the base colour', () => {
    const e = resolveEncoding(
      cs(2),
      BASE_R,
      BASE_C,
      undefined,
      { column: 'c', range: ['#000000', '#ffffff'] },
      reader({ c: [NaN, NaN] }),
    );
    expect([0, 1].map((i) => e.colorAt(i))).toEqual([BASE_C, BASE_C]);
  });

  it('a non-hex stop disables interpolation (falls back to the from stop)', () => {
    // mixHex returns `from` when a stop is not hex — a documented, no-guess
    // degrade rather than throwing on a bad colour.
    const e = resolveEncoding(
      cs(2),
      BASE_R,
      BASE_C,
      undefined,
      { column: 'c', range: ['rebeccapurple', '#ffffff'] },
      reader({ c: [0, 10] }),
    );
    expect(e.colorAt(0)).toBe('rebeccapurple');
    expect(e.colorAt(1)).toBe('rebeccapurple');
  });
});

describe('resolveEncoding — independence', () => {
  it('resolves radius and colour from different columns at once', () => {
    const e = resolveEncoding(
      cs(2),
      BASE_R,
      BASE_C,
      { column: 'r', range: [1, 5] },
      { column: 'c', range: ['#000000', '#ffffff'] },
      reader({ r: [0, 10], c: [0, 10] }),
    );
    expect(e.radiusAt(0)).toBeCloseTo(1);
    expect(e.radiusAt(1)).toBeCloseTo(5);
    expect(e.colorAt(0)).toBe('rgb(0, 0, 0)');
    expect(e.colorAt(1)).toBe('rgb(255, 255, 255)');
  });
});
