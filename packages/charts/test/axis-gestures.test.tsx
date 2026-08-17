/**
 * Axis pan/zoom — drag / wheel on an axis strip zooms **that** axis, and
 * double-click returns it to its declared view.
 *
 * Two claims carry the design and get the hardest tests:
 *
 * - **The x strip behaves exactly as the canvas does** — drag pans, wheel zooms
 *   — reusing the plot's own domain-space maths, so the pan preserves its span,
 *   `minDuration` is still the zoom-in floor, and a wheel holds the instant
 *   under the pointer.
 * - **A y gutter scales only the axis you grabbed.** The container's uniform
 *   `yTransform` deliberately refuses to answer "which axis does a vertical
 *   gesture own?" (context.ts); a gutter drag answers it, so the sibling axis
 *   and every other row must hold still.
 */
import { useContext, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BarChart } from '../src/BarChart.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import type { AxisMouseEvent } from '../src/axis-events.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const WIDTH = 400;
const PLOT = 350; // one 50px gutter
const RANGE: readonly [number, number] = [0, 1000];

const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 10],
      [500, 40],
      [1000, 20],
    ],
  });

const TICKERS = ['AAPL', 'MSFT', 'NVDA'];
const bars = TICKERS.map((label, i) => ({ label, value: 10 + i * 5 }));

/** Captures the container + row frames so a test can read the view state back. */
function Capture({ into }: { into: { c?: ContainerFrame; r?: RowFrame } }) {
  const c = useContext(ContainerContext);
  const r = useContext(RowContext);
  useEffect(() => {
    if (c) into.c = c;
    if (r) into.r = r;
  });
  return null;
}

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

/** A press-drag-release along one axis, in whole-pixel steps. */
function dragBy(
  el: HTMLElement,
  axis: 'x' | 'y',
  delta: number,
  from = 100,
): void {
  const at = (v: number) =>
    axis === 'x' ? { clientX: v, clientY: 5 } : { clientX: 5, clientY: v };
  act(() => {
    fireEvent.pointerDown(el, { ...at(from), button: 0, pointerId: 1 });
    // Two steps: the first crosses the 3px slop, the second is the real zoom.
    fireEvent.pointerMove(el, { ...at(from + delta / 2), pointerId: 1 });
    fireEvent.pointerMove(el, { ...at(from + delta), pointerId: 1 });
    fireEvent.pointerUp(el, { ...at(from + delta), pointerId: 1 });
  });
}

const span = (r: readonly [number, number]) => r[1] - r[0];

/**
 * A wheel notch over `el`. happy-dom's `WheelEvent` constructor **drops both
 * `deltaY` and the pointer position** (they read back 0 / undefined), so they are
 * forced on afterwards — without which this test silently exercised nothing.
 * That gap is also what the hook's factor/pivot guard is for: the missing fields
 * produced `exp(NaN)` and a `[NaN, NaN]` view, and a chart cannot come back from
 * that.
 */
function wheelOn(
  el: HTMLElement,
  deltaY: number,
  pos: { clientX?: number; clientY?: number },
) {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'deltaY', { value: deltaY });
  Object.defineProperty(e, 'clientX', { value: pos.clientX ?? 0 });
  Object.defineProperty(e, 'clientY', { value: pos.clientY ?? 0 });
  act(() => {
    el.dispatchEvent(e);
  });
}

