import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  stacksFromBins,
  stacksFromColumns,
  stacksFromGroups,
  barsFromTimeSeries,
} from '../src/data.js';
import {
  barRect,
  drawStacks,
  segmentRect,
  stackAt,
  stackBinExtent,
  stackValueExtent,
  type StackStyle,
} from '../src/bars.js';
import { recordingContext } from './canvas-mock.js';

const identity = (v: number) => v;

/** A permissive bin record for tests — `byColumn`'s `{ start, end, …aggregates }`. */
type Bin = { start: number; end: number; [column: string]: number };
/** Build a `Bin[]` (a variable, so the reader's param sees no excess-prop error). */
const mk = (...records: Bin[]): Bin[] => records;

/** A wide interval-keyed series: key `[begin,end]` + two numeric columns. */
const wide = () =>
  new TimeSeries({
    name: 'w',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'a', kind: 'number' },
      { name: 'b', kind: 'number' },
    ] as const,
    rows: [
      [[0, 10], 1, 4],
      [[10, 20], 2, 5],
      [[20, 30], 3, 6],
    ] as never,
  });

/** One numeric column, interval-keyed — a single stack group. */
const group = (col: string, vals: number[]) =>
  new TimeSeries({
    name: col,
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: col, kind: 'number' },
    ] as const,
    rows: vals.map((v, i) => [[i * 10, i * 10 + 10], v]) as never,
  });

describe('stacksFromColumns', () => {
  it('reads a wide series into row-major group segments', () => {
    const ss = stacksFromColumns(wide(), ['a', 'b']);
    expect(ss.groups).toEqual(['a', 'b']);
    expect(ss.length).toBe(3);
    expect(Array.from(ss.begin)).toEqual([0, 10, 20]);
    expect(Array.from(ss.end)).toEqual([10, 20, 30]);
    // values[bin*G + g]: bin0 = [a=1, b=4], bin1 = [2, 5], bin2 = [3, 6].
    expect(Array.from(ss.values)).toEqual([1, 4, 2, 5, 3, 6]);
  });
});

describe('stacksFromGroups', () => {
  it('zips a Map of aligned series, groups in insertion order', () => {
    const map = new Map([
      ['web1', group('n', [1, 2, 3])],
      ['web2', group('n', [4, 5, 6])],
    ]);
    const ss = stacksFromGroups(map, 'n');
    expect(ss.groups).toEqual(['web1', 'web2']);
    // slots from the first series' key; values row-major per bin.
    expect(Array.from(ss.begin)).toEqual([0, 10, 20]);
    expect(Array.from(ss.values)).toEqual([1, 4, 2, 5, 3, 6]);
  });

  it('aligns groups by bucket key when their grids differ (union, gaps as NaN)', () => {
    // partitionBy().aggregate() gives each group only its own events' range, so
    // grids differ. Group a: buckets [0,10),[10,20); group b: [10,20),[20,30).
    const a = new TimeSeries({
      name: 'a',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'n', kind: 'number' },
      ] as const,
      rows: [
        [[0, 10], 1],
        [[10, 20], 2],
      ] as never,
    });
    const b = new TimeSeries({
      name: 'b',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'n', kind: 'number' },
      ] as const,
      rows: [
        [[10, 20], 5],
        [[20, 30], 6],
      ] as never,
    });
    const ss = stacksFromGroups(
      new Map([
        ['a', a],
        ['b', b],
      ]),
      'n',
    );
    // Union of slots: [0,10),[10,20),[20,30).
    expect(Array.from(ss.begin)).toEqual([0, 10, 20]);
    expect(Array.from(ss.end)).toEqual([10, 20, 30]);
    // Row-major [a,b] per bucket: 0→(1,gap), 10→(2,5), 20→(gap,6).
    const v = Array.from(ss.values);
    expect(v[0]).toBe(1);
    expect(Number.isNaN(v[1]!)).toBe(true);
    expect(v[2]).toBe(2);
    expect(v[3]).toBe(5);
    expect(Number.isNaN(v[4]!)).toBe(true);
    expect(v[5]).toBe(6);
  });

  it('throws on an empty groups map', () => {
    expect(() => stacksFromGroups(new Map(), 'n')).toThrow(/empty/);
  });
});

