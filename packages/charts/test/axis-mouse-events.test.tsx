/**
 * `onMouseEvent` on `<XAxis>` / `<YAxis>` — mouse events on an axis strip,
 * carrying the **axis value under the pointer**. The part a consumer cannot
 * compute for itself is the pixel→value inverse (the scale lives inside the
 * container), so that is what these pin: the coordinate, its label, and which
 * axis reported it.
 *
 * The geometry the assertions lean on: happy-dom gives every element a
 * zeroed client rect, so a fired `clientX` / `clientY` **is** the strip-local
 * pixel — which is exactly the contract in the real DOM too, where the x strip
 * carries the left gutter as a margin and the y gutter shares the plot's top
 * edge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BarChart } from '../src/BarChart.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import type { AxisMouseEvent } from '../src/axis-events.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const WIDTH = 400;
/** One 50px y gutter, so the plot is 350px wide — the x strip's own width. */
const PLOT = 350;
const RANGE: readonly [number, number] = [0, 1000];

const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
      // A second key the series can be re-keyed onto, for the value-x-axis case.
      { name: 'dist', kind: 'number' },
    ] as const,
    rows: [
      [0, 10, 0],
      [500, 40, 500],
      [1000, 20, 1000],
    ],
  });

const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN'];
const bars = TICKERS.map((label, i) => ({ label, value: 10 + i * 5 }));

function draw(ui: React.ReactElement) {
  const stub = stubCanvasContext();
  try {
    return render(ui);
  } finally {
    stub.restore();
  }
}

const xStrip = (dom: HTMLElement) =>
  dom.querySelector('[data-axis="x"]') as HTMLElement;
const yGutter = (dom: HTMLElement, id: string) =>
  dom.querySelector(`[data-axis-id="${id}"]`) as HTMLElement;

describe('<XAxis onMouseEvent>', () => {
  const mount = (onMouseEvent: (e: AxisMouseEvent) => void) =>
    draw(
      <ChartContainer range={RANGE} width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
        <XAxis onMouseEvent={onMouseEvent} />
      </ChartContainer>,
    ).container;

  it('a click reports the x value under the pointer', () => {
    const seen = vi.fn();
    const dom = mount(seen);

    // Half way across a 350px plot spanning [0, 1000] → 500.
    fireEvent.click(xStrip(dom), { clientX: PLOT / 2 });

    expect(seen).toHaveBeenCalledTimes(1);
    const info = seen.mock.calls[0]![0] as AxisMouseEvent;
    expect(info.axis).toBe('x');
    expect(info.id).toBeUndefined(); // an x axis has no id
    expect(info.value).toBeCloseTo(500, 6);
    expect(info.event.type).toBe('click');
  });

  it('one handler takes every mouse event — `type` discriminates', () => {
    const seen = vi.fn();
    const dom = mount(seen);
    const strip = xStrip(dom);

    fireEvent.mouseEnter(strip, { clientX: 0 });
    fireEvent.mouseMove(strip, { clientX: 70 });
    fireEvent.mouseDown(strip, { clientX: 70 });
    fireEvent.mouseUp(strip, { clientX: 70 });
    fireEvent.doubleClick(strip, { clientX: 70 });
    fireEvent.contextMenu(strip, { clientX: 70 });
    fireEvent.mouseLeave(strip, { clientX: 0 });

    expect(
      seen.mock.calls.map((c) => (c[0] as AxisMouseEvent).event.type),
    ).toEqual([
      'mouseenter',
      'mousemove',
      'mousedown',
      'mouseup',
      'dblclick',
      'contextmenu',
      'mouseleave',
    ]);
    // 70 / 350 of [0, 1000]
    expect((seen.mock.calls[1]![0] as AxisMouseEvent).value).toBeCloseTo(
      200,
      6,
    );
  });

  it('bubbles from a tick label — the strip is the reporting element', () => {
    const seen = vi.fn();
    const { getByText } = draw(
      <ChartContainer range={RANGE} width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
        <XAxis ticks={[{ at: 500, label: 'Mid' }]} onMouseEvent={seen} />
      </ChartContainer>,
    );

    // The label is a child of the strip; the handler still resolves against the
    // strip's rect (`currentTarget`), not the label's.
    fireEvent.click(getByText('Mid'), { clientX: PLOT / 2 });

    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0]![0] as AxisMouseEvent).value).toBeCloseTo(
      500,
      6,
    );
  });

  it('clamps to the strip, so a leave off the edge still reads on-scale', () => {
    const seen = vi.fn();
    const dom = mount(seen);

    fireEvent.mouseLeave(xStrip(dom), { clientX: PLOT + 400 });
    fireEvent.mouseLeave(xStrip(dom), { clientX: -80 });

    expect((seen.mock.calls[0]![0] as AxisMouseEvent).value).toBeCloseTo(1000);
    expect((seen.mock.calls[1]![0] as AxisMouseEvent).value).toBeCloseTo(0);
  });

  it('labels with the axis format — the value the ticks would print', () => {
    const seen = vi.fn();
    // A **value** x axis (re-keyed to a numeric column), so the assertion reads
    // the axis's own `format` rather than the host's time zone.
    const dom = draw(
      <ChartContainer range={RANGE} width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series().byValue('dist')} column="v" axis="v" />
          </Layers>
        </ChartRow>
        <XAxis format="$,.2f" onMouseEvent={seen} />
      </ChartContainer>,
    ).container;

    fireEvent.click(xStrip(dom), { clientX: PLOT / 2 });

    expect((seen.mock.calls[0]![0] as AxisMouseEvent).label).toBe('$500.00');
  });

  it('on a category axis, reports the band centre and names the category', () => {
    const seen = vi.fn();
    const dom = draw(
      <ChartContainer width={WIDTH} categories={TICKERS} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={30} />
          <Layers>
            <BarChart categories={bars} axis="v" />
          </Layers>
        </ChartRow>
        <XAxis onMouseEvent={seen} />
      </ChartContainer>,
    ).container;

    // Four slots across 350px = 87.5px each; anywhere inside the third slot
    // (`NVDA`) inverts to that band's centre, 2.5.
    fireEvent.click(xStrip(dom), { clientX: 2 * 87.5 + 10 });

    const info = seen.mock.calls[0]![0] as AxisMouseEvent;
    expect(info.value).toBeCloseTo(2.5, 6);
    expect(info.label).toBe('NVDA');
  });

  it('attaches nothing when the prop is omitted', () => {
    const dom = draw(
      <ChartContainer range={RANGE} width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    ).container;

    // No handler, no listener — the click is inert rather than throwing.
    expect(() =>
      fireEvent.click(xStrip(dom), { clientX: PLOT / 2 }),
    ).not.toThrow();
  });
});

