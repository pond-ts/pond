import { describe, expect, it } from 'vitest';
import { TimeSeries, ValueSeries } from 'pond-ts';
import {
  bandFromValueSeries,
  barsFromTimeSeries,
  barsFromValueSeries,
  boxFromTimeSeries,
  boxFromValueSeries,
  fromTimeSeries,
  fromValueSeries,
} from '../src/data.js';

const numeric = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 10],
      [1, 20],
      [2, 30],
    ],
  });

describe('fromTimeSeries', () => {
  it('extracts x (timestamps) and y (values) as equal-length Float64Arrays', () => {
    const cs = fromTimeSeries(numeric(), 'v');
    expect(cs.x).toBeInstanceOf(Float64Array);
    expect(cs.y).toBeInstanceOf(Float64Array);
    expect(Array.from(cs.x)).toEqual([0, 1, 2]);
    expect(Array.from(cs.y)).toEqual([10, 20, 30]);
    expect(cs.length).toBe(3);
    expect(cs.x.length).toBe(cs.y.length);
  });

  it('represents missing values as NaN (the gap signal)', () => {
    const s = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 10],
        [1, undefined],
        [2, 30],
      ] as never,
    });
    const cs = fromTimeSeries(s, 'v');
    expect(cs.y[0]).toBe(10);
    expect(Number.isNaN(cs.y[1]!)).toBe(true);
    expect(cs.y[2]).toBe(30);
  });

  it('throws on an unknown column', () => {
    expect(() => fromTimeSeries(numeric(), 'nope')).toThrow(/unknown column/);
  });

  it('throws on a non-numeric column', () => {
    const s = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'label', kind: 'string' },
      ] as const,
      rows: [[0, 'a']],
    });
    expect(() => fromTimeSeries(s, 'label')).toThrow(/numeric|number/);
  });
});

describe('barsFromTimeSeries', () => {
  const intervalSchema = [
    { name: 'interval', kind: 'interval' },
    { name: 'count', kind: 'number' },
  ] as const;

  it('uses the key [begin,end] verbatim for an interval-keyed series', () => {
    const s = new TimeSeries({
      name: 'iv',
      schema: intervalSchema,
      rows: [
        [['a', 0, 1000], 10],
        [['b', 1000, 3000], 20], // a wider bucket
      ],
    });
    const bs = barsFromTimeSeries(s, 'count');
    expect(Array.from(bs.begin)).toEqual([0, 1000]);
    expect(Array.from(bs.end)).toEqual([1000, 3000]);
    expect(Array.from(bs.y)).toEqual([10, 20]);
    expect(bs.length).toBe(2);
  });

  it('uses begin/end verbatim for a timeRange-keyed series', () => {
    const s = new TimeSeries({
      name: 'tr',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [[0, 2000], 5],
        [[2000, 5000], 7],
      ],
    });
    const bs = barsFromTimeSeries(s, 'v');
    expect(Array.from(bs.begin)).toEqual([0, 2000]);
    expect(Array.from(bs.end)).toEqual([2000, 5000]);
  });

  it('derives a neighbour-spacing span for a point-keyed series', () => {
    // Uniform 100-spaced points → each interior bar is centred on its time and
    // reaches halfway to each neighbour (width 100). Edges mirror their single
    // adjacent gap, so they match the interior width.
    const s = new TimeSeries({
      name: 'pt',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [100, 1],
        [200, 2],
        [300, 3],
      ],
    });
    const bs = barsFromTimeSeries(s, 'v');
    // interior point 200: [150, 250]; left edge 100: mirror the next gap (100) →
    // [50, 150]; right edge 300: mirror the prev gap → [250, 350].
    expect(Array.from(bs.begin)).toEqual([50, 150, 250]);
    expect(Array.from(bs.end)).toEqual([150, 250, 350]);
    // contiguous: each bar's end meets the next bar's begin.
    expect(bs.end[0]).toBe(bs.begin[1]);
    expect(bs.end[1]).toBe(bs.begin[2]);
  });

  it('handles irregular point spacing (half-gap each side)', () => {
    const s = new TimeSeries({
      name: 'pt',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [100, 2], // 100 from prev
        [400, 3], // 300 from prev
      ],
    });
    const bs = barsFromTimeSeries(s, 'v');
    // point 100: prevGap 100, nextGap 300 → [100-50, 100+150] = [50, 250].
    expect(bs.begin[1]).toBe(50);
    expect(bs.end[1]).toBe(250);
  });

  it('gives a lone point zero width (falls back to renderer minWidth)', () => {
    const s = new TimeSeries({
      name: 'pt',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [[500, 9]],
    });
    const bs = barsFromTimeSeries(s, 'v');
    expect(Array.from(bs.begin)).toEqual([500]);
    expect(Array.from(bs.end)).toEqual([500]);
  });

  it('represents a missing value as NaN (the gap signal)', () => {
    const s = new TimeSeries({
      name: 'iv',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'count', kind: 'number', required: false },
      ] as const,
      rows: [
        [['a', 0, 1000], 10],
        [['b', 1000, 2000], undefined],
      ] as never,
    });
    const bs = barsFromTimeSeries(s, 'count');
    expect(bs.y[0]).toBe(10);
    expect(Number.isNaN(bs.y[1]!)).toBe(true);
  });

  it('throws on an unknown column', () => {
    const s = new TimeSeries({
      name: 'iv',
      schema: intervalSchema,
      rows: [[['a', 0, 1000], 10]],
    });
    expect(() => barsFromTimeSeries(s, 'nope')).toThrow(/unknown column/);
  });
});