describe('stacksFromBins', () => {
  const bins: Bin[] = [
    { start: 0, end: 20, seconds: 30 },
    { start: 20, end: 40, seconds: 50 },
    { start: 40, end: 60, seconds: 10 },
  ];

  it('uses the real numeric [start,end] edges by default', () => {
    const ss = stacksFromBins(bins, ['seconds']);
    expect(ss.groups).toEqual(['seconds']);
    expect(Array.from(ss.begin)).toEqual([0, 20, 40]);
    expect(Array.from(ss.end)).toEqual([20, 40, 60]);
    expect(Array.from(ss.values)).toEqual([30, 50, 10]);
  });

  it('lays bins out as uniform unit slots when ordinal', () => {
    const ss = stacksFromBins(bins, ['seconds'], { ordinal: true });
    expect(Array.from(ss.begin)).toEqual([0, 1, 2]);
    expect(Array.from(ss.end)).toEqual([1, 2, 3]);
  });

  it('reads a missing / non-numeric aggregate as a NaN gap', () => {
    const withGap: Bin[] = [
      { start: 0, end: 20, seconds: 30 },
      { start: 20, end: 40 }, // seconds missing
    ];
    const ss = stacksFromBins(withGap, ['seconds']);
    expect(ss.values[0]).toBe(30);
    expect(Number.isNaN(ss.values[1]!)).toBe(true);
  });
});

describe('stackValueExtent', () => {
  it('is [0, tallest summed stack]', () => {
    const ss = stacksFromColumns(wide(), ['a', 'b']); // sums 5, 7, 9
    expect(stackValueExtent(ss)).toEqual([0, 9]);
  });

  it('skips gap / negative segments in the total', () => {
    const ss = stacksFromBins(mk({ start: 0, end: 1, x: 5, y: -3 }), [
      'x',
      'y',
    ]);
    expect(stackValueExtent(ss)).toEqual([0, 5]);
  });

  it('returns [0, 1] for an all-gap / empty series', () => {
    const ss = stacksFromBins([], ['x']);
    expect(stackValueExtent(ss)).toEqual([0, 1]);
  });
});

describe('stackBinExtent', () => {
  it('spans the first begin to the last end', () => {
    const ss = stacksFromColumns(wide(), ['a']);
    expect(stackBinExtent(ss)).toEqual([0, 30]);
  });

  it('returns null for an empty series', () => {
    expect(stackBinExtent(stacksFromBins([], ['x']))).toBeNull();
  });
});

describe('segmentRect', () => {
  // one bin [0,2] with two segments [10, 20], identity scales, no gap/minWidth.
  const ss = stacksFromBins(mk({ start: 0, end: 2, a: 10, b: 20 }), ['a', 'b']);

  it('stacks vertically: value → y, cumulative from the baseline', () => {
    // seg0 rests on 0 → [x0,x1, 0, 10]; seg1 rests on 10 → [x0,x1, 10, 30].
    expect(
      segmentRect(ss, 0, 0, 'vertical', identity, identity, 0, 0, 1),
    ).toEqual([0, 2, 0, 10]);
    expect(
      segmentRect(ss, 0, 1, 'vertical', identity, identity, 10, 0, 1),
    ).toEqual([0, 2, 10, 30]);
  });

  it('stacks horizontally: value → x, bin span → y', () => {
    // seg0 → x[0,10], y = the bin span [0,2]; seg1 → x[10,30].
    expect(
      segmentRect(ss, 0, 0, 'horizontal', identity, identity, 0, 0, 1),
    ).toEqual([0, 10, 0, 2]);
    expect(
      segmentRect(ss, 0, 1, 'horizontal', identity, identity, 10, 0, 1),
    ).toEqual([10, 30, 0, 2]);
  });

  it('returns null for a gap / negative / zero segment', () => {
    const g = stacksFromBins(mk({ start: 0, end: 2, a: NaN, b: -1, c: 0 }), [
      'a',
      'b',
      'c',
    ]);
    // NaN, negative, and zero all skip — a zero segment would draw a wasted
    // zero-extent rect and can't be hit-tested.
    expect(
      segmentRect(g, 0, 0, 'vertical', identity, identity, 0, 0, 1),
    ).toBeNull();
    expect(
      segmentRect(g, 0, 1, 'vertical', identity, identity, 0, 0, 1),
    ).toBeNull();
    expect(
      segmentRect(g, 0, 2, 'vertical', identity, identity, 0, 0, 1),
    ).toBeNull();
  });

  it('anchors the stack baseline at value 0, not at the axis floor', () => {
    // The stack is cumulative from 0. Even a value scale whose domain excludes 0
    // (an explicit <YAxis min> above 0) keeps the bottom segment resting on
    // scale(0) — so with min>0 the bottom is clipped at the plot floor, it does
    // not silently rest on the floor the way a single bar does. This pins the
    // documented "a stacked value axis must include 0" behaviour.
    const ss2 = stacksFromBins(mk({ start: 0, end: 2, a: 10, b: 20 }), [
      'a',
      'b',
    ]);
    const scale = (v: number) => 100 - v; // scale(0) = 100 (below a min>0 plot)
    const seg0 = segmentRect(ss2, 0, 0, 'vertical', identity, scale, 0, 0, 1);
    expect(seg0?.[3]).toBe(100); // yBottom = scale(0) — value 0, the baseline
    expect(seg0?.[2]).toBe(90); // yTop = scale(10)
  });
});

