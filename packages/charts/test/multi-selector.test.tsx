/**
 * `<MultiSelector>` — sweep-select as a mounted component (interaction RFC §8
 * / A4.2 / A5.2), on the single brush recognizer (RFC A1.5 / A2.7).
 *
 * These tests drive the REAL components through pointer events on the plot
 * surface — the wiring level of the two-level verification (the pure session
 * is pinned in `sweep.test.ts`) — because on the last three PRs of this wave
 * the wiring mutation caught more defects than the helper mutation.
 *
 * `requestAnimationFrame` is replaced with a manual queue so the
 * frame-coalesced live preview (RFC A1.4) is deterministic: `flushFrames()`
 * runs exactly the frames the gesture scheduled.
 */
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Sequence, TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { MultiSelector } from '../src/selectors.js';
import { RangeCursor } from '../src/cursors.js';
import { resolveBrushClaim } from '../src/brush.js';
import { selectionContains } from '../src/span.js';
import {
  ContainerContext,
  type ContainerFrame,
  type SelectInfo,
  type SelectModifiers,
  type SelectionEntry,
  type SpanSelection,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

// ── A deterministic animation-frame queue ────────────────────────────────────
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
afterEach(() => {
  vi.unstubAllGlobals();
});
/** Run every scheduled frame (and any it schedules) to quiescence. */
function flushFrames() {
  act(() => {
    while (rafQueue.length > 0) {
      const q = rafQueue;
      rafQueue = [];
      for (const cb of q) cb(0);
    }
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Ten interval-keyed bars, bar i spanning [i·100, (i+1)·100) with value i+1 —
 *  so which marks a sweep covered is arithmetic, not archaeology. */
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

const line = () =>
  new TimeSeries({
    name: 'l',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [500, 5],
      [1000, 9],
    ] as [number, number][],
  });

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

// Pointer y: inside every fixture bar's INK (values 1..10 on a 0..12 axis over
// a 120px row put the shortest bar's top at y=110). A click resolves through
// the 'select' hit-test, which — unlike hover's full-height slot — requires
// the pointer within the bar's drawn ink, so genuinely empty plot space stays
// the deselect path.
const POINTER_Y = 115;

function pointer(
  type: string,
  x: number,
  buttons: number,
  init: PointerEventInit = {},
): Event {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: POINTER_Y,
    buttons,
    ...init,
  });
}

/** Mount a one-row chart over `range` with the given container children and
 *  row layers; returns the plot surface, the live frame, and px helpers. */
function mount(opts: {
  children?: ReactNode;
  layers?: ReactNode;
  props?: Record<string, unknown>;
  range?: readonly [number, number];
}) {
  const { children, layers, props = {}, range = [0, 1000] } = opts;
  let frame: ContainerFrame | null = null;
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    const res = render(
      <ChartContainer range={range} width={320} {...props}>
        {children}
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={12} />
          <Layers>
            {layers ?? <BarChart series={bars()} column="v" axis="a" id="b" />}
          </Layers>
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
  /** Axis units → plot px (the container's own scale). */
  const pxAt = (t: number) =>
    ((t - range[0]) / (range[1] - range[0])) * f().plotWidth;
  /** Down → move → up at plot px, paced (flush between events). */
  const drag = (x0: number, x1: number, init?: PointerEventInit) => {
    act(() => surface.dispatchEvent(pointer('pointerdown', x0, 1, init)));
    act(() => surface.dispatchEvent(pointer('pointermove', x1, 1, init)));
    act(() => surface.dispatchEvent(pointer('pointerup', x1, 0, init)));
  };
  /** A real plot click at px (pointer pair + the click event). */
  const click = (x: number, init: PointerEventInit = {}) => {
    act(() => surface.dispatchEvent(pointer('pointerdown', x, 1, init)));
    act(() => surface.dispatchEvent(pointer('pointerup', x, 0, init)));
    act(() =>
      surface.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: POINTER_Y,
          ...init,
        }),
      ),
    );
  };
  return { surface, frame: f, pxAt, drag, click, dom };
}

// ── The sweep: release reports (hits, modifiers, span) — RFC A5.2 ───────────