describe('<XAxis> drag-to-zoom', () => {
  const mount = (props: { panZoom?: 'panZoom' | 'none' } = {}) => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom={props.panZoom ?? 'panZoom'}
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
        <XAxis onMouseEvent={() => {}} />
      </ChartContainer>,
    ).container;
    return { dom, into };
  };

  it('drag PANS — the span is preserved, as on the canvas', () => {
    const { dom, into } = mount();
    expect(span(into.c!.timeRange)).toBe(1000);

    dragBy(xStrip(dom), 'x', 120);

    // A pan slides the window; scaling it would be the plot-gesture confusion
    // this axis deliberately avoids.
    expect(span(into.c!.timeRange)).toBe(1000);
  });

  it('dragging right moves the view earlier — the content follows the pointer', () => {
    const { dom, into } = mount();

    dragBy(xStrip(dom), 'x', 105); // 105px of a 350px plot over a 1000ms view

    // -105/350 * 1000 = -300ms, the same sign the plot's drag uses.
    expect(into.c!.timeRange[0]).toBeCloseTo(-300, 0);
    expect(into.c!.timeRange[1]).toBeCloseTo(700, 0);
  });

  it('dragging left moves it later', () => {
    const { dom, into } = mount();

    dragBy(xStrip(dom), 'x', -70, 200);

    expect(into.c!.timeRange[0]).toBeCloseTo(200, 0);
    expect(into.c!.timeRange[1]).toBeCloseTo(1200, 0);
  });

  it('the pan is anchored on the press, not accumulated per move', () => {
    const { dom, into } = mount();
    // Many small moves to the same place as one big one must land identically —
    // an incremental pan would drift here, because each step would re-snap to
    // whole ms (`roundRange`) and the errors would compound.
    act(() => {
      fireEvent.pointerDown(xStrip(dom), {
        clientX: 100,
        clientY: 5,
        button: 0,
        pointerId: 1,
      });
      for (let x = 104; x <= 205; x += 1) {
        fireEvent.pointerMove(xStrip(dom), {
          clientX: x,
          clientY: 5,
          pointerId: 1,
        });
      }
      fireEvent.pointerUp(xStrip(dom), {
        clientX: 205,
        clientY: 5,
        pointerId: 1,
      });
    });

    // -105/350 * 1000 = -300ms exactly, whatever route the pointer took.
    expect(into.c!.timeRange[0]).toBeCloseTo(-300, 0);
    expect(span(into.c!.timeRange)).toBe(1000);
  });

  it('a wheel notch zooms about the pointer, holding that instant', () => {
    const { dom, into } = mount();
    const grabbed = +into.c!.xScale.invert(100);

    wheelOn(xStrip(dom), -240, { clientX: 100 });

    expect(span(into.c!.timeRange)).toBeLessThan(1000);
    // Within a millisecond — a time view snaps to whole ms (`roundRange`), so
    // the pivot can land a fraction of a ms off; that is the model's floor, not
    // slack in the gesture.
    expect(+into.c!.xScale.invert(100)).toBeCloseTo(grabbed, 0);
  });

  it('double-click returns to the declared range', () => {
    const { dom, into } = mount();
    dragBy(xStrip(dom), 'x', 150);
    expect(into.c!.timeRange[0]).not.toBe(RANGE[0]);

    act(() => {
      fireEvent.doubleClick(xStrip(dom));
    });

    expect(into.c!.timeRange[0]).toBe(RANGE[0]);
    expect(into.c!.timeRange[1]).toBe(RANGE[1]);
  });

  it('honours minDuration as the zoom-in floor', () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
        minDuration={400}
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    ).container;

    // Wheel, not drag: `minDuration` floors the ZOOM, and the strip's drag pans.
    for (let i = 0; i < 12; i += 1)
      wheelOn(xStrip(dom), -240, { clientX: 100 });

    expect(span(into.c!.timeRange)).toBeGreaterThanOrEqual(400);
  });

  it('stays inert with panZoom off — and shows no resize cursor', () => {
    const { dom, into } = mount({ panZoom: 'none' });

    dragBy(xStrip(dom), 'x', 150);
    wheelOn(xStrip(dom), -240, { clientX: 100 });

    expect(into.c!.timeRange[0]).toBe(RANGE[0]);
    expect(span(into.c!.timeRange)).toBe(1000);
    expect(xStrip(dom).style.cursor).toBe('');
  });

  it("panZoom='pan' pans on drag but leaves the wheel to the page", () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="pan"
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    ).container;

    wheelOn(xStrip(dom), -240, { clientX: 100 });
    expect(span(into.c!.timeRange)).toBe(1000); // no zoom

    dragBy(xStrip(dom), 'x', 105);
    expect(into.c!.timeRange[0]).toBeCloseTo(-300, 0); // but it pans
  });

  it('a category axis has no continuous domain to zoom — inert', () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        width={WIDTH}
        categories={TICKERS}
        showAxis={false}
        panZoom="panZoom"
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={30} />
          <Layers>
            <BarChart categories={bars} axis="v" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    ).container;
    const before = into.c!.timeRange;

    dragBy(xStrip(dom), 'x', 150);
    wheelOn(xStrip(dom), -240, { clientX: 100 });

    expect(into.c!.timeRange).toEqual(before);
    expect(xStrip(dom).style.cursor).toBe('');
  });

  it('is an arrow at rest and a left/right cursor only while dragging', () => {
    const { dom } = mount();
    expect(xStrip(dom).style.cursor).toBe('');

    act(() => {
      fireEvent.pointerDown(xStrip(dom), {
        clientX: 100,
        clientY: 5,
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerMove(xStrip(dom), {
        clientX: 140,
        clientY: 5,
        pointerId: 1,
      });
    });
    expect(xStrip(dom).style.cursor).toBe('ew-resize');

    act(() => {
      fireEvent.pointerUp(xStrip(dom), {
        clientX: 140,
        clientY: 5,
        pointerId: 1,
      });
    });
    expect(xStrip(dom).style.cursor).toBe('');
  });

  it('swallows the drag’s trailing click, but not a real click', () => {
    const seen = vi.fn();
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={50} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
        <XAxis onMouseEvent={seen} />
      </ChartContainer>,
    ).container;

    // A zoom drag: the browser still fires `click` on release, but the value
    // under the release pixel is not one the user aimed at.
    dragBy(xStrip(dom), 'x', 120);
    act(() => {
      fireEvent.click(xStrip(dom), { clientX: 220 });
    });
    expect(
      seen.mock.calls.filter(
        (c) => (c[0] as AxisMouseEvent).event.type === 'click',
      ),
    ).toHaveLength(0);

    // The next click is a real one and reports normally.
    act(() => {
      fireEvent.click(xStrip(dom), { clientX: 220 });
    });
    expect(
      seen.mock.calls.filter(
        (c) => (c[0] as AxisMouseEvent).event.type === 'click',
      ),
    ).toHaveLength(1);
  });
});