describe('<YAxis onMouseEvent>', () => {
  it('a click reports the axis value and this axis’s id', () => {
    const seen = vi.fn();
    const dom = draw(
      <ChartContainer range={RANGE} width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="price" min={0} max={100} onMouseEvent={seen} />
          <Layers>
            <LineChart series={series()} column="v" axis="price" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;

    // y is inverted: 25px down a 100px row on [0, 100] → 75.
    fireEvent.click(yGutter(dom, 'price'), { clientY: 25 });

    const info = seen.mock.calls[0]![0] as AxisMouseEvent;
    expect(info.axis).toBe('y');
    expect(info.id).toBe('price');
    expect(info.value).toBeCloseTo(75, 6);
    expect(info.label).toBe('75');
  });

  it('only the axis that opted in reports — the sibling stays inert', () => {
    const seen = vi.fn();
    const dom = draw(
      <ChartContainer range={RANGE} width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="left" min={0} max={100} onMouseEvent={seen} />
          <YAxis id="right" side="right" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="v" axis="left" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;

    fireEvent.click(yGutter(dom, 'right'), { clientY: 50 });
    expect(seen).not.toHaveBeenCalled();

    fireEvent.click(yGutter(dom, 'left'), { clientY: 50 });
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0]![0] as AxisMouseEvent).id).toBe('left');
  });

  it('labels a categorical row by its category, not its slot number', () => {
    const seen = vi.fn();
    const dom = draw(
      <ChartContainer width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="cat" onMouseEvent={seen} />
          <Layers>
            <BarChart categories={bars} orientation="horizontal" axis="cat" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;

    fireEvent.click(yGutter(dom, 'cat'), { clientY: 50 });

    const info = seen.mock.calls[0]![0] as AxisMouseEvent;
    expect(TICKERS).toContain(info.label);
    expect(info.label).toBe(TICKERS[Math.floor(info.value)]);
  });

  it('a hidden axis draws no gutter and so reports nothing', () => {
    const seen = vi.fn();
    const dom = draw(
      <ChartContainer range={RANGE} width={WIDTH} showAxis={false}>
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={100} hide onMouseEvent={seen} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;

    expect(yGutter(dom, 'v')).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });
});