describe('<MultiSelector> sweep — the release payload', () => {
  it('fires once with the covered marks, the modifiers, and the snapped-outward span', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    // Sweep from inside bar 1 to inside bar 3 → bars 1..3 (bin-snapped: the
    // bars' own binIntervals feed the shared snap channel).
    drag(pxAt(150), pxAt(350));

    expect(onSelect).toHaveBeenCalledTimes(1);
    const [hits, modifiers, span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection | null,
    ];
    expect(hits.map((h) => h.value)).toEqual([2, 3, 4]);
    expect(hits.every((h) => h.id === 'b')).toBe(true);
    expect(modifiers.additive).toBe(false);
    // The span: the covered marks' snapped-outward extent (RFC A7.6).
    expect(span).toEqual({ kind: 'span', id: 'b', x: [100, 400] });
  });

  it('the span round-trips: selectionContains agrees with the committed hits exactly', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    drag(pxAt(150), pxAt(350));
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection,
    ];
    const sel: readonly SelectionEntry[] = [span];
    for (const h of hits) expect(selectionContains(sel, h)).toBe(true);
    // The neighbours on either side of the sweep are outside — the edge rule.
    const neighbour = (key: number, value: number): SelectInfo => ({
      id: 'b',
      key,
      value,
      color: '#000',
      label: 'v',
    });
    expect(selectionContains(sel, neighbour(0, 1))).toBe(false);
    expect(selectionContains(sel, neighbour(400, 5))).toBe(false);
  });

  it('a right-to-left sweep covers the same marks', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    drag(pxAt(350), pxAt(150));
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection,
    ];
    expect(hits.map((h) => h.value)).toEqual([2, 3, 4]);
    expect(span.x).toEqual([100, 400]);
  });

  it('reports the modifiers held at release (⌘ → additive)', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    drag(pxAt(150), pxAt(350), { metaKey: true });
    const [, modifiers] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
    ];
    expect(modifiers.additive).toBe(true);
    expect(modifiers.metaKey).toBe(true);
  });

  it('a batched down→move→up (no flush between events) still commits — the #508-item-7 discipline', () => {
    const onSelect = vi.fn();
    const { surface, pxAt, frame } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    act(() => {
      surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1));
      surface.dispatchEvent(pointer('pointermove', pxAt(350), 1));
      surface.dispatchEvent(pointer('pointerup', pxAt(350), 0));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [hits] = onSelect.mock.calls[0]! as [readonly SelectInfo[]];
    expect(hits.map((h) => h.value)).toEqual([2, 3, 4]);
    expect(frame().regionAnchor).toBeNull();
  });

  it('uncontrolled, the committed span IS the selection — the swept bars stay lit', () => {
    const { drag, pxAt, frame } = mount({
      children: <MultiSelector />,
    });
    drag(pxAt(150), pxAt(350));
    expect(frame().selectedSpans).toEqual([
      { kind: 'span', id: 'b', x: [100, 400] },
    ]);
    expect(frame().selected).toEqual([]);
  });

  it('the band reverts on release (the anchor clears), as the range drag does', () => {
    const { drag, pxAt, frame } = mount({
      children: <MultiSelector />,
    });
    drag(pxAt(150), pxAt(350));
    expect(frame().regionAnchor).toBeNull();
  });
});

// ── The live preview — plural hovered, frame-coalesced (RFC A1.4 / A3.4) ────