describe('<YAxis> drag-to-zoom — per axis', () => {
  const mount = () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH + 50}
        showAxis={false}
        panZoom="panZoom"
      >
        <ChartRow height={100}>
          <YAxis id="left" min={0} max={100} />
          <YAxis id="right" side="right" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="v" axis="left" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
      </ChartContainer>,
    ).container;
    return { dom, into };
  };

  const domainOf = (into: { r?: RowFrame }, id: string) =>
    into.r!.yScales.get(id)!.domain() as [number, number];

  it('scales the grabbed axis and leaves its sibling alone', () => {
    const { dom, into } = mount();
    const leftBefore = domainOf(into, 'left');
    const rightBefore = domainOf(into, 'right');

    dragBy(yGutter(dom, 'left'), 'y', -60, 50); // drag up = zoom in

    const leftAfter = domainOf(into, 'left');
    expect(leftAfter[1] - leftAfter[0]).toBeLessThan(
      leftBefore[1] - leftBefore[0],
    );
    // The whole point of the per-axis transform: the sibling is untouched.
    expect(domainOf(into, 'right')).toEqual(rightBefore);
  });

  it('records the transform against that axis id only', () => {
    const { dom, into } = mount();

    dragBy(yGutter(dom, 'left'), 'y', -60, 50);

    expect(into.r!.axisTransforms.has('left')).toBe(true);
    expect(into.r!.axisTransforms.has('right')).toBe(false);
    // The container's uniform transform — what a PLOT gesture drives — is
    // untouched, so the aspect-lock invariant it protects still holds.
    expect(into.c!.yTransform).toEqual({ k: 1, ty: 0 });
  });

  it('dragging down zooms out — the domain widens', () => {
    const { dom, into } = mount();
    const before = domainOf(into, 'left');

    dragBy(yGutter(dom, 'left'), 'y', 60, 20);

    const after = domainOf(into, 'left');
    expect(after[1] - after[0]).toBeGreaterThan(before[1] - before[0]);
  });

  it('double-click releases the axis back to its fit', () => {
    const { dom, into } = mount();
    const before = domainOf(into, 'left');
    dragBy(yGutter(dom, 'left'), 'y', -60, 50);
    expect(domainOf(into, 'left')).not.toEqual(before);

    act(() => {
      fireEvent.doubleClick(yGutter(dom, 'left'));
    });

    expect(domainOf(into, 'left')).toEqual(before);
    // Identity is the ABSENCE of an entry, so the scale memo's fast path is back.
    expect(into.r!.axisTransforms.has('left')).toBe(false);
  });

  it('a wheel notch over the gutter zooms that axis', () => {
    const { dom, into } = mount();
    const before = domainOf(into, 'left');

    wheelOn(yGutter(dom, 'left'), -240, { clientY: 50 });

    expect(domainOf(into, 'left')).not.toEqual(before);
    expect(domainOf(into, 'right')).toEqual([0, 10]);
  });

  it('is an arrow at rest and an up/down cursor only while dragging', () => {
    const { dom } = mount();
    expect(yGutter(dom, 'left').style.cursor).toBe('');

    act(() => {
      fireEvent.pointerDown(yGutter(dom, 'left'), {
        clientX: 5,
        clientY: 50,
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerMove(yGutter(dom, 'left'), {
        clientX: 5,
        clientY: 20,
        pointerId: 1,
      });
    });
    expect(yGutter(dom, 'left').style.cursor).toBe('ns-resize');

    act(() => {
      fireEvent.pointerUp(yGutter(dom, 'left'), {
        clientX: 5,
        clientY: 20,
        pointerId: 1,
      });
    });
    expect(yGutter(dom, 'left').style.cursor).toBe('');
  });

  it('is live under an x-only panZoom — the canonical auto-y setup', () => {
    // Scaling the y gutter must NOT require opting the plot into vertical
    // gestures: the common chart is an auto-fitting y with a panned/zoomed x.
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={100} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
      </ChartContainer>,
    ).container;
    expect(into.c!.zoomY).toBe(false); // the plot itself does not zoom y

    dragBy(yGutter(dom, 'v'), 'y', -60, 50);

    const d = into.r!.yScales.get('v')!.domain() as [number, number];
    expect(d[1] - d[0]).toBeLessThan(100);
  });

  it('stays inert on a non-interactive chart (panZoom off)', () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="none"
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={100} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
      </ChartContainer>,
    ).container;

    dragBy(yGutter(dom, 'v'), 'y', -60, 50);

    expect(into.r!.yScales.get('v')!.domain()).toEqual([0, 100]);
    expect(yGutter(dom, 'v').style.cursor).toBe('');
  });
});

