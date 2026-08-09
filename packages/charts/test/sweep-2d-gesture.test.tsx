/**
 * The **2-D sweep, wired** — a `<MultiSelector>` rect drag over the two layers
 * whose marks live in two dimensions ([PND-INTERACT2D]).
 *
 * `sweep-2d.test.ts` pins the pure cut. This is the other half of the
 * two-level verification: the gesture that has to track a y alongside its x,
 * invert it through the *sweeping layer's* axis, paint a rect instead of a
 * band, and put the second channel on the committed span. Every defect this
 * file has caught lived in the wiring, not in the cut.
 */
import { useContext, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { HeatMap } from '../src/HeatMap.js';
import { YAxis } from '../src/YAxis.js';
import { MultiSelector, type MultiSelectorProps } from '../src/selectors.js';
import { selectionContains } from '../src/span.js';
import {
  ContainerContext,
  type ContainerFrame,
  type SelectInfo,
  type SelectModifiers,
  type SpanSelection,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

let rafQueue: FrameRequestCallback[] = [];
beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    if (id >= 1 && id <= rafQueue.length) rafQueue[id - 1] = () => {};
  });
});
afterEach(() => vi.unstubAllGlobals());
function flushFrames() {
  act(() => {
    while (rafQueue.length > 0) {
      const q = rafQueue;
      rafQueue = [];
      for (const cb of q) cb(0);
    }
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ROW_H = 120;
// A 0..12 axis over a 120px row is 10px per unit, so every pointer y below is
// an exact value — no rounding to reason about when a hit is meant to be on
// one side of the rect's edge.
const AX_MAX = 12;
const yPx = (v: number) => ROW_H - (v / AX_MAX) * ROW_H;

/** Three points, spread in BOTH dimensions — a y-window that keeps some and
 *  drops others is the only way to tell a rect from the column above it. */
const points = () =>
  new TimeSeries({
    name: 'pts',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [150, 2],
      [350, 6],
      [550, 10],
    ] as [number, number][],
  });

/** Ten daily-ish bins × three rows. Cell value = `bin * 10 + rowIndex`, so a
 *  captured set reads back as arithmetic. */
const grid = () =>
  new TimeSeries({
    name: 'grid',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'low', kind: 'number' },
      { name: 'mid', kind: 'number' },
      { name: 'high', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 10 }, (_, i) => [
      [i * 100, (i + 1) * 100],
      i * 10,
      i * 10 + 1,
      i * 10 + 2,
    ]) as [[number, number], number, number, number][],
  });

const bars = () =>
  new TimeSeries({
    name: 'b',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 10 }, (_, i) => [
      [i * 100, (i + 1) * 100],
      i + 1,
    ]) as [[number, number], number][],
  });

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

function pointer(
  type: string,
  x: number,
  y: number,
  buttons: number,
  init: PointerEventInit = {},
): Event {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons,
    ...init,
  });
}

