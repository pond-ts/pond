/**
 * **`RowLayer.sweepsRect` and `SweepSession.twoD` are one fact stated twice**
 * — the layer declares it so the RESTING cursor can ask without building a
 * per-drag session, the session reports it so the gesture can ask mid-drag.
 * Two declarations invite drift, so the first half of this file pins their
 * agreement across every sweep-capable layer, and it does so by *building the
 * session* rather than by reading the flag back.
 *
 * The second half is what the fact buys: a row whose sweep cuts a rect gets a
 * small crosshair at rest, a row whose sweep cuts a band gets the band.
 */
import { useContext, useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { Candlestick } from '../src/Candlestick.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { HeatMap } from '../src/HeatMap.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { MultiSelector } from '../src/selectors.js';
import { RowContext, type RowFrame } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const T = (i: number) => i * 1000;

const bars = () =>
  new TimeSeries({
    name: 'b',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [[T(i), T(i + 1)], i + 1]) as [
      [number, number],
      number,
    ][],
  });

const points = () =>
  new TimeSeries({
    name: 'p',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [T(i), i + 1]) as [
      number,
      number,
    ][],
  });

const grid = () =>
  new TimeSeries({
    name: 'g',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'lo', kind: 'number' },
      { name: 'hi', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [
      [T(i), T(i + 1)],
      i + 1,
      i + 2,
    ]) as [[number, number], number, number][],
  });

const ohlc = () =>
  new TimeSeries({
    name: 'c',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'open', kind: 'number' },
      { name: 'high', kind: 'number' },
      { name: 'low', kind: 'number' },
      { name: 'close', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [
      T(i),
      i + 1,
      i + 3,
      i,
      i + 2,
    ]) as [number, number, number, number, number][],
  });

const boxes = () =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'lower', kind: 'number' },
      { name: 'median', kind: 'number' },
      { name: 'upper', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [
      [T(i), T(i + 1)],
      i,
      i + 2,
      i + 4,
    ]) as [[number, number], number, number, number][],
  });

/** Mount `layers` in a row and hand back the registered `RowFrame` plus the
 *  rendered DOM. */
function mountRow(layers: ReactNode, extra?: ReactNode) {
  let rf: RowFrame | null = null;
  function Capture() {
    const r = useContext(RowContext);
    useEffect(() => {
      if (r) rf = r;
    });
    return null;
  }
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    dom = render(
      <ChartContainer range={[0, 5000]} width={320}>
        {extra}
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            {layers}
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;
  } finally {
    stub.restore();
  }
  return { frame: () => rf!, dom };
}

describe('`sweepsRect` agrees with the session every layer builds', () => {
  const CASES: Array<[string, ReactNode, boolean]> = [
    [
      'BarChart',
      <BarChart series={bars()} column="v" axis="a" id="s" />,
      false,
    ],
    [
      'BoxPlot',
      <BoxPlot
        series={boxes()}
        lower="lower"
        median="median"
        upper="upper"
        axis="a"
        id="s"
      />,
      false,
    ],
    ['Candlestick', <Candlestick series={ohlc()} axis="a" id="s" />, false],
    [
      'ScatterChart',
      <ScatterChart series={points()} column="v" axis="a" id="s" />,
      true,
    ],
    [
      'HeatMap',
      <HeatMap
        series={grid()}
        columns={['lo', 'hi']}
        colors={['#eee', '#999']}
        axis="a"
        id="s"
      />,
      true,
    ],
  ];

  it.each(CASES)('%s', (_name, node, rect) => {
    const { frame } = mountRow(node);
    const entry = frame().layers.at(-1)!;
    const ys = frame().yScales.get('a')!;
    expect(entry.layer.beginSweep).toBeDefined();
    // Build the real session and read `twoD` off IT — reading the flag back
    // would make this test agree with itself.
    const session = entry.layer.beginSweep!(
      (v: number) => v,
      (v: number) => ys(v),
    );
    expect(session).not.toBeNull();
    expect(session!.twoD === true).toBe(rect);
    expect(entry.layer.sweepsRect === true).toBe(rect);
  });

  it('a layer with no sweep at all declares neither', () => {
    // `<LineChart>` has no discrete marks, so it never sweeps — and must not
    // claim a rect by omission being read as anything but "no".
    const { frame } = mountRow(
      <LineChart series={points()} column="v" axis="a" />,
    );
    const entry = frame().layers.at(-1)!;
    expect(
      entry.layer.beginSweep?.(
        (v: number) => v,
        (v: number) => v,
      ),
    ).toBe(undefined);
    expect(entry.layer.sweepsRect).toBeUndefined();
  });
});