describe('the live preview', () => {
  it('lights every covered mark through plural hovered — synchronously on the move that commits', () => {
    const onHover = vi.fn();
    const { surface, pxAt, frame } = mount({
      children: <MultiSelector onHover={onHover} />,
    });
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    // The move that COMMITS the sweep cuts synchronously — the covered set
    // lights in the same event turn the band appears, no frame in between
    // (a bucket-snapped sweep must light its whole first bucket from the
    // moment the drag starts).
    expect(frame().hovered.map((h) => h.value)).toEqual([2, 3, 4]);
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(
      (onHover.mock.calls[0]![0] as readonly SelectInfo[]).map((h) => h.value),
    ).toEqual([2, 3, 4]);
    // No frame was left pending for the commit cut.
    flushFrames();
    expect(onHover).toHaveBeenCalledTimes(1);
    act(() => surface.dispatchEvent(pointer('pointerup', pxAt(350), 0)));
  });

  it('moves after the commit coalesce into one frame — one preview, at the final window', () => {
    const onHover = vi.fn();
    const { surface, pxAt } = mount({
      children: <MultiSelector onHover={onHover} />,
    });
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(250), 1)));
    // The commit move reported synchronously (bars 1..2)…
    expect(onHover).toHaveBeenCalledTimes(1);
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(550), 1)));
    // …and the two moves after it coalesced into ONE frame at the final
    // window (RFC A1.4).
    flushFrames();
    expect(onHover).toHaveBeenCalledTimes(2);
    expect(
      (onHover.mock.calls[1]![0] as readonly SelectInfo[]).map((h) => h.value),
    ).toEqual([2, 3, 4, 5, 6]);
    act(() => surface.dispatchEvent(pointer('pointerup', pxAt(550), 0)));
  });

  it('an unflushed frame does not stale the release — the final cut is synchronous', () => {
    const onSelect = vi.fn();
    const { surface, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(250), 1)));
    flushFrames(); // preview at bars 1..2
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    // The last move's frame never runs; release must still see bar 3.
    act(() => surface.dispatchEvent(pointer('pointerup', pxAt(350), 0)));
    const [hits] = onSelect.mock.calls[0]! as [readonly SelectInfo[]];
    expect(hits.map((h) => h.value)).toEqual([2, 3, 4]);
  });

  it('the preview clears on release — hover state does not linger', () => {
    const { surface, pxAt, frame } = mount({
      children: <MultiSelector />,
    });
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    flushFrames();
    expect(frame().hovered.length).toBeGreaterThan(0);
    act(() => surface.dispatchEvent(pointer('pointerup', pxAt(350), 0)));
    expect(frame().hovered).toEqual([]);
  });

  it('a sweep whose press ended unseen (buttons gone) cancels: no commit, preview un-lit, band cleared', () => {
    const onSelect = vi.fn();
    const { surface, pxAt, frame } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    flushFrames();
    expect(frame().hovered.length).toBeGreaterThan(0);
    // The pointerup fired off-plot and never reached us; the next move
    // arrives with no buttons — the same stale-press net dragRef has.
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(400), 0)));
    expect(onSelect).not.toHaveBeenCalled();
    // The multi-mark preview is gone; the move fell through to ordinary
    // pointer hover (at most the one mark under the pointer).
    expect(frame().hovered.length).toBeLessThanOrEqual(1);
    expect(frame().regionAnchor).toBeNull();
  });

  it('mid-sweep the shared brush band renders even with no cursor mounted (§8.1)', () => {
    const { surface, pxAt, dom, frame } = mount({
      children: <MultiSelector />,
    });
    expect(dom.querySelector('svg rect')).toBeNull();
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    expect(frame().regionAnchor).not.toBeNull();
    expect(dom.querySelector('svg rect')).not.toBeNull();
    act(() => surface.dispatchEvent(pointer('pointerup', pxAt(350), 0)));
    expect(dom.querySelector('svg rect')).toBeNull();
  });

  it('a live sweep suppresses the data cursor — the band shows, not a line over it', () => {
    // With no cursor mounted the deprecation shim's default `line` preset is
    // in effect, and it kept painting its solid vertical rule at the raw
    // pointer OVER the brush band for the whole drag — the sweep read as "a
    // line", not as the region being swept. A live sweep now suppresses the
    // row's cursor slots exactly as annotation editing does; the shared band
    // still renders (the assertion above), so the sweep looks like a
    // <RangeCursor> drag (§8.1's identical pixels).
    const { surface, pxAt, dom } = mount({
      children: <MultiSelector />,
    });
    const cursorLines = () =>
      Array.from(dom.querySelectorAll('svg line')).filter(
        (l) => l.getAttribute('stroke') === '#64748b', // the cursor ink
      );
    // Plain hover: the default line cursor draws its rule.
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(150), 0)));
    expect(cursorLines().length).toBeGreaterThan(0);
    // Mid-sweep: the band is up, the cursor rule is gone.
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    expect(dom.querySelector('svg rect')).not.toBeNull();
    expect(cursorLines()).toHaveLength(0);
    // Release: the cursor comes back with ordinary hover.
    act(() => surface.dispatchEvent(pointer('pointerup', pxAt(350), 0)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(500), 0)));
    expect(cursorLines().length).toBeGreaterThan(0);
  });
});

// ── The deselect path: a click above the ink resolves to NO mark ────────────