function mount(opts: {
  layers: ReactNode;
  axisMax?: number;
  onSelect?: MultiSelectorProps['onSelect'];
}) {
  const { layers, axisMax = AX_MAX, onSelect } = opts;
  let frame: ContainerFrame | null = null;
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    const res = render(
      <ChartContainer range={[0, 1000]} width={320}>
        <MultiSelector {...(onSelect === undefined ? {} : { onSelect })} />
        <ChartRow height={ROW_H}>
          <YAxis id="a" min={0} max={axisMax} />
          <Layers>{layers}</Layers>
        </ChartRow>
        <Capture sink={(f) => (frame = f)} />
      </ChartContainer>,
    );
    dom = res.container;
  } finally {
    stub.restore();
  }
  const surface = dom.querySelector('canvas')!.parentElement!;
  const f = () => frame!;
  const pxAt = (t: number) => (t / 1000) * f().plotWidth;
  /** Down → move → up, at two arbitrary plot points. Frames flushed between,
   *  so the preview the release replaces is the one a user would have seen. */
  const drag = (x0: number, y0: number, x1: number, y1: number) => {
    act(() => surface.dispatchEvent(pointer('pointerdown', x0, y0, 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', x1, y1, 1)));
    flushFrames();
    act(() => surface.dispatchEvent(pointer('pointerup', x1, y1, 0)));
  };
  /** Down → move, held — the mid-drag state, for the brush assertions. */
  const dragTo = (x0: number, y0: number, x1: number, y1: number) => {
    act(() => surface.dispatchEvent(pointer('pointerdown', x0, y0, 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', x1, y1, 1)));
    flushFrames();
  };
  return { surface, frame: f, pxAt, drag, dragTo, dom };
}

type Call = [readonly SelectInfo[], SelectModifiers, SpanSelection | null];

// ── The scatter: a free rect ────────────────────────────────────────────────

describe('a scatter sweep cuts a free rect', () => {
  const scatter = <ScatterChart series={points()} column="v" axis="a" id="p" />;

  it('the y window cuts — the same x drag captures fewer points when it is shorter', () => {
    // The x run is identical in both drags; only the rect's height differs.
    // This is the whole difference between a 2-D cut and the column a 1-D
    // sweep would have taken, so it is the first thing to pin.
    const tall = vi.fn();
    const t = mount({ layers: scatter, onSelect: tall });
    t.drag(t.pxAt(100), yPx(1), t.pxAt(600), yPx(11));
    expect((tall.mock.calls[0] as Call)[0].map((h) => h.value)).toEqual([
      2, 6, 10,
    ]);
    cleanup();

    const short = vi.fn();
    const s = mount({ layers: scatter, onSelect: short });
    s.drag(s.pxAt(100), yPx(1), s.pxAt(600), yPx(5));
    expect((short.mock.calls[0] as Call)[0].map((h) => h.value)).toEqual([2]);
  });

  it('the committed span carries the y window alongside x, and round-trips', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({ layers: scatter, onSelect });
    drag(pxAt(100), yPx(1), pxAt(600), yPx(9));
    const [hits, , span] = onSelect.mock.calls[0] as Call;
    expect(span!.id).toBe('p');
    // A point layer's span is the DRAG's window, not the covered keys: a
    // point has no interval to snap outward to, and `[first.key, last.key]`
    // would exclude its own last point under the half-open test below.
    expect(span!.x[0]).toBeCloseTo(100);
    expect(span!.x[1]).toBeCloseTo(600);
    expect(span!.y![0]).toBeCloseTo(1);
    expect(span!.y![1]).toBeCloseTo(9);
    // Replaying the descriptor reproduces the capture — and, critically, the
    // point the y window excluded stays excluded.
    for (const h of hits) expect(selectionContains([span!], h)).toBe(true);
    expect(
      selectionContains([span!], {
        id: 'p',
        key: 550,
        value: 10,
        color: '#000',
        label: 'v',
      }),
    ).toBe(false);
  });

  it('a drag upward is the same rect as the drag downward', () => {
    // The gesture hands y over in press-then-pointer order, so an upward drag
    // arrives inverted; the session normalises. Nothing else may care.
    const up = vi.fn();
    const t = mount({ layers: scatter, onSelect: up });
    t.drag(t.pxAt(600), yPx(9), t.pxAt(100), yPx(1));
    const span = (up.mock.calls[0] as Call)[2]!;
    expect(span.x[0]).toBeCloseTo(100);
    expect(span.x[1]).toBeCloseTo(600);
    expect(span.y![0]).toBeCloseTo(1);
    expect(span.y![1]).toBeCloseTo(9);
  });

  it('a near-vertical drag arms on a 2-D layer — and does NOT on a 1-D one', () => {
    // The slop rule, stated as the difference it makes. |dx| is 3px, under
    // DRAG_SLOP; the drag crosses the whole plot vertically. A 1-D sweep
    // measures |dx| and correctly stays a click. A 2-D sweep measuring |dx|
    // would make the one gesture that moves only in y impossible to start,
    // so it measures the distance — and this pair is what tells them apart.
    const two = vi.fn();
    const t = mount({ layers: scatter, onSelect: two });
    const x = t.pxAt(150);
    t.drag(x, yPx(11), x + 3, yPx(1));
    expect(two).toHaveBeenCalledTimes(1);
    const span = (two.mock.calls[0] as Call)[2]!;
    expect(span.x[0]).toBeLessThanOrEqual(150);
    expect(span.x[1]).toBeGreaterThan(150);
    expect((two.mock.calls[0] as Call)[0].map((h) => h.value)).toEqual([2]);
    cleanup();

    const one = vi.fn();
    const b = mount({
      layers: <BarChart series={bars()} column="v" axis="a" id="b" />,
      onSelect: one,
    });
    b.drag(x, yPx(11), x + 3, yPx(1));
    expect(one).not.toHaveBeenCalled();
  });

  it('…and a still pointer is still a click, not a zero-area sweep', () => {
    const onSelect = vi.fn();
    const { surface } = mount({ layers: scatter, onSelect });
    act(() => surface.dispatchEvent(pointer('pointerdown', 40, 60, 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', 41, 61, 1)));
    act(() => surface.dispatchEvent(pointer('pointerup', 41, 61, 0)));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ── The heat map: snapped in both dimensions ────────────────────────────────

describe('a heat-map sweep snaps both dimensions', () => {
  const heat = (
    <HeatMap
      series={grid()}
      columns={['low', 'mid', 'high']}
      colors={['#eee', '#999', '#333']}
      axis="a"
      id="h"
    />
  );
  // Three rows over a 0..3 axis on a 120px row: 40px each, row 0 ('low') at
  // the bottom.
  const rowMid = (g: number) => ROW_H - (g + 0.5) * (ROW_H / 3);

  it('captures bins × rows, and names the rows rather than numbering them', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({
      layers: heat,
      axisMax: 3,
      onSelect,
    });
    // Two bins wide (150 and 250 → bins 1,2), clipping rows 0 and 1.
    drag(pxAt(150), rowMid(0), pxAt(250), rowMid(1));
    const [hits, , span] = onSelect.mock.calls[0] as Call;
    expect(hits.map((h) => h.value).sort((a, b) => a - b)).toEqual([
      10, 11, 20, 21,
    ]);
    expect(span).toEqual({
      kind: 'span',
      id: 'h',
      // x snapped outward to the bins' own edges…
      x: [100, 300],
      // …and y to whole rows, by NAME — so a re-ordered `columns` list cannot
      // silently repoint the selection at different data.
      rows: ['low', 'mid'],
    });
  });

  it('a rect inside one row captures that row only', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({ layers: heat, axisMax: 3, onSelect });
    drag(pxAt(150), rowMid(2) - 5, pxAt(350), rowMid(2) + 5);
    const [hits, , span] = onSelect.mock.calls[0] as Call;
    expect(span!.rows).toEqual(['high']);
    expect(hits.map((h) => h.label)).toEqual(['high', 'high', 'high']);
    expect(hits.map((h) => h.value)).toEqual([12, 22, 32]);
  });
});

// ── The brush: a rect, and only in the row that owns it ─────────────────────

describe('the 2-D brush', () => {
  const rects = (dom: HTMLElement) =>
    Array.from(dom.querySelectorAll('svg rect')).map((r) => ({
      w: Number(r.getAttribute('width')),
      h: Number(r.getAttribute('height')),
    }));

  it('a 2-D drag paints a rect that is NOT full row height; a 1-D drag paints a band that is', () => {
    // The band is container state, so it is drawn by every row from one
    // anchor — right for an x-range, wrong for a rect whose y only means
    // something against the axis it was measured on. The two must not both
    // appear, or a 2-D drag reads as a column with a box inside it.
    const two = mount({
      layers: <ScatterChart series={points()} column="v" axis="a" id="p" />,
    });
    two.dragTo(two.pxAt(100), yPx(2), two.pxAt(600), yPx(9));
    const drawn = rects(two.dom).filter((r) => r.w > 0 && r.h > 0);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((r) => r.h < ROW_H)).toBe(true);
    cleanup();

    const one = mount({
      layers: <BarChart series={bars()} column="v" axis="a" id="b" />,
    });
    one.dragTo(one.pxAt(100), yPx(2), one.pxAt(600), yPx(9));
    expect(rects(one.dom).some((r) => r.h === ROW_H && r.w > 0)).toBe(true);
  });

  it('the brush clears on release', () => {
    const t = mount({
      layers: <ScatterChart series={points()} column="v" axis="a" id="p" />,
    });
    t.dragTo(t.pxAt(100), yPx(2), t.pxAt(600), yPx(9));
    const held = rects(t.dom).filter((r) => r.w > 0 && r.h > 0).length;
    act(() =>
      t.surface.dispatchEvent(pointer('pointerup', t.pxAt(600), yPx(9), 0)),
    );
    const after = rects(t.dom).filter((r) => r.w > 0 && r.h > 0).length;
    expect(after).toBeLessThan(held);
  });
});