describe('<YAxis onDomainChange> — the auto/manual hand-off', () => {
  /** The shape a scale UI actually wires: `null` domain = auto-fit. */
  function Controlled({
    onReport,
  }: {
    onReport: (d: readonly [number, number] | null) => void;
  }) {
    const [domain, setDomain] = useState<readonly [number, number] | null>(
      null,
    );
    return (
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
      >
        <ChartRow height={100}>
          <YAxis
            id="price"
            {...(domain ? { min: domain[0], max: domain[1] } : {})}
            onDomainChange={(d) => {
              setDomain(d);
              onReport(d);
            }}
          />
          <Layers>
            <LineChart series={series()} column="v" axis="price" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  }

  it('reports the domain the gesture reached, in data units', () => {
    const seen = vi.fn();
    const dom = draw(<Controlled onReport={seen} />).container;

    dragBy(yGutter(dom, 'price'), 'y', -60, 50); // drag up = zoom in

    expect(seen).toHaveBeenCalled();
    const [lo, hi] = seen.mock.calls.at(-1)![0] as [number, number];
    // The series spans 10..40, so the auto fit is that; a zoom-in narrows it.
    expect(hi - lo).toBeLessThan(30);
    expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
  });

  it('reports null on double-click — the "back to auto" signal', () => {
    const seen = vi.fn();
    const dom = draw(<Controlled onReport={seen} />).container;
    dragBy(yGutter(dom, 'price'), 'y', -60, 50);

    act(() => {
      fireEvent.doubleClick(yGutter(dom, 'price'));
    });

    expect(seen.mock.calls.at(-1)![0]).toBeNull();
  });

  it('holds no internal transform when controlled — no double-counting', () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
      >
        <ChartRow height={100}>
          <YAxis id="price" min={0} max={100} onDomainChange={() => {}} />
          <Layers>
            <LineChart series={series()} column="v" axis="price" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
      </ChartContainer>,
    ).container;

    dragBy(yGutter(dom, 'price'), 'y', -60, 50);

    // The consumer owns the domain; an internal transform on top of the min/max
    // they feed back would apply the zoom twice.
    expect(into.r!.axisTransforms.has('price')).toBe(false);
    expect(into.r!.yScales.get('price')!.domain()).toEqual([0, 100]);
  });

  it('a wheel notch reports too, composing on the fed-back domain', () => {
    const seen = vi.fn();
    const dom = draw(<Controlled onReport={seen} />).container;

    wheelOn(yGutter(dom, 'price'), -240, { clientY: 50 });
    const first = seen.mock.calls.at(-1)![0] as [number, number];
    wheelOn(yGutter(dom, 'price'), -240, { clientY: 50 });
    const second = seen.mock.calls.at(-1)![0] as [number, number];

    // The second notch zooms further in than the first, which only holds if the
    // axis is reading the domain the consumer fed back.
    expect(second[1] - second[0]).toBeLessThan(first[1] - first[0]);
  });
});
