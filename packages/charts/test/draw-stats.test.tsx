/**
 * Draw-stats observability (PND-DECOBS). Two layers:
 *
 *  1. **Unit** — each decimating draw function returns {@link LayerDrawStats}
 *     (`sourceCount` / `drawnCount` / `decimated`): dense input decimates
 *     (`drawnCount ≪ sourceCount`, `decimated` true); a sparse fully-visible
 *     input draws every point (`drawnCount === sourceCount`, `decimated` false).
 *  2. **Integration** — `<ChartContainer onDrawStats>` fires a
 *     {@link DrawStatsFrame} per repaint, one labelled {@link LayerDrawInfo} per
 *     layer with a measured `drawMs`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { drawLine } from '../src/line.js';
import { drawArea } from '../src/area.js';
import { drawBand } from '../src/band.js';
import { drawCandles } from '../src/ohlc.js';
import { drawBox } from '../src/box.js';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';
import type { Scale } from '../src/line.js';
import type { DrawStatsFrame } from '../src/context.js';
import type {
  ChartSeries,
  BandSeries,
  OhlcSeries,
  BoxSeries,
} from '../src/data.js';

afterEach(cleanup);

/** A real d3 linear scale (domain + range + invert — what decimation reads),
 *  identity-mapped so pixel space == data space. */
const pxScale = (lo: number, hi: number): Scale =>
  scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;

/** A recording ctx with a backing width (device-pixel bucket count) and a
 *  gradient stub (area needs `createLinearGradient().addColorStop`). */
const sizedCtx = (widthPx: number): CanvasRenderingContext2D => {
  const { ctx } = recordingContext();
  (ctx as unknown as { canvas: { width: number } }).canvas = { width: widthPx };
  (
    ctx as unknown as { createLinearGradient: () => CanvasGradient }
  ).createLinearGradient = () =>
    ({ addColorStop: () => {} }) as unknown as CanvasGradient;
  return ctx;
};

const line = (n: number): ChartSeries => ({
  x: Float64Array.from({ length: n }, (_, i) => i),
  y: Float64Array.from({ length: n }, (_, i) => Math.sin(i)),
  length: n,
});
const band = (n: number): BandSeries => ({
  x: Float64Array.from({ length: n }, (_, i) => i),
  lower: Float64Array.from({ length: n }, (_, i) => Math.sin(i) - 1),
  upper: Float64Array.from({ length: n }, (_, i) => Math.sin(i) + 1),
  length: n,
});
const ohlc = (n: number): OhlcSeries => ({
  x: Float64Array.from({ length: n }, (_, i) => i),
  xEnd: Float64Array.from({ length: n }, (_, i) => i + 1),
  open: Float64Array.from({ length: n }, () => 1),
  high: Float64Array.from({ length: n }, () => 3),
  low: Float64Array.from({ length: n }, () => 0),
  close: Float64Array.from({ length: n }, () => 2),
  length: n,
});
const box = (n: number): BoxSeries => ({
  x: Float64Array.from({ length: n }, (_, i) => i),
  xEnd: Float64Array.from({ length: n }, (_, i) => i + 1),
  lower: Float64Array.from({ length: n }, () => 0),
  q1: Float64Array.from({ length: n }, () => 1),
  median: Float64Array.from({ length: n }, () => 2),
  q3: Float64Array.from({ length: n }, () => 3),
  upper: Float64Array.from({ length: n }, () => 4),
  length: n,
});

const lineStyle = { color: '#000', width: 1 };
const areaStyle = { color: '#000', width: 1, fill: '#00f', fillOpacity: 0.3 };
const bandStyle = { fill: '#abc', opacity: 0.2 };
const candleStyle = {
  rising: { body: '#0a0', wick: '#050' },
  falling: { body: '#a00', wick: '#500' },
  neutral: { body: '#888', wick: '#444' },
  bodyWidth: 1,
  wickWidth: 2,
};
const boxStyle = {
  fill: '#abc',
  fillOpacity: 0.3,
  stroke: '#123',
  strokeWidth: 1.5,
  median: '#456',
  medianWidth: 2,
  whisker: '#789',
  whiskerWidth: 1,
};
const id = (v: number) => v;

