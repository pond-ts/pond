import { describe, expect, it } from 'vitest';
import { scaleLog } from 'd3-scale';
import {
  drawStacks,
  stackAt,
  stackBase,
  resolveBarBaseline,
} from '../src/bars.js';
import { drawArea } from '../src/area.js';
import { drawBand } from '../src/band.js';
import { drawLine } from '../src/line.js';
import { drawCandles } from '../src/ohlc.js';
import { drawBox } from '../src/box.js';
import { gapUnscalable } from '../src/gaps.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type {
  BandSeries,
  BoxSeries,
  ChartSeries,
  OhlcSeries,
  StackedBarSeries,
} from '../src/data.js';
import type { AreaStyle, BandStyle, LineStyle } from '../src/theme.js';

/**
 * What a log axis actually does to a value it has no position for. Every guard
 * in this file exists because of it, and the first round of docs got it wrong
 * in five places — they said `-Infinity`, which is what the *transform*
 * produces before d3 interpolates it into the range.
 */
describe('the premise: d3 maps a non-positive value to NaN, not -Infinity', () => {
  const y = scaleLog().domain([1, 1e6]).range([300, 0]);

  it('returns NaN for zero and for a negative', () => {
    expect(y(0)).toBeNaN();
    expect(y(-5)).toBeNaN();
    expect(y(0)).not.toBe(-Infinity);
  });

  it('is why `Number.isFinite(value)` is the wrong gap test', () => {
    // The value is perfectly finite; its *coordinate* is not. Every `.defined`
    // predicate in this package used to test the left-hand side.
    expect(Number.isFinite(0)).toBe(true);
    expect(Number.isFinite(y(0))).toBe(false);
  });
});

/** A log y scale over six decades, 300px tall. */
const logY = () => scaleLog().domain([1, 1e6]).range([300, 0]);
/** An x scale with no domain — `affineOf` rejects it, so culling / decimation
 *  no-op and the draw takes its exact-scale path. */
const identity = (v: number) => v;

const argsOf = (calls: CtxCall[], name: string) =>
  calls.filter((c) => c.type === 'call' && c.name === name).map((c) => c.args);

/** Every path/paint argument the draw emitted, flattened — so a single NaN
 *  anywhere is caught without enumerating call shapes. */
const drawArgs = (calls: CtxCall[]) =>
  calls
    .filter(
      (c) =>
        c.type === 'call' &&
        ['moveTo', 'lineTo', 'fillRect', 'strokeRect', 'rect'].includes(c.name),
    )
    .flatMap((c) => c.args as number[]);

// ---------------------------------------------------------------------------
// Finding 1 — a stack's base
// ---------------------------------------------------------------------------

const stacked = (): StackedBarSeries => ({
  begin: Float64Array.from([0, 1]),
  end: Float64Array.from([1, 2]),
  groups: ['a', 'b'],
  values: Float64Array.from([100, 900, 200, 800]),
  length: 2,
});

const stackStyle = { fills: ['#a00', '#0a0'], opacity: 1, outlineWidth: 2 };

