import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { HeatMap } from '../src/HeatMap.js';
import { YAxis } from '../src/YAxis.js';
import { RangeCursor } from '../src/cursors.js';
import { categorySlots } from '../src/tracker.js';
import { stubCanvasContext } from './canvas-mock.js';

/**
 * [PND-ORDCURSOR] `<RangeCursor>` on a **category** axis. It used to draw
 * nothing there (its band was gated to a continuous x), so mounting one left
 * the row with no cursor at all. Now the band shades the slot under the
 * pointer, and the drag stays off — with a dev warning if `onDragRelease` is
 * wired, because that callback can never fire there.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WIDTH = 300;

const categories = [
  { label: 'alpha', value: 3 },
  { label: 'beta', value: 2 },
  { label: 'gamma', value: 1 },
];

function mount(layer: ReactNode, cursor: ReactNode) {
  const stub = stubCanvasContext();
  try {
    return render(
      <ChartContainer width={WIDTH} showAxis={false}>
        {cursor}
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} width={0} />
          <Layers>{layer}</Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;
  } finally {
    stub.restore();
  }
}

const surface = (c: HTMLElement) => c.querySelector('canvas')!.parentElement!;

/** The cursor band(s): full-row-height rects in the cursor overlay. */
const bands = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('svg rect')).map((r) => ({
    x: Number(r.getAttribute('x')),
    w: Number(r.getAttribute('width')),
  }));

describe('<RangeCursor> on a category axis', () => {
  it('shades the whole slot under the pointer', () => {
    const dom = mount(<BarChart categories={categories} />, <RangeCursor />);
    const plotWidth = surface(dom).getBoundingClientRect().width || WIDTH;
    const slot = plotWidth / 3;
    // Pointer a little right of the middle slot's left edge.
    fireEvent.pointerMove(surface(dom), {
      clientX: slot + 5,
      clientY: 50,
    });
    const b = bands(dom);
    expect(b).toHaveLength(1);
    expect(b[0]!.x).toBeCloseTo(slot, 6);
    expect(b[0]!.w).toBeCloseTo(slot, 6);
  });

  it('follows the pointer to the next slot', () => {
    const dom = mount(<BarChart categories={categories} />, <RangeCursor />);
    const plotWidth = surface(dom).getBoundingClientRect().width || WIDTH;
    const slot = plotWidth / 3;
    fireEvent.pointerMove(surface(dom), {
      clientX: 2 * slot + 10,
      clientY: 50,
    });
    expect(bands(dom)[0]!.x).toBeCloseTo(2 * slot, 6);
  });

  it('shades a slot on a category row with no bar layer (a heat map)', () => {
    // A horizontal heat map puts its columns on x as categories and
    // publishes no bar bins, so the slots come from the band scale.
    const T = (i: number) => Date.UTC(2026, 0, 1 + i);
    const grid = new TimeSeries({
      name: 'g',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'lo', kind: 'number' },
        { name: 'hi', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 3 }, (_, i) => [
        [T(i), T(i + 1)],
        i + 1,
        i + 2,
      ]) as [[number, number], number, number][],
    });
    const dom = mount(
      <HeatMap
        series={grid}
        columns={['lo', 'hi']}
        colors={['#eee', '#999']}
        orientation="horizontal"
      />,
      <RangeCursor />,
    );
    const plotWidth = surface(dom).getBoundingClientRect().width || WIDTH;
    fireEvent.pointerMove(surface(dom), {
      clientX: plotWidth / 2 + 5,
      clientY: 50,
    });
    const b = bands(dom);
    expect(b).toHaveLength(1);
    expect(b[0]!.x).toBeCloseTo(plotWidth / 2, 6);
    expect(b[0]!.w).toBeCloseTo(plotWidth / 2, 6);
  });

  it('never fires onDragRelease, and warns once that the drag is off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onDragRelease = vi.fn();
    const dom = mount(
      <BarChart categories={categories} />,
      <RangeCursor onDragRelease={onDragRelease} />,
    );
    fireEvent.pointerDown(surface(dom), { clientX: 20, clientY: 50 });
    fireEvent.pointerMove(surface(dom), { clientX: 250, clientY: 50 });
    fireEvent.pointerUp(surface(dom), { clientX: 250, clientY: 50 });
    expect(onDragRelease).not.toHaveBeenCalled();
    const ours = warn.mock.calls.filter((c) =>
      String(c[0]).includes('<RangeCursor onDragRelease>'),
    );
    expect(ours).toHaveLength(1);
  });

  it('does not warn without onDragRelease', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(<BarChart categories={categories} />, <RangeCursor />);
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes('<RangeCursor onDragRelease>'),
      ),
    ).toBe(false);
  });
});

describe('categorySlots', () => {
  it('one unit slot per category, from the band domain', () => {
    expect(categorySlots([0, 3]).map((s) => [s.begin(), s.end()])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('empty for an empty axis', () => {
    expect(categorySlots([0, 0])).toEqual([]);
  });
});