describe('fromValueSeries', () => {
  // A short ride re-keyed onto cumulative distance: x is distance, not time.
  const ride = () =>
    new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'hr', kind: 'number' },
      ] as const,
      rows: [
        [0, 0, 120],
        [1000, 500, 130],
        [2000, 1200, 140],
      ],
    });

  it('uses the value axis as x and a channel as y (equal-length Float64Arrays)', () => {
    const cs = fromValueSeries(ride().byValue('cumDist'), 'hr');
    expect(cs.x).toBeInstanceOf(Float64Array);
    expect(cs.y).toBeInstanceOf(Float64Array);
    // x is cumulative distance (the axis), NOT time
    expect(Array.from(cs.x)).toEqual([0, 500, 1200]);
    expect(Array.from(cs.y)).toEqual([120, 130, 140]);
    expect(cs.length).toBe(3);
    expect(cs.x.length).toBe(cs.y.length);
  });

  it('represents missing channel values as NaN (the gap signal)', () => {
    const s = new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'hr', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 0, 120],
        [1000, 500, undefined],
        [2000, 1200, 140],
      ] as never,
    });
    const cs = fromValueSeries(s.byValue('cumDist'), 'hr');
    expect(cs.y[0]).toBe(120);
    expect(Number.isNaN(cs.y[1]!)).toBe(true);
    expect(cs.y[2]).toBe(140);
  });

  it('throws on an unknown column', () => {
    expect(() => fromValueSeries(ride().byValue('cumDist'), 'nope')).toThrow(
      /unknown column/,
    );
  });

  it('throws on a non-numeric column', () => {
    const s = new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'label', kind: 'string' },
      ] as const,
      rows: [[0, 0, 'a']],
    });
    expect(() => fromValueSeries(s.byValue('cumDist'), 'label')).toThrow(
      /must be numeric/,
    );
  });
});

describe('bandFromValueSeries', () => {
  // A short ride re-keyed onto cumulative distance, carrying a p25/p75 envelope:
  // x is distance, lower/upper are the two edges (cf. bandFromTimeSeries).
  const ride = () =>
    new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'p25', kind: 'number', required: false },
        { name: 'p75', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 0, 118, 124],
        [1000, 500, 128, 134],
        [2000, 1200, 138, 144],
      ] as never,
    });

  it('uses the value axis as x and lower/upper as the two edges', () => {
    const bs = bandFromValueSeries(ride().byValue('cumDist'), 'p25', 'p75');
    expect(bs.x).toBeInstanceOf(Float64Array);
    expect(bs.lower).toBeInstanceOf(Float64Array);
    expect(bs.upper).toBeInstanceOf(Float64Array);
    // x is cumulative distance (the axis), NOT time
    expect(Array.from(bs.x)).toEqual([0, 500, 1200]);
    expect(Array.from(bs.lower)).toEqual([118, 128, 138]);
    expect(Array.from(bs.upper)).toEqual([124, 134, 144]);
    expect(bs.length).toBe(3);
    expect(bs.lower.length).toBe(bs.upper.length);
  });

  it('represents a missing edge as NaN (the gap signal, either edge)', () => {
    const s = new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'p25', kind: 'number', required: false },
        { name: 'p75', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 0, 118, 124],
        [1000, 500, undefined, 134],
        [2000, 1200, 138, undefined],
      ] as never,
    });
    const bs = bandFromValueSeries(s.byValue('cumDist'), 'p25', 'p75');
    expect(Number.isNaN(bs.lower[1]!)).toBe(true);
    expect(Number.isNaN(bs.upper[2]!)).toBe(true);
    expect(bs.lower[0]).toBe(118);
    expect(bs.upper[1]).toBe(134);
  });

  it('throws on an unknown edge column', () => {
    expect(() =>
      bandFromValueSeries(ride().byValue('cumDist'), 'p25', 'nope'),
    ).toThrow(/unknown column/);
  });

  it('throws on a non-numeric edge column', () => {
    const s = new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'p25', kind: 'number' },
        { name: 'label', kind: 'string' },
      ] as const,
      rows: [[0, 0, 118, 'a']],
    });
    expect(() =>
      bandFromValueSeries(s.byValue('cumDist'), 'p25', 'label'),
    ).toThrow(/must be numeric/);
  });
});