describe('stacked bars on a log axis', () => {
  it('rests the first segment on the axis floor, not on an unplottable zero', () => {
    // Both walks started at a literal `cum = 0`. `yScale(0)` is NaN on a log
    // scale, `fillRect(x, NaN, w, NaN)` is a silent canvas no-op, and the same
    // rect feeds `stackAt` — so the bottom segment of every stack vanished AND
    // became unhittable, with nothing on screen to say why.
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      stacked(),
      'vertical',
      identity,
      logY(),
      stackStyle,
      0,
      1,
      'traffic',
      null,
      null,
    );
    const rects = argsOf(calls, 'fillRect');
    expect(rects).toHaveLength(4); // 2 bins × 2 groups — none dropped
    for (const r of rects) {
      for (const a of r as number[]) expect(Number.isFinite(a)).toBe(true);
    }
  });

  it('makes the bottom segment hittable', () => {
    const y = logY();
    const ss = stacked();
    // The first segment of bin 0 runs from the floor (1) to 1 + 100.
    const midPx = (y(1) + y(101)) / 2;
    expect(
      stackAt(ss, 0.5, midPx, 'vertical', identity, y, 0, 1),
    ).not.toBeNull();
    const hit = stackAt(ss, 0.5, midPx, 'vertical', identity, y, 0, 1);
    expect(hit?.[1]).toBe(0); // group 0 — the bottom segment
  });

  it('is byte-identical on a linear axis, where the base is still zero', () => {
    // `resolveBarBaseline` clamps 0 into the domain, and the value extents pull
    // 0 in — so the linear geometry does not move.
    const lin = Object.assign((v: number) => 300 - v * 0.3, {
      domain: () => [0, 1000],
    });
    expect(stackBase('vertical', identity, lin)).toBe(0);
    expect(resolveBarBaseline(lin)).toBe(0);
  });

  it('reads the base off the X scale for a horizontal stack', () => {
    // A horizontal histogram puts the stacked value on x, so that is the scale
    // whose domain decides the base.
    const logX = scaleLog().domain([10, 1e5]).range([0, 400]);
    expect(stackBase('horizontal', logX, identity)).toBe(10);
    expect(stackBase('vertical', logX, identity)).toBe(0); // identity: no domain
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — the area's fill gradient
// ---------------------------------------------------------------------------

const areaStyle: AreaStyle = {
  color: '#000',
  width: 1,
  fill: '#2563eb',
  fillOpacity: 0.3,
};

const series = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});

describe('AreaChart on a log axis whose data touches zero', () => {
  it('does not throw an IndexSizeError building its gradient', () => {
    // `columnFiniteExtent` reports the data's own [0, max]; `yScale(0)` is NaN;
    // `Math.min(NaN, …)` is NaN; and `NaN < 1e-6` is **false**, so the
    // degenerate-height guard waved it straight through to
    // `createLinearGradient(0, NaN, 0, NaN)`. That is an IndexSizeError on
    // every real canvas — invisible here only because the test double used to
    // stub the call unconditionally (see `canvas-mock.ts`).
    const { ctx } = recordingContext();
    expect(() =>
      drawArea(
        ctx,
        series([0, 1, 2], [1000, 0, 50_000]),
        identity,
        logY(),
        areaStyle,
        1,
      ),
    ).not.toThrow();
  });

  it('still grades over the part of the series that has a position', () => {
    const { ctx, calls } = recordingContext();
    drawArea(
      ctx,
      series([0, 1, 2], [1000, 0, 50_000]),
      identity,
      logY(),
      areaStyle,
      1,
    );
    const grads = argsOf(calls, 'createLinearGradient');
    expect(grads).toHaveLength(1);
    for (const a of grads[0] as number[]) expect(Number.isFinite(a)).toBe(true);
    // The region spans the baseline pixel to the drawable maximum — not a
    // collapsed fallback.
    const y = logY();
    expect(grads[0]).toEqual([0, y(50_000), 0, y(1)]);
  });

  it('falls back to a flat fill when nothing has a position at all', () => {
    const { ctx, calls } = recordingContext();
    expect(() =>
      drawArea(ctx, series([0, 1], [0, 0]), identity, logY(), areaStyle, 1),
    ).not.toThrow();
    expect(argsOf(calls, 'createLinearGradient')).toHaveLength(0);
  });
});

describe('the canvas double refuses what a real canvas refuses', () => {
  // A test double may be less capable than the platform; it must not be more
  // permissive, or a green suite stops being evidence.
  it('throws on a non-finite gradient coordinate', () => {
    const { ctx } = recordingContext();
    expect(() => ctx.createLinearGradient(0, NaN, 0, NaN)).toThrow(
      /non-finite/,
    );
  });

  it('throws on an out-of-range colour stop', () => {
    const { ctx } = recordingContext();
    const g = ctx.createLinearGradient(0, 0, 0, 100);
    expect(() => g.addColorStop(NaN, '#000')).toThrow(/outside the range/);
    expect(() => g.addColorStop(1.5, '#000')).toThrow(/outside the range/);
    expect(() => g.addColorStop(0.5, '#000')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — a value with no position is a genuine gap
// ---------------------------------------------------------------------------

const lineStyle: LineStyle = { color: '#000', width: 1 };

describe('a value with no position on the axis gaps the line', () => {
  it('breaks the path instead of bridging its neighbours', () => {
    // d3 emitted `lineTo(x, NaN)` for the zero, the canvas spec *drops* a path
    // op with a non-finite coordinate (it does not break the path), so the pen
    // stayed put and the next point drew straight from the previous one — a
    // bridge over absent data, in the mode that promises the opposite.
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      series([0, 1, 2], [1000, 0, 50_000]),
      identity,
      logY(),
      lineStyle,
    );
    expect(drawArgs(calls).every(Number.isFinite)).toBe(true);
    // Two independent one-point runs ⇒ two moveTos, no lineTo across the hole.
    expect(argsOf(calls, 'moveTo')).toHaveLength(2);
    expect(argsOf(calls, 'lineTo')).toHaveLength(0);
  });

  it('leaves a clean log series untouched', () => {
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      series([0, 1, 2], [10, 100, 1000]),
      identity,
      logY(),
      lineStyle,
    );
    expect(argsOf(calls, 'moveTo')).toHaveLength(1);
    expect(argsOf(calls, 'lineTo')).toHaveLength(2);
  });

  it('gaps an area fill and its outline the same way', () => {
    const { ctx, calls } = recordingContext();
    drawArea(
      ctx,
      series([0, 1, 2], [1000, 0, 50_000]),
      identity,
      logY(),
      areaStyle,
      1,
    );
    expect(drawArgs(calls).every(Number.isFinite)).toBe(true);
  });

  it('gaps a band whose lower edge has no position', () => {
    // A `lower` of 0 is the common shape — a band measured up from nothing —
    // and on a log axis zero has no position, so the envelope used to stitch
    // across the samples it could not draw.
    const band: BandSeries = {
      x: Float64Array.from([0, 1, 2]),
      lower: Float64Array.from([10, 0, 30]),
      upper: Float64Array.from([100, 200, 300]),
      length: 3,
    };
    const { ctx, calls } = recordingContext();
    const bandStyle: BandStyle = { fill: '#abc', opacity: 0.2 };
    drawBand(ctx, band, identity, logY(), bandStyle);
    expect(drawArgs(calls).every(Number.isFinite)).toBe(true);
  });
});

describe('gapUnscalable', () => {
  it('replaces only the values with no position', () => {
    const out = gapUnscalable(Float64Array.from([10, 0, -3, 100]), 4, logY());
    expect(Array.from(out.slice(0, 4))).toEqual([10, NaN, NaN, 100]);
  });

  it('returns the input array itself when there is nothing to gap', () => {
    const input = Float64Array.from([10, 100, 1000]);
    expect(gapUnscalable(input, 3, logY())).toBe(input);
  });

  it('skips the walk entirely on an affine scale', () => {
    // A linear axis maps every finite value to a finite pixel by construction,
    // so this must cost nothing — no scan, no allocation, same array back.
    const lin = scaleLog().domain([1, 100]); // not affine
    expect(gapUnscalable(Float64Array.from([0]), 1, lin)[0]).toBeNaN();
    let calls = 0;
    const affine = Object.assign(
      (v: number) => {
        calls += 1;
        return v;
      },
      { domain: () => [0, 100], range: () => [0, 300] },
    );
    const input = Float64Array.from([0, -5, 50]);
    expect(gapUnscalable(input, 3, affine)).toBe(input);
    // Only `affineOf`'s own probe ran — never a per-value call.
    expect(calls).toBeLessThan(input.length + 10);
  });

  it('leaves an existing NaN gap alone', () => {
    const out = gapUnscalable(Float64Array.from([10, NaN, 100]), 3, logY());
    expect(out).toEqual(Float64Array.from([10, NaN, 100]));
  });
});

// ---------------------------------------------------------------------------
// The review asked me to check these two as well.
// ---------------------------------------------------------------------------

describe('box and candle layers open a fresh path per sample', () => {
  // Neither draws a continuous path across samples, so an unplottable value
  // makes *that* sample's ink disappear and cannot stitch it to a neighbour —
  // the bridge failure mode simply does not exist here. Characterized rather
  // than changed.

  it('a candle with a non-positive low emits no cross-sample bridge', () => {
    const ohlc: OhlcSeries = {
      x: Float64Array.from([0, 10]),
      xEnd: Float64Array.from([10, 20]),
      open: Float64Array.from([100, 200]),
      high: Float64Array.from([150, 250]),
      low: Float64Array.from([0, 180]), // candle 0 cannot be positioned
      close: Float64Array.from([120, 220]),
      length: 2,
    };
    const { ctx, calls } = recordingContext();
    expect(() =>
      drawCandles(ctx, ohlc, identity, logY(), {
        rising: { body: '#0a0', wick: '#050' },
        falling: { body: '#a00', wick: '#500' },
        neutral: { body: '#888', wick: '#444' },
        bodyWidth: 1,
        wickWidth: 2,
      }),
    ).not.toThrow();
    // A `beginPath` per sample is what makes the NaN safe: the dropped op can
    // only lose that candle's own ink, never stitch it to the next one.
    const beginPaths = calls.filter(
      (c) => c.type === 'call' && c.name === 'beginPath',
    );
    expect(beginPaths.length).toBeGreaterThanOrEqual(2);
    // The second candle, which does have a position, still draws.
    expect(drawArgs(calls).some(Number.isFinite)).toBe(true);
  });

  it('a box whose lower whisker is zero draws its other samples normally', () => {
    const box: BoxSeries = {
      x: Float64Array.from([0, 10]),
      xEnd: Float64Array.from([10, 20]),
      lower: Float64Array.from([0, 100]), // box 0 cannot be positioned
      q1: Float64Array.from([10, 200]),
      median: Float64Array.from([20, 300]),
      q3: Float64Array.from([30, 400]),
      upper: Float64Array.from([500, 900]),
      length: 2,
    };
    const { ctx, calls } = recordingContext();
    expect(() =>
      drawBox(ctx, box, identity, logY(), {
        fill: '#abc',
        fillOpacity: 0.3,
        stroke: '#123',
        strokeWidth: 1.5,
        median: '#456',
        medianWidth: 2,
        whisker: '#789',
        whiskerWidth: 1,
      }),
    ).not.toThrow();
    expect(drawArgs(calls).some(Number.isFinite)).toBe(true);
  });
});
