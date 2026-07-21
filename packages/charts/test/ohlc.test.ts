import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { TimeSeries } from 'pond-ts';
import {
  drawCandles,
  isFiniteOhlc,
  ohlcExtent,
  ohlcIndexAtTime,
  resolveCandleStyle,
} from '../src/ohlc.js';
import { ohlcFromTimeSeries } from '../src/data.js';
import { recordingContext } from './canvas-mock.js';
import type { OhlcSeries } from '../src/data.js';
import type { CandleStyle } from '../src/theme.js';

/**
 * Build an {@link OhlcSeries}. `xEnd` defaults to `x` (a point key, end===begin)
 * so a candle collapses to a min-width mark; pass `xEnd` for an interval key with
 * real width.
 */
const oh = (
  x: number[],
  o: { open: number[]; high: number[]; low: number[]; close: number[] },
  xEnd: number[] = x,
): OhlcSeries => ({
  x: Float64Array.from(x),
  xEnd: Float64Array.from(xEnd),
  open: Float64Array.from(o.open),
  high: Float64Array.from(o.high),
  low: Float64Array.from(o.low),
  close: Float64Array.from(o.close),
  length: x.length,
});

const identity = (v: number) => v;
const flipY = (v: number) => 100 - v;

const style: CandleStyle = {
  rising: { body: '#0a0', wick: '#050' },
  falling: { body: '#a00', wick: '#500' },
  neutral: { body: '#888', wick: '#444' },
  bodyWidth: 1, // full slot → predictable body geometry in the draw tests
  wickWidth: 2,
};

/** One rising candle over the interval [10, 30]; O2 H5 L1 C4. */
const rising = () =>
  oh([10], { open: [2], high: [5], low: [1], close: [4] }, [30]);
/** One falling candle over [10, 30]; O4 H5 L1 C2. */
const falling = () =>
  oh([10], { open: [4], high: [5], low: [1], close: [2] }, [30]);

describe('ohlcIndexAtTime', () => {
  // Three contiguous candles spanning [0,10], [10,20], [20,30].
  const cs = oh(
    [0, 10, 20],
    {
      open: [1, 1, 1],
      high: [2, 2, 2],
      low: [0, 0, 0],
      close: [1.5, 1.5, 1.5],
    },
    [10, 20, 30],
  );

  it('returns the candle whose slot contains the time', () => {
    expect(ohlcIndexAtTime(cs, 5)).toBe(0);
    expect(ohlcIndexAtTime(cs, 15)).toBe(1);
    expect(ohlcIndexAtTime(cs, 25)).toBe(2);
  });

  it('stays on the same candle past its midpoint (not nearest-by-begin)', () => {
    expect(ohlcIndexAtTime(cs, 18)).toBe(1);
  });

  it('returns the left candle at a shared edge, and -1 outside every candle', () => {
    expect(ohlcIndexAtTime(cs, 10)).toBe(0);
    expect(ohlcIndexAtTime(cs, -1)).toBe(-1);
    expect(ohlcIndexAtTime(cs, 31)).toBe(-1);
  });
});

describe('ohlcExtent', () => {
  it('returns [min low, max high] over finite candles', () => {
    const cs = oh([0, 1], {
      open: [2, 3],
      high: [5, 9],
      low: [1, 0],
      close: [4, 6],
    });
    // min low over keys = 0; max high = 9.
    expect(ohlcExtent(cs)).toEqual([0, 9]);
  });

  it('excludes a gap candle (any price NaN) from the extent', () => {
    const cs = oh([0, 1], {
      open: [2, 3],
      high: [5, 99],
      low: [1, 0],
      close: [4, NaN], // key 1 has a NaN close → not drawn
    });
    expect(ohlcExtent(cs)).toEqual([1, 5]);
  });

  it('returns null when no candle has all four prices finite', () => {
    const cs = oh([0], { open: [NaN], high: [5], low: [1], close: [4] });
    expect(ohlcExtent(cs)).toBeNull();
  });
});

describe('isFiniteOhlc', () => {
  it('is true only when all four prices are finite', () => {
    const cs = oh([0, 1], {
      open: [1, NaN],
      high: [2, 2],
      low: [0, 0],
      close: [1, 1],
    });
    expect(isFiniteOhlc(cs, 0)).toBe(true);
    expect(isFiniteOhlc(cs, 1)).toBe(false);
  });
});