describe('draw functions report LayerDrawStats', () => {
  const N = 5000;

  it('drawLine: dense decimates, sparse draws every point', () => {
    const dense = drawLine(sizedCtx(10), line(N), pxScale(0, N), id, lineStyle);
    expect(dense.sourceCount).toBe(N);
    expect(dense.decimated).toBe(true);
    expect(dense.drawnCount).toBeLessThan(N);
    expect(dense.drawnCount).toBeGreaterThan(0);

    const sparse = drawLine(
      sizedCtx(800),
      line(3),
      pxScale(0, 2),
      id,
      lineStyle,
    );
    expect(sparse).toEqual({ sourceCount: 3, drawnCount: 3, decimated: false });
  });

  it('drawArea: dense decimates, sparse draws every point', () => {
    const dense = drawArea(
      sizedCtx(10),
      line(N),
      pxScale(0, N),
      id,
      areaStyle,
      0,
    );
    expect(dense.sourceCount).toBe(N);
    expect(dense.decimated).toBe(true);
    expect(dense.drawnCount).toBeLessThan(N);

    const sparse = drawArea(
      sizedCtx(800),
      line(3),
      pxScale(0, 2),
      id,
      areaStyle,
      0,
    );
    expect(sparse).toEqual({ sourceCount: 3, drawnCount: 3, decimated: false });
  });

  it('drawBand: dense decimates, sparse draws every point', () => {
    const dense = drawBand(sizedCtx(10), band(N), pxScale(0, N), id, bandStyle);
    expect(dense.sourceCount).toBe(N);
    expect(dense.decimated).toBe(true);
    expect(dense.drawnCount).toBeLessThan(N);

    const sparse = drawBand(
      sizedCtx(800),
      band(3),
      pxScale(0, 2),
      id,
      bandStyle,
    );
    expect(sparse).toEqual({ sourceCount: 3, drawnCount: 3, decimated: false });
  });

  it('drawCandles: dense decimates, sparse draws every candle', () => {
    const dense = drawCandles(
      sizedCtx(10),
      ohlc(N),
      pxScale(0, N),
      id,
      candleStyle,
    );
    expect(dense.sourceCount).toBe(N);
    expect(dense.decimated).toBe(true);
    expect(dense.drawnCount).toBeLessThan(N);

    const sparse = drawCandles(
      sizedCtx(800),
      ohlc(3),
      pxScale(0, 3),
      id,
      candleStyle,
    );
    expect(sparse).toEqual({ sourceCount: 3, drawnCount: 3, decimated: false });
  });

  it('drawBox: dense decimates, sparse draws every box', () => {
    const dense = drawBox(sizedCtx(10), box(N), pxScale(0, N), id, boxStyle);
    expect(dense.sourceCount).toBe(N);
    expect(dense.decimated).toBe(true);
    expect(dense.drawnCount).toBeLessThan(N);

    const sparse = drawBox(sizedCtx(800), box(3), pxScale(0, 3), id, boxStyle);
    expect(sparse).toEqual({ sourceCount: 3, drawnCount: 3, decimated: false });
  });
});

describe('<ChartContainer onDrawStats>', () => {
  const series = () =>
    new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 400 }, (_, i) => [i, Math.sin(i)]) as Array<
        [number, number]
      >,
    });

  it('fires a DrawStatsFrame per repaint with a labelled line per layer', () => {
    const stub = stubCanvasContext();
    const frames: DrawStatsFrame[] = [];
    try {
      act(() => {
        render(
          <ChartContainer
            range={[0, 399]}
            width={640}
            onDrawStats={(f) => frames.push(f)}
          >
            <ChartRow height={120}>
              <YAxis id="a" min={-1} max={1} />
              <Layers>
                <LineChart series={series()} column="v" as="signal" axis="a" />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        );
      });
      expect(frames.length).toBeGreaterThan(0);
      const frame = frames.at(-1)!;
      expect(typeof frame.rowKey).toBe('symbol');
      expect(frame.layers).toHaveLength(1);
      const layer = frame.layers[0]!;
      expect(layer.as).toBe('signal');
      expect(layer.index).toBe(0);
      expect(typeof layer.drawMs).toBe('number');
      expect(layer.drawMs).toBeGreaterThanOrEqual(0);
      expect(layer.sourceCount).toBe(400);
      expect(typeof layer.drawnCount).toBe('number');
      expect(typeof layer.decimated).toBe('boolean');
      expect(frame.totalDrawMs).toBeGreaterThanOrEqual(0);
    } finally {
      stub.restore();
    }
  });

  it('no onDrawStats ⇒ the chart still draws (the zero-overhead path renders)', () => {
    const stub = stubCanvasContext();
    try {
      // WITHOUT onDrawStats, Layers takes the untimed loop — the line must still
      // stroke (the un-instrumented path is behaviour-neutral).
      act(() => {
        render(
          <ChartContainer range={[0, 399]} width={640}>
            <ChartRow height={120}>
              <YAxis id="a" min={-1} max={1} />
              <Layers>
                <LineChart series={series()} column="v" as="signal" axis="a" />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        );
      });
      const strokes = stub.calls.filter((c) => c.name === 'stroke').length;
      const moves = stub.calls.filter(
        (c) => c.name === 'moveTo' || c.name === 'lineTo',
      ).length;
      expect(strokes).toBeGreaterThan(0);
      expect(moves).toBeGreaterThan(0);
    } finally {
      stub.restore();
    }
  });
});