describe('click-deselect (RFC §7 — the empty commit must be reachable)', () => {
  it('a click in the empty space above a bar deselects: ([], modifiers, null)', () => {
    // Bar slots tile the whole plot (full interval width, full height — the
    // continuous hover model of #582), so before this fix a click could
    // NEVER resolve to null on a full-range bar chart: "click away to
    // clear" had nowhere to click. The select hit-test now narrows to the
    // bar's drawn ink vertically; hover keeps the full slot.
    const onSelect = vi.fn();
    const { surface, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    // Bar 1's value is 2 → its ink tops out at y=100 of 120. Click at y=20,
    // well above the ink but inside the slot.
    const x = pxAt(150);
    const up = { clientY: 20 } as PointerEventInit;
    act(() => surface.dispatchEvent(pointer('pointerdown', x, 1, up)));
    act(() => surface.dispatchEvent(pointer('pointerup', x, 0, up)));
    act(() =>
      surface.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: 20,
        }),
      ),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection | null,
    ];
    expect(hits).toEqual([]);
    expect(span).toBeNull();
  });

  it('hover at the same point still reports the bar — the slot stays continuous (#582)', () => {
    // The asymmetry is deliberate: hover is a reading affordance (the
    // highlight tracks like the readout, no dead zones), a click is a
    // commitment (and its null is the deselect signal).
    const onHover = vi.fn();
    const { surface, pxAt } = mount({
      children: <MultiSelector onHover={onHover} />,
    });
    act(() =>
      surface.dispatchEvent(
        pointer('pointermove', pxAt(150), 0, { clientY: 20 }),
      ),
    );
    expect(onHover).toHaveBeenCalledTimes(1);
    const hits = onHover.mock.calls[0]![0] as readonly SelectInfo[];
    expect(hits.length).toBe(1);
    expect(hits[0]!.value).toBe(2);
  });

  it('a click in the gap between two bars still selects — the gap is not a dead channel', () => {
    // #582's fix survives on the x axis: the slot spans the bar's full
    // interval, so a click landing between two columns (at ink height)
    // selects the bar whose slot it is in rather than deselecting.
    const onSelect = vi.fn();
    const { surface, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
      props: { selected: [] },
    });
    // Exactly on the bar 1 / bar 2 boundary, at a y inside both bars' ink.
    const x = pxAt(200);
    act(() => surface.dispatchEvent(pointer('pointerdown', x, 1)));
    act(() => surface.dispatchEvent(pointer('pointerup', x, 0)));
    act(() =>
      surface.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: POINTER_Y,
        }),
      ),
    );
    const [hits] = onSelect.mock.calls[0]! as [readonly SelectInfo[]];
    expect(hits.length).toBe(1);
  });
});

// ── A click is still a click — <MultiSelector> is a superset of <Selector> ──

describe('click-select through <MultiSelector> (§8.1 — separated by movement)', () => {
  it('a click (no movement) selects ONE mark: ([hit], modifiers, null)', () => {
    const onSelect = vi.fn();
    const { click, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    click(pxAt(150));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [hits, modifiers, span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection | null,
    ];
    expect(hits.length).toBe(1);
    expect(hits[0]!.value).toBe(2);
    expect(modifiers.additive).toBe(false);
    expect(span).toBeNull();
  });

  it('a sub-slop wobble is still a click, not a one-bar sweep', () => {
    const onSelect = vi.fn();
    const { surface, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
    });
    const x = pxAt(150);
    act(() => surface.dispatchEvent(pointer('pointerdown', x, 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', x + 3, 1)));
    act(() => surface.dispatchEvent(pointer('pointerup', x + 3, 0)));
    act(() =>
      surface.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x + 3,
          clientY: POINTER_Y,
        }),
      ),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection | null,
    ];
    expect(hits.length).toBe(1);
    expect(span).toBeNull();
  });

  it('a click that hits nothing reports ([], modifiers, null) — the deselect path', () => {
    const onSelect = vi.fn();
    const { click, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
      range: [0, 2000], // data ends at 1000 — the right half is empty space
    });
    click(pxAt(1500));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection | null,
    ];
    expect(hits).toEqual([]);
    expect(span).toBeNull();
  });

  it('mounting <MultiSelector> arms the plot click (§7.1) — the uncontrolled highlight commits', () => {
    const { click, pxAt, frame } = mount({ children: <MultiSelector /> });
    expect(frame().selected).toEqual([]);
    click(pxAt(150));
    expect(frame().selected.length).toBe(1);
    expect(frame().selected[0]!.value).toBe(2);
  });

  it('pointer hover reports through onHover in the plural currency (0/1 hits)', () => {
    const onHover = vi.fn();
    const { surface, pxAt } = mount({
      children: <MultiSelector onHover={onHover} />,
    });
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(150), 0)));
    expect(onHover).toHaveBeenCalledTimes(1);
    const hits = onHover.mock.calls[0]![0] as readonly SelectInfo[];
    expect(hits.length).toBe(1);
    expect(hits[0]!.value).toBe(2);
  });
});