describe('resolveCandleStyle', () => {
  it('direction: rising when close > open, falling when close < open', () => {
    expect(resolveCandleStyle(style, 2, 4, 'direction')).toEqual(style.rising);
    expect(resolveCandleStyle(style, 4, 2, 'direction')).toEqual(style.falling);
  });

  it('direction: a doji (open === close) uses neutral', () => {
    expect(resolveCandleStyle(style, 3, 3, 'direction')).toEqual(style.neutral);
  });

  it('direction: a doji falls back to rising when neutral is unset', () => {
    const { neutral: _drop, ...noNeutral } = style;
    void _drop;
    expect(resolveCandleStyle(noNeutral, 3, 3, 'direction')).toEqual(
      style.rising,
    );
  });

  it('series: always rising, even for a falling candle', () => {
    expect(resolveCandleStyle(style, 4, 2, 'series')).toEqual(style.rising);
  });
});

describe('drawCandles — candle variant', () => {
  it('draws the high–low wick, then the open→close body, in that order', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, rising(), identity, flipY, style);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual([
      'beginPath',
      'moveTo', // wick top (high)
      'lineTo', // wick bottom (low)
      'stroke',
      'fillRect', // body
    ]);
  });

  it('places the wick at the slot centre from high to low', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, rising(), identity, flipY, style);
    // slot [10,30] → mid=20. high=5→95, low=1→99.
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([20, 95]);
    expect(calls.find((c) => c.name === 'lineTo')?.args).toEqual([20, 99]);
  });

  it('draws the body across the open→close extent (bodyWidth=1 → full slot)', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, rising(), identity, flipY, style);
    // open=2→98, close=4→96 → top=96, height=2; body x0=10, width=20.
    expect(calls.find((c) => c.name === 'fillRect')?.args).toEqual([
      10, 96, 20, 2,
    ]);
  });

  it('colours a rising candle with the rising body, a falling one with falling', () => {
    const up = recordingContext();
    drawCandles(up.ctx, rising(), identity, flipY, style);
    expect(
      up.calls.some((c) => c.name === 'fillStyle' && c.args[0] === '#0a0'),
    ).toBe(true);
    expect(
      up.calls.some((c) => c.name === 'strokeStyle' && c.args[0] === '#050'),
    ).toBe(true);

    const down = recordingContext();
    drawCandles(down.ctx, falling(), identity, flipY, style);
    expect(
      down.calls.some((c) => c.name === 'fillStyle' && c.args[0] === '#a00'),
    ).toBe(true);
  });

  it("colorBy='series' draws a falling candle in the rising colour", () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, falling(), identity, flipY, style, 'candle', 'series');
    expect(
      calls.some((c) => c.name === 'fillStyle' && c.args[0] === '#0a0'),
    ).toBe(true);
    expect(
      calls.some((c) => c.name === 'fillStyle' && c.args[0] === '#a00'),
    ).toBe(false);
  });

  it('gives a doji (open === close) a minimum 1px body so it stays visible', () => {
    const { ctx, calls } = recordingContext();
    const doji = oh([10], { open: [3], high: [5], low: [1], close: [3] }, [30]);
    drawCandles(ctx, doji, identity, flipY, style);
    const rect = calls.find((c) => c.name === 'fillRect');
    // open=close=3 → zero height clamped to 1px, centred on y=97.
    expect(rect?.args[3]).toBe(1);
    expect(rect?.args[1]).toBeCloseTo(96.5);
    // doji uses the neutral colour.
    expect(
      calls.some((c) => c.name === 'fillStyle' && c.args[0] === '#888'),
    ).toBe(true);
  });

  it('insets the slot by the gap', () => {
    const { ctx, calls } = recordingContext();
    // slot [10,30] span 20, gap=4 → inset 2 each side → [12,28], mid=20.
    drawCandles(
      ctx,
      rising(),
      identity,
      flipY,
      style,
      'candle',
      'direction',
      4,
    );
    // bodyWidth=1 → body spans the inset slot [12,28] → x0=12, width=16.
    expect(calls.find((c) => c.name === 'fillRect')?.args).toEqual([
      12, 96, 16, 2,
    ]);
    // wick still at the slot centre 20.
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([20, 95]);
  });

  it('skips a gap candle entirely — no partial mark', () => {
    const { ctx, calls } = recordingContext();
    const cs = oh(
      [0, 10],
      { open: [1, 2], high: [NaN, 5], low: [0, 1], close: [1, 4] },
      [5, 15],
    );
    drawCandles(ctx, cs, identity, flipY, style);
    // Exactly one candle drawn (key 1).
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(1);
  });

  it('draws nothing when every candle is a gap', () => {
    const { ctx, calls } = recordingContext();
    const cs = oh([0, 1], {
      open: [NaN, NaN],
      high: [NaN, NaN],
      low: [NaN, NaN],
      close: [NaN, NaN],
    });
    drawCandles(ctx, cs, identity, flipY, style);
    expect(calls).toEqual([]);
  });
});