describe('barsFromValueSeries', () => {
  // Segments keyed onto the value axis (e.g. split centres on cumulative
  // distance): point-keyed, so the bar span is neighbour-derived (Voronoi cell).
  const segs = (cumDist: number[]) =>
    new TimeSeries({
      name: 'splits',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'mean', kind: 'number', required: false },
      ] as const,
      rows: cumDist.map((d, i) => [i * 1000, d, 10 + i]) as never,
    }).byValue('cumDist');

  it('derives a contiguous neighbour-spacing span on the value axis', () => {
    const bs = barsFromValueSeries(segs([0, 1000, 2000]), 'mean');
    expect(bs.length).toBe(3);
    // each bar reaches halfway to each neighbour; ends mirror the lone gap
    expect(Array.from(bs.begin)).toEqual([-500, 500, 1500]);
    expect(Array.from(bs.end)).toEqual([500, 1500, 2500]);
    // contiguous: end[i] === begin[i+1]
    expect(bs.end[0]).toBe(bs.begin[1]);
    expect(bs.end[1]).toBe(bs.begin[2]);
    expect(Array.from(bs.y)).toEqual([10, 11, 12]);
  });

  it('handles irregular spacing (half-gap each side, still contiguous)', () => {
    const bs = barsFromValueSeries(segs([0, 1000, 3000]), 'mean');
    expect(Array.from(bs.begin)).toEqual([-500, 500, 2000]);
    expect(Array.from(bs.end)).toEqual([500, 2000, 4000]);
    expect(bs.end[1]).toBe(bs.begin[2]); // still tiles
  });

  it('gives a lone point zero width (falls back to renderer minWidth)', () => {
    const bs = barsFromValueSeries(segs([500]), 'mean');
    expect(bs.length).toBe(1);
    expect(bs.begin[0]).toBe(500);
    expect(bs.end[0]).toBe(500);
  });

  it('represents a missing value as NaN (the gap signal — no bar)', () => {
    const s = new TimeSeries({
      name: 'splits',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'mean', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 0, 10],
        [1000, 1000, undefined],
        [2000, 2000, 12],
      ] as never,
    }).byValue('cumDist');
    const bs = barsFromValueSeries(s, 'mean');
    expect(bs.y[0]).toBe(10);
    expect(Number.isNaN(bs.y[1]!)).toBe(true);
    expect(bs.y[2]).toBe(12);
    // a gap value still gets a span (the renderer skips the bar, not the slot)
    expect(bs.begin[1]).toBe(500);
    expect(bs.end[1]).toBe(1500);
  });

  it('throws on an unknown column', () => {
    expect(() => barsFromValueSeries(segs([0, 1000]), 'nope')).toThrow(
      /unknown column/,
    );
  });

  it('throws on a non-numeric column', () => {
    const s = new TimeSeries({
      name: 'splits',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'label', kind: 'string' },
      ] as const,
      rows: [[0, 0, 'a']],
    }).byValue('cumDist');
    expect(() => barsFromValueSeries(s, 'label')).toThrow(/must be numeric/);
  });
});