// ── The claim: what the sweep preempts, and where it yields ─────────────────

describe('the brush claim (RFC A1.5 / A2.7 — precedence)', () => {
  it('the sweep preempts pan: a drag under <MultiSelector> selects, the view stays put', () => {
    const onSelect = vi.fn();
    const onTimeRangeChange = vi.fn();
    const { drag, pxAt } = mount({
      children: <MultiSelector onSelect={onSelect} />,
      props: { panZoom: 'pan', onTimeRangeChange },
    });
    drag(pxAt(350), pxAt(150));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onTimeRangeChange).not.toHaveBeenCalled();
  });

  it('the sweep shadows a drag-enabled <RangeCursor> in the same scope — and dev-warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const onSelect = vi.fn();
      const onDragRelease = vi.fn();
      const { drag, pxAt } = mount({
        children: (
          <>
            <RangeCursor onDragRelease={onDragRelease} />
            <MultiSelector onSelect={onSelect} />
          </>
        ),
      });
      drag(pxAt(150), pxAt(350));
      drag(pxAt(150), pxAt(350));
      expect(onSelect).toHaveBeenCalledTimes(2);
      expect(onDragRelease).not.toHaveBeenCalled();
      const shadow = warn.mock.calls.filter((c) =>
        /the sweep claims the drag/.test(String(c[0])),
      );
      expect(shadow.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('with NO sweep-capable layer in the row, the sweep never claims — pan keeps the drag', () => {
    const onSelect = vi.fn();
    const onTimeRangeChange = vi.fn();
    const { drag } = mount({
      children: <MultiSelector onSelect={onSelect} />,
      layers: <LineChart series={line()} column="v" axis="a" />,
      props: { panZoom: 'pan', onTimeRangeChange },
    });
    drag(200, 60);
    expect(onTimeRangeChange).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('resolveBrushClaim: sweep outranks the range drag and pan, create outranks the sweep', () => {
    const noopDrag = { release: () => {}, modifier: undefined } as const;
    const base = {
      creating: false,
      drag: noopDrag,
      shiftKey: false,
      panEnabled: true,
      canPan: true,
    };
    expect(resolveBrushClaim({ ...base, sweep: true }).kind).toBe('sweep');
    expect(resolveBrushClaim({ ...base, sweep: false }).kind).toBe('range');
    expect(
      resolveBrushClaim({ ...base, sweep: true, creating: true }).kind,
    ).toBe('create');
    expect(resolveBrushClaim({ ...base, sweep: true, drag: null }).kind).toBe(
      'sweep',
    );
  });
});

// ── Snapping ─────────────────────────────────────────────────────────────────

describe('sequence snapping', () => {
  const DAY = 86_400_000;
  const D0 = Date.UTC(2026, 0, 5);
  const D1 = D0 + 5 * DAY;

  /** Four 6h bars per day over 5 days — a sweep snapped to days must capture
   *  whole days of bars, including ones the raw drag never touched. */
  const sixHourBars = () =>
    new TimeSeries({
      name: 'q',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 20 }, (_, i) => [
        [D0 + i * (DAY / 4), D0 + (i + 1) * (DAY / 4)],
        i + 1,
      ]) as [[number, number], number][],
    });

  it('<MultiSelector sequence> extends the sweep bucket by bucket — whole days of bars', () => {
    const onSelect = vi.fn();
    const { drag, pxAt } = mount({
      children: (
        <MultiSelector
          sequence={Sequence.calendar('day')}
          onSelect={onSelect}
        />
      ),
      layers: <BarChart series={sixHourBars()} column="v" axis="a" id="q" />,
      range: [D0, D1],
    });
    // Drag from midday day 1 to midday day 2 → the snapped window is
    // [D0+1d, D0+3d): all EIGHT bars of days 1–2, not the 5 the raw drag hit.
    drag(pxAt(D0 + 1.5 * DAY), pxAt(D0 + 2.5 * DAY));
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection,
    ];
    expect(hits.map((h) => h.value)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(span.x).toEqual([D0 + 1 * DAY, D0 + 3 * DAY]);
  });

  it('the PREVIEW snaps identically — the whole bucket lights from the moment the drag starts', () => {
    // The preview and the commit must never disagree: from the first
    // over-slop move (which cuts synchronously — no animation frame in
    // between) the covered set is the snapped bucket's WHOLE bar set, not
    // the bars under the raw drag span. Release then commits exactly what
    // was lit.
    const onHover = vi.fn();
    const onSelect = vi.fn();
    const { surface, pxAt, frame } = mount({
      children: (
        <MultiSelector
          sequence={Sequence.calendar('day')}
          onHover={onHover}
          onSelect={onSelect}
        />
      ),
      layers: <BarChart series={sixHourBars()} column="v" axis="a" id="q" />,
      range: [D0, D1],
    });
    act(() =>
      surface.dispatchEvent(pointer('pointerdown', pxAt(D0 + 1.4 * DAY), 1)),
    );
    // A tiny move — past the slop, still inside day 1's SECOND bar.
    act(() =>
      surface.dispatchEvent(pointer('pointermove', pxAt(D0 + 1.55 * DAY), 1)),
    );
    // Synchronous, and the whole of day 1 — all four bars, including the two
    // the raw 0.15-day drag never touched.
    expect(frame().hovered.map((h) => h.value)).toEqual([5, 6, 7, 8]);
    // Release right there: the commit is exactly the preview.
    act(() =>
      surface.dispatchEvent(pointer('pointerup', pxAt(D0 + 1.55 * DAY), 0)),
    );
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection,
    ];
    expect(hits.map((h) => h.value)).toEqual([5, 6, 7, 8]);
    expect(span.x).toEqual([D0 + 1 * DAY, D0 + 2 * DAY]);
  });

  it('a category axis sweeps the same gesture — the PND-CATRANGE fold-in (RFC §8)', () => {
    const onSelect = vi.fn();
    const categories = [
      { label: 'api', value: 3 },
      { label: 'auth', value: 2 },
      { label: 'cache', value: 1 },
      { label: 'db', value: 4 },
      { label: 'queue', value: 2 },
    ];
    const { drag, frame } = mount({
      children: <MultiSelector onSelect={onSelect} />,
      layers: <BarChart categories={categories} id="svc" />,
    });
    // Slots are unit-wide over [0, 5]; sweep from inside slot 1 to inside
    // slot 3 (slot centres — the band scale's invert snaps there anyway).
    const pxSlot = (v: number) => (v / 5) * frame().plotWidth;
    drag(pxSlot(1.5), pxSlot(3.5));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [hits, , span] = onSelect.mock.calls[0]! as [
      readonly SelectInfo[],
      SelectModifiers,
      SpanSelection,
    ];
    expect(hits.map((h) => h.label)).toEqual(['auth', 'cache', 'db']);
    expect(hits.map((h) => h.mark)).toEqual(['auth', 'cache', 'db']);
    // The span is in slot units — snapped outward to the covered slots.
    expect(span).toEqual({ kind: 'span', id: 'svc', x: [1, 4] });
    // And it round-trips through the exported predicate, mark identity intact.
    for (const h of hits) expect(selectionContains([span], h)).toBe(true);
  });

  it('the category sweep BAND snaps to the slots’ outer edges, not centre-to-centre (A7.6)', () => {
    // The band scale's `invert` snaps a pixel to the slot CENTRE, so with no
    // snap buckets the drawn band ran centre-to-centre — while capture and
    // the committed span snapped outward to the covered slots' outer edges
    // (the A7.6 edge rule). The drawn band and the committed selection
    // disagreed at both ends by half a slot. The categorical layer now
    // publishes its unit slots as snap buckets, so the band extends
    // slot-edge to slot-edge — exactly the extent release will commit.
    const categories = [
      { label: 'api', value: 3 },
      { label: 'auth', value: 2 },
      { label: 'cache', value: 1 },
      { label: 'db', value: 4 },
      { label: 'queue', value: 2 },
    ];
    const { surface, frame, dom } = mount({
      children: <MultiSelector />,
      layers: <BarChart categories={categories} id="svc" />,
    });
    const w = frame().plotWidth;
    const pxSlot = (v: number) => (v / 5) * w;
    act(() => surface.dispatchEvent(pointer('pointerdown', pxSlot(1.5), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxSlot(3.5), 1)));
    const band = dom.querySelector('svg rect')!;
    expect(band).not.toBeNull();
    // Outer edge of slot 1 to outer edge of slot 3: x = w/5, width = 3w/5.
    expect(Number(band.getAttribute('x'))).toBeCloseTo(pxSlot(1), 6);
    expect(Number(band.getAttribute('width'))).toBeCloseTo(
      pxSlot(4) - pxSlot(1),
      6,
    );
    act(() => surface.dispatchEvent(pointer('pointerup', pxSlot(3.5), 0)));
  });
});