describe('drawCandles — bar variant', () => {
  it('draws a stem + open/close ticks and no filled body', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, rising(), identity, flipY, style, 'bar');
    // 3 segments: stem + left(open) tick + right(close) tick.
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(3);
    expect(calls.filter((c) => c.name === 'lineTo')).toHaveLength(3);
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });

  it('points the open tick left and the close tick right of the stem', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, rising(), identity, flipY, style, 'bar');
    const moves = calls.filter((c) => c.name === 'moveTo');
    const lines = calls.filter((c) => c.name === 'lineTo');
    // slot [10,30] → mid=20, bodyHalf=10. open=2→98, close=4→96.
    // stem: (20,95)→(20,99).
    expect(moves[0]?.args).toEqual([20, 95]);
    expect(lines[0]?.args).toEqual([20, 99]);
    // open tick left: (10,98)→(20,98).
    expect(moves[1]?.args).toEqual([10, 98]);
    expect(lines[1]?.args).toEqual([20, 98]);
    // close tick right: (20,96)→(30,96).
    expect(moves[2]?.args).toEqual([20, 96]);
    expect(lines[2]?.args).toEqual([30, 96]);
  });
});

describe('drawCandles — hollow variant', () => {
  it('outlines a rising candle (hollow body, no fill)', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, rising(), identity, flipY, style, 'hollow');
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(0);
  });

  it('fills a falling candle', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, falling(), identity, flipY, style, 'hollow');
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });

  it('fills a doji (open === close) — the strict-> boundary agrees with its neutral colour', () => {
    const { ctx, calls } = recordingContext();
    const doji = oh([10], { open: [3], high: [5], low: [1], close: [3] }, [30]);
    drawCandles(ctx, doji, identity, flipY, style, 'hollow');
    // equality is not "rising", so a doji is filled (not hollow) — matching
    // resolveCandleStyle routing open === close to neutral.
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    expect(
      calls.some((c) => c.name === 'fillStyle' && c.args[0] === '#888'),
    ).toBe(true);
  });
});

describe('ohlcFromTimeSeries', () => {
  const ohlcSchema = [
    { name: 'time', kind: 'time' },
    { name: 'o', kind: 'number' },
    { name: 'h', kind: 'number' },
    { name: 'l', kind: 'number' },
    { name: 'c', kind: 'number' },
  ] as const;
  const cols = { open: 'o', high: 'h', low: 'l', close: 'c' };

  it('derives a neighbour-spacing slot for a point-keyed (raw daily) series', () => {
    const s = new TimeSeries({
      name: 'd',
      schema: ohlcSchema,
      rows: [
        [100, 1, 2, 0, 1.5],
        [200, 1.5, 3, 1, 2],
        [300, 2, 4, 1.5, 3],
      ],
    });
    const cs = ohlcFromTimeSeries(s, cols);
    // Uniform 100-spaced → interior [150,250]; edges mirror their gap.
    expect(Array.from(cs.x)).toEqual([50, 150, 250]);
    expect(Array.from(cs.xEnd)).toEqual([150, 250, 350]);
    expect(Array.from(cs.close)).toEqual([1.5, 2, 3]);
  });

  it('uses the key [begin,end] verbatim for an interval-keyed (aggregate) series', () => {
    const s = new TimeSeries({
      name: 'iv',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'o', kind: 'number' },
        { name: 'h', kind: 'number' },
        { name: 'l', kind: 'number' },
        { name: 'c', kind: 'number' },
      ] as const,
      rows: [
        [['w1', 0, 1000], 1, 2, 0, 1.5],
        [['w2', 1000, 3000], 1.5, 3, 1, 2],
      ],
    });
    const cs = ohlcFromTimeSeries(s, cols);
    expect(Array.from(cs.x)).toEqual([0, 1000]);
    expect(Array.from(cs.xEnd)).toEqual([1000, 3000]);
  });

  it('reads a missing price as NaN (the gap signal)', () => {
    const s = new TimeSeries({
      name: 'd',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'o', kind: 'number' },
        { name: 'h', kind: 'number' },
        { name: 'l', kind: 'number' },
        { name: 'c', kind: 'number', required: false },
      ] as const,
      rows: [
        [100, 1, 2, 0, 1.5],
        [200, 1.5, 3, 1, undefined],
      ] as never,
    });
    const cs = ohlcFromTimeSeries(s, cols);
    expect(Number.isNaN(cs.close[1]!)).toBe(true);
    expect(isFiniteOhlc(cs, 0)).toBe(true);
    expect(isFiniteOhlc(cs, 1)).toBe(false);
  });

  it('throws on an unknown price column', () => {
    const s = new TimeSeries({ name: 'd', schema: ohlcSchema, rows: [] });
    expect(() => ohlcFromTimeSeries(s, { ...cols, open: 'nope' })).toThrow(
      /unknown column/,
    );
  });
});