describe('boxFromTimeSeries — key-shape aware', () => {
  const full = {
    lower: 'p5',
    q1: 'p25',
    median: 'p50',
    q3: 'p75',
    upper: 'p95',
  };

  it('an interval-keyed series uses the key span, all five columns present', () => {
    // A timeRange key carries a real [begin, end) — the box's own width.
    const s = new TimeSeries({
      name: 'q',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'p5', kind: 'number' },
        { name: 'p25', kind: 'number' },
        { name: 'p50', kind: 'number' },
        { name: 'p75', kind: 'number' },
        { name: 'p95', kind: 'number' },
      ] as const,
      rows: [
        [[0, 10], 1, 2, 3, 4, 5],
        [[10, 20], 1, 2, 3, 4, 5],
      ] as never,
    });
    const b = boxFromTimeSeries(s, full);
    expect(Array.from(b.x)).toEqual([0, 10]);
    expect(Array.from(b.xEnd)).toEqual([10, 20]); // real interval width
    expect(b.hasBox).toBe(true);
    expect(b.hasMedian).toBe(true);
  });

  it('a point-keyed (time) series synthesizes width from neighbour spacing', () => {
    const s = new TimeSeries({
      name: 'q',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'p5', kind: 'number' },
        { name: 'p25', kind: 'number' },
        { name: 'p50', kind: 'number' },
        { name: 'p75', kind: 'number' },
        { name: 'p95', kind: 'number' },
      ] as const,
      rows: [
        [0, 1, 2, 3, 4, 5],
        [10, 1, 2, 3, 4, 5],
        [20, 1, 2, 3, 4, 5],
      ],
    });
    const b = boxFromTimeSeries(s, full);
    // Each box centred on its timestamp, halfway to each neighbour (not collapsed).
    expect(Array.from(b.x)).toEqual([-5, 5, 15]);
    expect(Array.from(b.xEnd)).toEqual([5, 15, 25]);
  });

  it('omitting q1+q3 (and median) builds a range-only box', () => {
    const s = new TimeSeries({
      name: 'q',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'bid', kind: 'number' },
        { name: 'ask', kind: 'number' },
      ] as const,
      rows: [
        [0, 1, 5],
        [10, 2, 6],
      ],
    });
    const b = boxFromTimeSeries(s, { lower: 'bid', upper: 'ask' });
    expect(b.hasBox).toBe(false);
    expect(b.hasMedian).toBe(false);
    expect(Array.from(b.lower)).toEqual([1, 2]);
    expect(Array.from(b.upper)).toEqual([5, 6]);
    // absent quantiles read as all-NaN buffers (not confused with a gap)
    expect(b.q1.every((v) => Number.isNaN(v))).toBe(true);
    expect(b.median.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('throws when exactly one of q1/q3 is given', () => {
    const s = new TimeSeries({
      name: 'q',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
        { name: 'b', kind: 'number' },
        { name: 'c', kind: 'number' },
      ] as const,
      rows: [[0, 1, 2, 3]],
    });
    expect(() =>
      boxFromTimeSeries(s, { lower: 'a', q1: 'b', upper: 'c' }),
    ).toThrow(/both-or-neither/);
  });
});

describe('boxFromValueSeries', () => {
  // A vol smile keyed by strike (natively value-keyed, point on the value axis).
  const smile = () =>
    ValueSeries.fromColumns({
      name: 'smile',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'bid', kind: 'number' },
        { name: 'ask', kind: 'number' },
        { name: 'mid', kind: 'number' },
      ] as const,
      columns: {
        strike: [90, 100, 110],
        bid: [0.3, 0.24, 0.28],
        ask: [0.34, 0.28, 0.32],
        mid: [0.32, 0.26, 0.3],
      },
    });

  it('derives a neighbour-spacing span on the value axis (range-only bid/ask)', () => {
    const b = boxFromValueSeries(smile(), { lower: 'bid', upper: 'ask' });
    expect(b.length).toBe(3);
    // strikes 90/100/110 → each box halfway to each neighbour
    expect(Array.from(b.x)).toEqual([85, 95, 105]);
    expect(Array.from(b.xEnd)).toEqual([95, 105, 115]);
    expect(b.hasBox).toBe(false);
    expect(Array.from(b.lower)).toEqual([0.3, 0.24, 0.28]);
    expect(Array.from(b.upper)).toEqual([0.34, 0.28, 0.32]);
  });

  it('carries the median column when given (hasMedian true, still no body)', () => {
    const b = boxFromValueSeries(smile(), {
      lower: 'bid',
      median: 'mid',
      upper: 'ask',
    });
    expect(b.hasBox).toBe(false);
    expect(b.hasMedian).toBe(true);
    expect(Array.from(b.median)).toEqual([0.32, 0.26, 0.3]);
  });
});