// ── A5.2's demote-on-edit worked example, driven end to end ─────────────────

describe('demote on edit (RFC A5.2) — sweep, then ⌘-click one out', () => {
  it('the consumer swaps the span for its stashed hits and filters — plain array arithmetic', () => {
    // The terminal case from A5.1(b): sweep a session of bars, then knock an
    // outlier out of the selection. The consumer policy is exactly what the
    // RFC sketches: on a sweep store the span (and stash the hits); on an
    // additive click inside it, demote the span to the stashed marks minus
    // the clicked one.
    let stashed: readonly SelectInfo[] = [];
    let latest: readonly SelectionEntry[] = [];
    function Harness() {
      const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
      latest = sel;
      return (
        <ChartContainer range={[0, 1000]} width={320} selected={sel}>
          <MultiSelector
            onSelect={(hits, mods, span) => {
              if (span !== null) {
                stashed = hits;
                setSel([span]);
                return;
              }
              const hit = hits[0] ?? null;
              if (hit === null) {
                setSel([]);
                return;
              }
              if (mods?.additive && selectionContains(latest, hit)) {
                // Demote: the span becomes its marks, minus the clicked one.
                setSel(stashed.filter((m) => m.key !== hit.key));
                return;
              }
              setSel([hit]);
            }}
          />
          <ChartRow height={120}>
            <YAxis id="a" min={0} max={12} />
            <Layers>
              <BarChart series={bars()} column="v" axis="a" id="b" />
            </Layers>
          </ChartRow>
        </ChartContainer>
      );
    }
    const stub = stubCanvasContext();
    let dom: HTMLElement;
    try {
      dom = render(<Harness />).container;
    } finally {
      stub.restore();
    }
    const surface = dom.querySelector('canvas')!.parentElement!;
    // Plot px for axis t: the plot div carries its resolved width inline
    // (this harness owns its own container, so there is no captured frame).
    const w = Number.parseFloat((surface as HTMLElement).style.width);
    const pxAt = (t: number) => (t / 1000) * w;

    // 1. Sweep bars 1..3 → the selection is one span entry.
    act(() => surface.dispatchEvent(pointer('pointerdown', pxAt(150), 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', pxAt(350), 1)));
    act(() => surface.dispatchEvent(pointer('pointerup', pxAt(350), 0)));
    expect(latest).toEqual([{ kind: 'span', id: 'b', x: [100, 400] }]);
    expect(stashed.map((h) => h.value)).toEqual([2, 3, 4]);

    // 2. ⌘-click the middle bar → the span demotes to marks minus that bar.
    const cx = pxAt(250);
    act(() =>
      surface.dispatchEvent(pointer('pointerdown', cx, 1, { metaKey: true })),
    );
    act(() =>
      surface.dispatchEvent(pointer('pointerup', cx, 0, { metaKey: true })),
    );
    act(() =>
      surface.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: POINTER_Y,
          metaKey: true,
        }),
      ),
    );
    expect(latest.map((e) => (e as SelectInfo).value)).toEqual([2, 4]);
    // The demoted selection answers membership the way the RFC promises:
    // swept-then-removed is out, swept-and-kept is in.
    const probe = (key: number, value: number): SelectInfo => ({
      id: 'b',
      key,
      value,
      color: '#000',
      label: 'v',
    });
    expect(selectionContains(latest, probe(100, 2))).toBe(true);
    expect(selectionContains(latest, probe(200, 3))).toBe(false);
    expect(selectionContains(latest, probe(300, 4))).toBe(true);
  });
});