describe('the resting brush takes its shape from the row', () => {
  /** Every `<line>` in the plot SVG, as `x1,y1→x2,y2`. */
  const lines = (dom: HTMLElement) =>
    Array.from(dom.querySelectorAll('svg line')).map(
      (l) =>
        `${l.getAttribute('x1')},${l.getAttribute('y1')}→${l.getAttribute('x2')},${l.getAttribute('y2')}`,
    );
  const move = (surface: HTMLElement, x: number, y: number) =>
    act(() => {
      surface.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons: 0,
          pointerId: 1,
        }),
      );
    });
  const hover = (dom: HTMLElement, x: number, y: number) =>
    move(dom.querySelector('canvas')!.parentElement!, x, y);

  it('a rect-sweeping row rests as a SMALL cross, not a full-plot rule', () => {
    const { dom } = mountRow(
      <ScatterChart series={points()} column="v" axis="a" id="s" />,
      <MultiSelector />,
    );
    hover(dom, 60, 40);
    const drawn = lines(dom);
    expect(drawn).toHaveLength(2); // one horizontal arm, one vertical
    // Small is the whole design decision (`ResolvedCursorFrame.restingCross`):
    // every arm is a handful of pixels, and neither spans the 120px row nor
    // the plot's width.
    for (const l of drawn) {
      const [a, b] = l.split('→').map((p) => p.split(',').map(Number));
      expect(Math.abs(a![0]! - b![0]!)).toBeLessThan(20);
      expect(Math.abs(a![1]! - b![1]!)).toBeLessThan(20);
    }
  });

  it('a band-sweeping row rests as the band, and draws no cross', () => {
    const { dom } = mountRow(
      <BarChart series={bars()} column="v" axis="a" id="s" />,
      <MultiSelector />,
    );
    hover(dom, 60, 40);
    expect(lines(dom)).toHaveLength(0);
    // The band is a full-height rect over the snap block under the pointer.
    const band = Array.from(dom.querySelectorAll('svg rect')).filter(
      (r) => Number(r.getAttribute('height')) === 120,
    );
    expect(band.length).toBeGreaterThan(0);
  });

  it('no <MultiSelector>, no cross — the row keeps its ordinary cursor', () => {
    // The brush is the selector's RESTING state, so without one mounted the
    // row keeps the implicit line it always had. Worth pinning as the pair to
    // the case above: the cross *replaces* that line rather than joining it.
    const { dom } = mountRow(
      <ScatterChart series={points()} column="v" axis="a" id="s" />,
    );
    hover(dom, 60, 40);
    expect(lines(dom)).toEqual(['60,0→60,120']); // one full-height rule
  });

  it('the cross draws only in the row under the pointer', () => {
    // `restingCross` is resolved per row but `cursorX` is shared, so a second
    // row would happily draw a cross at a y it never measured.
    let dom: HTMLElement;
    const stub = stubCanvasContext();
    try {
      dom = render(
        <ChartContainer range={[0, 5000]} width={320}>
          <MultiSelector />
          <ChartRow height={120}>
            <YAxis id="a" min={0} max={10} />
            <Layers>
              <ScatterChart series={points()} column="v" axis="a" id="s1" />
            </Layers>
          </ChartRow>
          <ChartRow height={120}>
            <YAxis id="b" min={0} max={10} />
            <Layers>
              <ScatterChart series={points()} column="v" axis="b" id="s2" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ).container;
    } finally {
      stub.restore();
    }
    const surfaces = Array.from(dom.querySelectorAll('canvas')).map(
      (c) => c.parentElement!,
    );
    move(surfaces[0]!, 60, 40);
    expect(lines(dom)).toHaveLength(2); // one cross, in one row
  });
});