describe('drawCandles — viewport culling (Phase 2)', () => {
  // A d3-style identity scale carrying `.domain()` so drawCandles culls.
  const scaleWithDomain = (lo: number, hi: number): ((v: number) => number) => {
    const f = (v: number) => v;
    (f as unknown as { domain: () => number[] }).domain = () => [lo, hi];
    return f;
  };
  // 6 contiguous candles: x = 0,10,…,50; xEnd = x + 10.
  const ramp = () =>
    oh(
      [0, 10, 20, 30, 40, 50],
      {
        open: [1, 1, 1, 1, 1, 1],
        high: [3, 3, 3, 3, 3, 3],
        low: [0, 0, 0, 0, 0, 0],
        close: [2, 2, 2, 2, 2, 2],
      },
      [10, 20, 30, 40, 50, 60],
    );

  it('draws only candles whose span overlaps the visible window (+1 each side)', () => {
    const { ctx, calls } = recordingContext();
    // view [22, 38] → spans [20,30] and [30,40] overlap; +1 → [1,5) → 4 candles.
    // Each candle strokes one wick (a single moveTo); count them.
    drawCandles(ctx, ramp(), scaleWithDomain(22, 38), flipY, style);
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(4);
  });

  it('draws all candles when the scale has no domain (test stub)', () => {
    const { ctx, calls } = recordingContext();
    drawCandles(ctx, ramp(), identity, flipY, style);
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(6);
  });
});

describe('drawCandles — M4 decimation (Phase 5)', () => {
  const pxScale = (lo: number, hi: number) =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as (
      v: number,
    ) => number;
  const sizedCtx = (widthPx: number) => {
    const { ctx, calls } = recordingContext();
    (ctx as unknown as { canvas: { width: number } }).canvas = {
      width: widthPx,
    };
    return { ctx, calls };
  };
  // `n` contiguous candles at x = 0..n-1 (xEnd = x+1).
  const dense = (n: number) =>
    oh(
      Array.from({ length: n }, (_, i) => i),
      {
        open: Array.from({ length: n }, () => 1),
        high: Array.from({ length: n }, () => 3),
        low: Array.from({ length: n }, () => 0),
        close: Array.from({ length: n }, () => 2),
      },
      Array.from({ length: n }, (_, i) => i + 1),
    );

  it('decimates dense candles to ~one aggregate candle per column', () => {
    const { ctx, calls } = sizedCtx(10); // W=10
    // 5000 candles → decimate to ≤10 aggregate candles → ≤10 wick moveTos.
    drawCandles(ctx, dense(5000), pxScale(0, 5000), flipY, style);
    expect(calls.filter((c) => c.name === 'moveTo').length).toBeLessThanOrEqual(
      10,
    );
    expect(calls.filter((c) => c.name === 'moveTo').length).toBeGreaterThan(0);
  });

  it('draws every candle when decimate is off', () => {
    const { ctx, calls } = sizedCtx(10);
    drawCandles(
      ctx,
      dense(40),
      pxScale(0, 40),
      flipY,
      style,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    // 40 candles → 40 wicks, not decimated.
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(40);
  });
});