describe('stackAt', () => {
  const ss = stacksFromBins(mk({ start: 0, end: 2, a: 10, b: 20 }), ['a', 'b']);

  it('picks the segment under the point (vertical)', () => {
    // y in [0,10] → seg a; y in [10,30] → seg b.
    expect(stackAt(ss, 1, 5, 'vertical', identity, identity, 0, 1)).toEqual([
      0,
      0,
      0,
      'a',
      10,
    ]);
    expect(stackAt(ss, 1, 15, 'vertical', identity, identity, 0, 1)).toEqual([
      0,
      1,
      0,
      'b',
      20,
    ]);
  });

  it('picks the segment under the point (horizontal)', () => {
    // x in [0,10] → seg a; x in [10,30] → seg b; y within the bin span [0,2].
    expect(stackAt(ss, 5, 1, 'horizontal', identity, identity, 0, 1)).toEqual([
      0,
      0,
      0,
      'a',
      10,
    ]);
    expect(stackAt(ss, 20, 1, 'horizontal', identity, identity, 0, 1)).toEqual([
      0,
      1,
      0,
      'b',
      20,
    ]);
  });

  it('misses outside every segment', () => {
    expect(stackAt(ss, 1, 40, 'vertical', identity, identity, 0, 1)).toBeNull();
  });
});

const stackStyle = (fills: string[]): StackStyle => ({
  fills,
  opacity: 0.85,
  outlineWidth: 2,
});

describe('drawStacks', () => {
  const ss = stacksFromBins(
    mk(
      { start: 0, end: 2, a: 10, b: 20 },
      { start: 2, end: 4, a: 5, b: NaN }, // b is a gap in the second bin
    ),
    ['a', 'b'],
  );

  it('fills one rect per finite segment, skipping gaps', () => {
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      stackStyle(['#a00', '#0a0']),
      0,
      1,
      'h',
      null,
      null,
    );
    // 3 finite segments (bin0 a+b, bin1 a); the NaN segment is skipped.
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(3);
    const names = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
  });

  it('outlines the segment matching id + key + group', () => {
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      stackStyle(['#a00', '#0a0']),
      0,
      1,
      'h',
      { id: 'h', key: 0, label: 'b' }, // bin0 (begin 0), group b
      null,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    // the outline strokes in the group's own colour.
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#0a0')).toBe(
      true,
    );
  });

  it('does not outline a hovered segment (fill pop only)', () => {
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      stackStyle(['#a00', '#0a0']),
      0,
      1,
      'h',
      null,
      { id: 'h', key: 0, label: 'a' },
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    // the hovered segment pops to full opacity.
    expect(
      calls.some(
        (c) => c.type === 'set' && c.name === 'globalAlpha' && c.args[0] === 1,
      ),
    ).toBe(true);
  });

  it('never highlights when the layer has no id (display-only)', () => {
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      stackStyle(['#a00', '#0a0']),
      0,
      1,
      undefined,
      { id: 'h', key: 0, label: 'a' },
      { id: 'h', key: 0, label: 'a' },
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });
});

describe('single-series regression pin (G=1 vertical == drawBars geometry)', () => {
  it('segmentRect matches barRect for a positive series resting on 0', () => {
    const s = group('v', [30, 50, 20]);
    const bs = barsFromTimeSeries(s, 'v');
    const ss = stacksFromColumns(s, ['v']);
    for (let i = 0; i < bs.length; i += 1) {
      const bar = barRect(bs, i, identity, identity, 0, 0, 1);
      const seg = segmentRect(
        ss,
        i,
        0,
        'vertical',
        identity,
        identity,
        0,
        0,
        1,
      );
      expect(seg).toEqual(bar);
    }
  });
});
