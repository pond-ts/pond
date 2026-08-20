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
        axisPanZoom="xy"
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
        axisPanZoom="xy"
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

  it('works with panZoom off — the opt-in owns the view by itself', () => {
    // This test used to assert the opposite, and was wrong to: `interactive`
    // (which decides whether the container holds a gestured view at all) was
    // derived from the PLOT's freedoms only, so an uncontrolled
    // `axisPanZoom="x"` strip captured the drag, wrote `internalRange`, and kept
    // rendering `seed` — the headline combination silently did nothing.
    const { dom, into } = mount({ panZoom: 'none' });

    dragBy(xStrip(dom), 'x', 105);
    expect(into.c!.timeRange[0]).toBeCloseTo(-300, 0);
    expect(span(into.c!.timeRange)).toBe(1000);

    wheelOn(xStrip(dom), -240, { clientX: 100 });
    expect(span(into.c!.timeRange)).toBeLessThan(1000);
  });

  it("the opt-in is self-sufficient — it works over panZoom='pan'", () => {
    // `axisPanZoom` is independent of `panZoom` in BOTH directions: the strip
    // takes the gestures it was opted into, whatever the plot is doing. (It used
    // to inherit the plot's wheel policy, which made `'pan'` mean "no strip
    // zoom" — an implicit coupling nobody asked for.)
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="pan"
        axisPanZoom="x"
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

    dragBy(xStrip(dom), 'x', 105);
    expect(into.c!.timeRange[0]).toBeCloseTo(-300, 0);

    wheelOn(xStrip(dom), -240, { clientX: 100 });
    expect(span(into.c!.timeRange)).toBeLessThan(1000);
  });

  it('a category axis has no continuous domain to zoom — inert', () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        width={WIDTH}
        categories={TICKERS}
        showAxis={false}
        panZoom="panZoom"
        axisPanZoom="xy"
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
        axisPanZoom="xy"
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

describe('<YAxis> drag-to-pan — per axis', () => {
  const mount = () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH + 50}
        showAxis={false}
        panZoom="panZoom"
        axisPanZoom="xy"
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

  it('pans the grabbed axis, span preserved, and leaves its sibling alone', () => {
    const { dom, into } = mount();
    const leftBefore = domainOf(into, 'left');
    const rightBefore = domainOf(into, 'right');

    dragBy(yGutter(dom, 'left'), 'y', -60, 50); // drag up = pan

    const leftAfter = domainOf(into, 'left');
    expect(leftAfter).not.toEqual(leftBefore);
    // A pan slides the view — the span holds, unlike a zoom.
    expect(leftAfter[1] - leftAfter[0]).toBeCloseTo(
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

  it('dragging up and down pan in opposite directions', () => {
    const { dom, into } = mount();
    const before = domainOf(into, 'left');

    dragBy(yGutter(dom, 'left'), 'y', 60, 20);
    const afterDown = domainOf(into, 'left');
    expect(afterDown).not.toEqual(before);
    expect(afterDown[1] - afterDown[0]).toBeCloseTo(before[1] - before[0]);

    act(() => {
      fireEvent.doubleClick(yGutter(dom, 'left'));
    });
    dragBy(yGutter(dom, 'left'), 'y', -60, 20);
    const afterUp = domainOf(into, 'left');
    expect(afterUp).not.toEqual(before);
    expect(afterUp).not.toEqual(afterDown);
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
    // Panning the y gutter must NOT require opting the plot into vertical
    // gestures: the common chart is an auto-fitting y with a panned/zoomed x.
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
        axisPanZoom="xy"
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
    expect(d[1] - d[0]).toBeCloseTo(100);
    expect(d).not.toEqual([0, 100]);
  });

  it('stays inert without the axisPanZoom opt-in', () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoomXY"
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

describe('<YAxis onBoundsChange> — the auto/manual hand-off', () => {
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
        axisPanZoom="xy"
      >
        <ChartRow height={100}>
          <YAxis
            id="price"
            {...(domain ? { min: domain[0], max: domain[1] } : {})}
            onBoundsChange={(d) => {
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

    dragBy(yGutter(dom, 'price'), 'y', -60, 50); // drag up = pan

    expect(seen).toHaveBeenCalled();
    const [lo, hi] = seen.mock.calls.at(-1)![0] as [number, number];
    // The series spans 10..40, so the auto fit is that; a pan shifts it without
    // changing its width.
    expect(hi - lo).toBeCloseTo(30);
    expect([lo, hi]).not.toEqual([10, 40]);
    expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
  });

  it('a many-small-moves controlled pan lands the same as one big move — the grabbed value does not drift under the cursor', () => {
    // A controlled consumer feeds `min`/`max` back through `onBoundsChange`
    // after every move, so a naive `onPan` that re-reads the base scale fresh
    // each time would compose the anchored total delta onto a base this same
    // drag already shifted — doubling (then quadrupling, …) the effect with
    // every extra move the pointer makes en route to the same place.
    const seen = vi.fn();
    const dom = draw(<Controlled onReport={seen} />).container;

    act(() => {
      fireEvent.pointerDown(yGutter(dom, 'price'), {
        clientX: 5,
        clientY: 100,
        button: 0,
        pointerId: 1,
      });
      for (let y = 96; y >= 60; y -= 1) {
        fireEvent.pointerMove(yGutter(dom, 'price'), {
          clientX: 5,
          clientY: y,
          pointerId: 1,
        });
      }
      fireEvent.pointerUp(yGutter(dom, 'price'), {
        clientX: 5,
        clientY: 60,
        pointerId: 1,
      });
    });
    const manyMoves = seen.mock.calls.at(-1)![0] as [number, number];

    const seenOneMove = vi.fn();
    const dom2 = draw(<Controlled onReport={seenOneMove} />).container;
    dragBy(yGutter(dom2, 'price'), 'y', -40, 100);
    const oneMove = seenOneMove.mock.calls.at(-1)![0] as [number, number];

    expect(manyMoves[0]).toBeCloseTo(oneMove[0], 1);
    expect(manyMoves[1]).toBeCloseTo(oneMove[1], 1);
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
        axisPanZoom="xy"
      >
        <ChartRow height={100}>
          <YAxis id="price" min={0} max={100} onBoundsChange={() => {}} />
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

describe('axis gestures — Layer-2 review finds', () => {
  it('a padded controlled axis does not ratchet outward', () => {
    // `pad` is applied LAST and to explicit bounds too, so a scale's live domain
    // is the padded one. Reporting that and feeding it back re-pads it — the axis
    // then inflates by (1 + 2·pad) per notch, walking OUTWARD under a zoom-in.
    const seen = vi.fn();
    function Padded() {
      const [domain, setDomain] = useState<readonly [number, number] | null>(
        null,
      );
      return (
        <ChartContainer
          range={RANGE}
          width={WIDTH}
          showAxis={false}
          panZoom="panZoom"
          axisPanZoom="xy"
        >
          <ChartRow height={100}>
            <YAxis
              id="price"
              pad={0.25}
              {...(domain ? { min: domain[0], max: domain[1] } : {})}
              onBoundsChange={(d) => {
                setDomain(d);
                seen(d);
              }}
            />
            <Layers>
              <LineChart series={series()} column="v" axis="price" />
            </Layers>
          </ChartRow>
        </ChartContainer>
      );
    }
    const dom = draw(<Padded />).container;

    const spans: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      wheelOn(yGutter(dom, 'price'), -240, { clientY: 50 });
      const d = seen.mock.calls.at(-1)![0] as [number, number];
      spans.push(d[1] - d[0]);
    }

    // Every zoom-in notch must narrow what is reported. (Before the fix each
    // one grew: 1.5× the pad inflation beat the 0.7× zoom.)
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!).toBeLessThan(spans[i - 1]!);
    }
  });

  it('reported bounds round-trip through pad — what you feed back is what you see', () => {
    const seen = vi.fn();
    function Padded({ pad }: { pad: number }) {
      const [domain, setDomain] = useState<readonly [number, number] | null>(
        null,
      );
      return (
        <ChartContainer
          range={RANGE}
          width={WIDTH}
          showAxis={false}
          panZoom="panZoom"
          axisPanZoom="xy"
        >
          <ChartRow height={100}>
            <YAxis
              id="price"
              pad={pad}
              {...(domain ? { min: domain[0], max: domain[1] } : {})}
              onBoundsChange={(d) => {
                setDomain(d);
                seen(d);
              }}
            />
            <Layers>
              <LineChart series={series()} column="v" axis="price" />
            </Layers>
            <Capture into={frames} />
          </ChartRow>
        </ChartContainer>
      );
    }
    const frames: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(<Padded pad={0.2} />).container;

    wheelOn(yGutter(dom, 'price'), -240, { clientY: 50 });
    const reported = seen.mock.calls.at(-1)![0] as [number, number];
    const drawn = frames.r!.yScales.get('price')!.domain() as [number, number];

    // The axis re-pads what it is given, so the drawn domain is the reported
    // bounds plus pad — and re-padding must not have compounded.
    const span = reported[1] - reported[0];
    expect(drawn[0]).toBeCloseTo(reported[0] - 0.2 * span, 6);
    expect(drawn[1]).toBeCloseTo(reported[1] + 0.2 * span, 6);
  });

  it('the wheel keeps working after a hide toggle remounts the gutter', () => {
    // The listener is bound in the ref callback, not a `[]`-deps effect: the
    // gutter element is replaced when `hide` flips, and an effect-bound listener
    // would stay attached to the element that went away.
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    function Toggle({ hide }: { hide: boolean }) {
      return (
        <ChartContainer
          range={RANGE}
          width={WIDTH}
          showAxis={false}
          panZoom="panZoom"
          axisPanZoom="xy"
        >
          <ChartRow height={100}>
            <YAxis id="v" min={0} max={100} hide={hide} />
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
            </Layers>
            <Capture into={into} />
          </ChartRow>
        </ChartContainer>
      );
    }
    const stub = stubCanvasContext();
    const r = render(<Toggle hide={false} />);
    try {
      r.rerender(<Toggle hide />);
      expect(yGutter(r.container, 'v')).toBeNull(); // gutter gone
      r.rerender(<Toggle hide={false} />); // …and a NEW element back

      wheelOn(yGutter(r.container, 'v'), -240, { clientY: 50 });
    } finally {
      stub.restore();
    }

    const d = into.r!.yScales.get('v')!.domain() as [number, number];
    expect(d[1] - d[0]).toBeLessThan(100);
  });

  it('an unmounting axis leaves no transform behind for its id', () => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    function WithAxis({ show }: { show: boolean }) {
      return (
        <ChartContainer
          range={RANGE}
          width={WIDTH}
          showAxis={false}
          panZoom="panZoom"
          axisPanZoom="xy"
        >
          <ChartRow height={100}>
            {show ? <YAxis id="v" min={0} max={100} /> : null}
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
            </Layers>
            <Capture into={into} />
          </ChartRow>
        </ChartContainer>
      );
    }
    const stub = stubCanvasContext();
    const r = render(<WithAxis show />);
    try {
      dragBy(yGutter(r.container, 'v'), 'y', -60, 50);
      expect(into.r!.axisTransforms.has('v')).toBe(true);

      r.rerender(<WithAxis show={false} />);
    } finally {
      stub.restore();
    }

    // Transforms are keyed by axis id (as scales are), so a stale entry would be
    // inherited by any later axis reusing the id.
    expect(into.r!.axisTransforms.has('v')).toBe(false);
  });
});

describe('axisPanZoom is the opt-in — panZoom alone changes nothing', () => {
  /** A chart exactly as it would be written before this feature existed. */
  const legacy = (panZoom: 'pan' | 'panZoom' | 'panZoomXY') => {
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom={panZoom}
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={100} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    ).container;
    return { dom, into };
  };

  for (const mode of ['pan', 'panZoom', 'panZoomXY'] as const) {
    it(`panZoom='${mode}' leaves both strips inert`, () => {
      const { dom, into } = legacy(mode);
      const before = into.c!.timeRange;
      const yBefore = into.r!.yScales.get('v')!.domain();

      dragBy(xStrip(dom), 'x', 120);
      wheelOn(xStrip(dom), -240, { clientX: 100 });
      dragBy(yGutter(dom, 'v'), 'y', -60, 50);
      wheelOn(yGutter(dom, 'v'), -240, { clientY: 50 });

      // The whole point: upgrading must not give an existing interactive chart
      // gestures its author never asked for.
      expect(into.c!.timeRange).toEqual(before);
      expect(into.r!.yScales.get('v')!.domain()).toEqual(yBefore);
      expect(into.r!.axisTransforms.size).toBe(0);
      expect(xStrip(dom).style.cursor).toBe('');
      expect(yGutter(dom, 'v').style.cursor).toBe('');
    });
  }

  it('works with panZoom off entirely — axis gestures without a grabbable plot', () => {
    // The case the independence exists for: pan the y axes while the plot
    // keeps its drag for a selection sweep.
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="none"
        axisPanZoom="y"
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

    const d = into.r!.yScales.get('v')!.domain() as [number, number];
    expect(d[1] - d[0]).toBeCloseTo(100);
    expect(d).not.toEqual([0, 100]);
  });

  it("'x' and 'y' each enable only their own strip", () => {
    const onlyX = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
        axisPanZoom="x"
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={100} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    ).container;
    dragBy(yGutter(onlyX, 'v'), 'y', -60, 50);
    expect(yGutter(onlyX, 'v').style.cursor).toBe(''); // y inert under 'x'
    cleanup();

    const intoY: { c?: ContainerFrame; r?: RowFrame } = {};
    const onlyY = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
        axisPanZoom="y"
      >
        <ChartRow height={100}>
          <YAxis id="v" min={0} max={100} />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
          <Capture into={intoY} />
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    ).container;
    const before = intoY.c!.timeRange;
    dragBy(xStrip(onlyY), 'x', 120);
    expect(intoY.c!.timeRange).toEqual(before); // x inert under 'y'
  });
});

describe('axis gestures — Codex review finds', () => {
  /** A controlled gutter on one axis, with whatever axis props a test needs. */
  function Controlled({
    onReport,
    axis = {},
    container = {},
  }: {
    onReport: (b: readonly [number, number] | null) => void;
    axis?: Record<string, unknown>;
    container?: Record<string, unknown>;
  }) {
    const [bounds, setBounds] = useState<readonly [number, number] | null>(
      null,
    );
    return (
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
        axisPanZoom="y"
        {...container}
      >
        <ChartRow height={100}>
          <YAxis
            id="a"
            {...axis}
            {...(bounds ? { min: bounds[0], max: bounds[1] } : {})}
            onBoundsChange={(b) => {
              setBounds(b);
              onReport(b);
            }}
          />
          <Layers>
            <LineChart series={series()} column="v" axis="a" />
          </Layers>
          <Capture into={frames} />
        </ChartRow>
      </ChartContainer>
    );
  }
  let frames: { c?: ContainerFrame; r?: RowFrame } = {};
  afterEach(() => {
    frames = {};
  });

  it('does not double-apply the plot-level y transform', () => {
    // The controlled path reads `baseYScales` — the axis's RESOLVED scale — not
    // the visible one. Reading the visible scale meant the uniform `yTransform`
    // was baked into the reported bounds and then applied AGAIN when they came
    // back as min/max, so the drawn domain diverged from every reported value.
    const seen = vi.fn();
    const dom = draw(
      <Controlled
        onReport={seen}
        axis={{ min: 0, max: 100 }}
        container={{ panZoom: 'panZoomXY' }}
      />,
    ).container;

    // Put the plot's own uniform y zoom in play first.
    act(() => {
      frames.c!.applyYTransform({ k: 2, ty: -50 });
    });
    expect(frames.c!.yTransform.k).toBe(2);

    const reports: Array<readonly [number, number]> = [];
    for (let i = 0; i < 3; i += 1) {
      wheelOn(yGutter(dom, 'a'), -240, { clientY: 50 });
      reports.push(seen.mock.calls.at(-1)![0] as [number, number]);
    }

    // Each report must be a strict zoom-in on the last — with the double-apply
    // the reported and drawn domains pulled apart and the sequence diverged.
    for (let i = 1; i < reports.length; i += 1) {
      const prev = reports[i - 1]!;
      const cur = reports[i]!;
      expect(cur[1] - cur[0]).toBeLessThan(prev[1] - prev[0]);
    }
    // And the bounds stay inside the axis's own resolved domain.
    const last = reports.at(-1)!;
    expect(last[0]).toBeGreaterThanOrEqual(0);
    expect(last[1]).toBeLessThanOrEqual(100);
  });

  it('never reports a non-finite bound on a hard log zoom-out', () => {
    // A captured flick used to deliver one enormous factor; on a log axis
    // `zoomRange` then underflowed/overflowed to [0, Infinity], which passed the
    // old ascending-only check and poisoned the consumer's scale.
    const seen = vi.fn();
    const dom = draw(
      <Controlled onReport={seen} axis={{ scale: 'log', min: 1, max: 100 }} />,
    ).container;

    act(() => {
      fireEvent.pointerDown(yGutter(dom, 'a'), {
        clientX: 5,
        clientY: 50,
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerMove(yGutter(dom, 'a'), {
        clientX: 5,
        clientY: 60,
        pointerId: 1,
      });
      // One 1000px move — the coalesced-flick case.
      fireEvent.pointerMove(yGutter(dom, 'a'), {
        clientX: 5,
        clientY: 1060,
        pointerId: 1,
      });
      fireEvent.pointerUp(yGutter(dom, 'a'), {
        clientX: 5,
        clientY: 1060,
        pointerId: 1,
      });
    });

    for (const call of seen.mock.calls) {
      const b = call[0] as [number, number];
      expect(Number.isFinite(b[0])).toBe(true);
      expect(Number.isFinite(b[1])).toBe(true);
      expect(b[0]).toBeGreaterThan(0); // a log axis has no position for 0
    }
  });

  it('keeps zooming an inverted (flipped) axis', () => {
    // `resolveYDomain` keeps an explicit [max, min] as a deliberate flip. The
    // controlled path rejected every descending result, so adding the callback
    // silently disabled the gesture on a flipped axis.
    const seen = vi.fn();
    const dom = draw(
      <Controlled onReport={seen} axis={{ min: 100, max: 0 }} />,
    ).container;

    wheelOn(yGutter(dom, 'a'), -240, { clientY: 50 });

    expect(seen).toHaveBeenCalled();
    const b = seen.mock.calls.at(-1)![0] as [number, number];
    expect(b[0]).toBeGreaterThan(b[1]); // orientation preserved
    expect(Math.abs(b[0] - b[1])).toBeLessThan(100); // and it zoomed in
  });

  it('holds the grabbed pixel on an UNCONTROLLED symlog axis', () => {
    // Uncontrolled is where symlog can be exact: `ChartRow` derives the knee from
    // the axis's resolved domain and the pixel transform narrows that fixed
    // curve, so inverting through it holds the grabbed pixel.
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    const dom = draw(
      <ChartContainer
        range={RANGE}
        width={WIDTH}
        showAxis={false}
        panZoom="panZoom"
        axisPanZoom="y"
      >
        <ChartRow height={100}>
          <YAxis
            id="a"
            scale="symlog"
            min={-100}
            max={100}
            linearWindow={0.05}
          />
          <Layers>
            <LineChart series={series()} column="v" axis="a" />
          </Layers>
          <Capture into={into} />
        </ChartRow>
      </ChartContainer>,
    ).container;

    const valueAt = (px: number) => +into.r!.yScales.get('a')!.invert(px);
    const grabbed = valueAt(25);

    for (let i = 0; i < 3; i += 1) {
      wheelOn(yGutter(dom, 'a'), -120, { clientY: 25 });
    }

    expect(valueAt(25)).toBeCloseTo(grabbed, 6);
  });

  it('a CONTROLLED symlog axis zooms monotonically, knee drift and all', () => {
    // Controlled symlog cannot hold the pixel, and the reason is a documented
    // property of the scale rather than a bug in the gesture: `linearWindow` is
    // **domain-relative**, so bounds fed back re-derive the knee and reshape the
    // curve — no choice of bounds can pin a pixel on a curve that moves with the
    // bounds. (It is exactly why `<YAxis linearWindow>` says a 2-D gesture must
    // not recompute the knee.) What must hold is that it stays well-behaved.
    const seen = vi.fn();
    const dom = draw(
      <Controlled
        onReport={seen}
        axis={{ scale: 'symlog', min: -100, max: 100, linearWindow: 0.05 }}
      />,
    ).container;

    const spans: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      wheelOn(yGutter(dom, 'a'), -120, { clientY: 25 });
      const b = seen.mock.calls.at(-1)![0] as [number, number];
      expect(Number.isFinite(b[0]) && Number.isFinite(b[1])).toBe(true);
      spans.push(b[1] - b[0]);
    }
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!).toBeLessThan(spans[i - 1]!);
    }
  });

  it('drops a live drag when the strip is hidden mid-gesture', () => {
    // No `pointerup` can arrive on an element that unmounted, so the drag state
    // had to be cleared when the ref goes null — otherwise re-showing the gutter
    // resumed a gesture nobody was making, with the cursor still on.
    const into: { c?: ContainerFrame; r?: RowFrame } = {};
    function Toggle({ hide }: { hide: boolean }) {
      return (
        <ChartContainer
          range={RANGE}
          width={WIDTH}
          showAxis={false}
          panZoom="panZoom"
          axisPanZoom="y"
        >
          <ChartRow height={100}>
            <YAxis id="v" min={0} max={100} hide={hide} />
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
            </Layers>
            <Capture into={into} />
          </ChartRow>
        </ChartContainer>
      );
    }
    const stub = stubCanvasContext();
    const r = render(<Toggle hide={false} />);
    try {
      // Press and commit a drag, then hide the axis without releasing.
      act(() => {
        fireEvent.pointerDown(yGutter(r.container, 'v'), {
          clientX: 5,
          clientY: 50,
          button: 0,
          pointerId: 1,
        });
        fireEvent.pointerMove(yGutter(r.container, 'v'), {
          clientX: 5,
          clientY: 30,
          pointerId: 1,
        });
      });
      r.rerender(<Toggle hide />);
      r.rerender(<Toggle hide={false} />);

      const afterRemount = into.r!.yScales.get('v')!.domain();
      // A plain move with no press must not continue the old gesture…
      act(() => {
        fireEvent.pointerMove(yGutter(r.container, 'v'), {
          clientX: 5,
          clientY: 10,
          pointerId: 1,
        });
      });
      expect(into.r!.yScales.get('v')!.domain()).toEqual(afterRemount);
      // …and the directional cursor must be gone.
      expect(yGutter(r.container, 'v').style.cursor).toBe('');
    } finally {
      stub.restore();
    }
  });

  it('pivots inside the scale range, not the gutter box, under a top label', () => {
    // A `labelPlacement="top"` row reserves a header, so the scale range starts
    // below 0. Clamping the pivot to the box let a press in the header zoom about
    // an extrapolated value outside the domain.
    const seen = vi.fn();
    const dom = draw(
      <Controlled
        onReport={seen}
        axis={{ min: 0, max: 100, labelPlacement: 'top' }}
      />,
    ).container;

    wheelOn(yGutter(dom, 'a'), -240, { clientY: 0 }); // in the header band

    const b = seen.mock.calls.at(-1)![0] as [number, number];
    expect(b[1]).toBeLessThanOrEqual(100);
    expect(b[0]).toBeGreaterThanOrEqual(0);
  });
});
