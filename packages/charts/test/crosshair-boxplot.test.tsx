import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { CrosshairCursor, PointCursor } from '../src/cursors.js';
import type { CursorSnap } from '../src/context.js';

afterEach(cleanup);

/**
 * [PND-BOXPLT] The crosshair **snaps to box plots**. A box used to be left out
 * of both halves of the snap: the vertical line ignored it (so it sat wherever
 * the pointer was), and the reticle had nothing to land on (so no value pill
 * and no `onSnap`). Now the vertical line lands on the box centre and the
 * horizontal line on the quantile nearest the pointer.
 */

// Box 0 spans [0, 10], box 1 spans [10, 20]. Quantiles miss the axis ticks.
const boxes = new TimeSeries({
  name: 'b',
  schema: [
    { name: 'timeRange', kind: 'timeRange' },
    { name: 'lo', kind: 'number' },
    { name: 'q1', kind: 'number' },
    { name: 'med', kind: 'number' },
    { name: 'q3', kind: 'number' },
    { name: 'hi', kind: 'number' },
  ] as const,
  rows: [
    [[0, 10], 11, 22, 33, 57, 88],
    [[10, 20], 5, 15, 25, 35, 45],
  ] as never,
});

const WIDTH = 300;
const AXIS_W = 40;
const PLOT_W = WIDTH - AXIS_W; // 260px over [0, 20] ⇒ 13px per unit
const HEIGHT = 100; // [0, 100] axis ⇒ py = 100 - value

const px = (t: number) => (t / 20) * PLOT_W;

function chart(
  cursor: ReactNode,
  extra?: ReactNode,
  range: [number, number] = [0, 20],
) {
  return (
    <ChartContainer range={range} width={WIDTH} showAxis={false}>
      {cursor}
      <ChartRow height={HEIGHT}>
        <Layers>
          <BoxPlot
            series={boxes}
            lower="lo"
            q1="q1"
            median="med"
            q3="q3"
            upper="hi"
            axis="v"
          />
          {extra}
        </Layers>
        <YAxis id="v" side="right" width={AXIS_W} min={0} max={100} />
      </ChartRow>
    </ChartContainer>
  );
}

const surface = (c: HTMLElement) => c.querySelector('canvas')!.parentElement!;

/** The reticle's vertical line x (the crosshair's full-height line). */
function verticalX(c: HTMLElement): number | null {
  const v = Array.from(c.querySelectorAll('svg line')).find(
    (l) =>
      l.getAttribute('x1') === l.getAttribute('x2') &&
      Number(l.getAttribute('y2')) - Number(l.getAttribute('y1')) === HEIGHT,
  );
  return v ? Number(v.getAttribute('x1')) : null;
}

describe('the crosshair on a box plot', () => {
  it('lands its vertical line on the box centre, not the pointer', () => {
    const { container } = render(chart(<CrosshairCursor />));
    // t = 2, inside box 0 ([0, 10]) — well left of its centre (5).
    fireEvent.pointerMove(surface(container), {
      clientX: px(2),
      clientY: 50,
    });
    expect(verticalX(container)).toBe(Math.round(px(5)));
  });

  it('snaps to the quantile nearest the pointer and reports it', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(
      chart(<CrosshairCursor onSnap={(s) => calls.push(s)} />),
    );
    // Near the top (y = 10 ⇒ value 90) ⇒ `hi` = 88.
    fireEvent.pointerMove(surface(container), { clientX: px(2), clientY: 10 });
    // Near value 55 ⇒ `q3` = 57.
    fireEvent.pointerMove(surface(container), { clientX: px(2), clientY: 45 });
    // Near the bottom (value 10) ⇒ `lo` = 11.
    fireEvent.pointerMove(surface(container), { clientX: px(2), clientY: 90 });
    expect(calls.map((s) => s && [s.label, s.value, s.x])).toEqual([
      ['hi', 88, 5],
      ['q3', 57, 5],
      ['lo', 11, 5],
    ]);
    expect(calls.every((s) => s?.axisId === 'v')).toBe(true);
  });

  it('pins the snapped quantile to the y axis', () => {
    const { container, getByText } = render(chart(<CrosshairCursor />));
    fireEvent.pointerMove(surface(container), { clientX: px(2), clientY: 45 });
    expect(getByText('57')).toBeTruthy();
    // The horizontal line sits at the quantile, not the pointer.
    const h = Array.from(container.querySelectorAll('svg line')).find(
      (l) => l.getAttribute('y1') === l.getAttribute('y2'),
    );
    expect(Number(h!.getAttribute('y1'))).toBeCloseTo(HEIGHT - 57, 0);
  });

  it('follows the pointer into the next box', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(
      chart(<CrosshairCursor onSnap={(s) => calls.push(s)} />),
    );
    fireEvent.pointerMove(surface(container), { clientX: px(12), clientY: 55 });
    expect(verticalX(container)).toBe(Math.round(px(15)));
    expect(calls.at(-1)).toMatchObject({ label: 'hi', value: 45, x: 15 });
  });

  it('reports nothing past the last box', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(
      chart(
        <CrosshairCursor onSnap={(s) => calls.push(s)} />,
        undefined,
        [0, 30],
      ),
    );
    // 260px over [0, 30]: t = 25 is past box 1's end (20).
    fireEvent.pointerMove(surface(container), {
      clientX: (25 / 30) * PLOT_W,
      clientY: 50,
    });
    expect(calls.at(-1) ?? null).toBeNull();
  });

  it('picks between a box and a line in the same row by height', () => {
    const line = new TimeSeries({
      name: 'l',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 96],
        [5, 96],
        [20, 96],
      ] as [number, number][],
    });
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(
      chart(
        <CrosshairCursor onSnap={(s) => calls.push(s)} />,
        <LineChart series={line} column="v" as="line" axis="v" />,
      ),
    );
    // Top of the row ⇒ the line (96) beats the box's `hi` (88).
    fireEvent.pointerMove(surface(container), { clientX: px(5), clientY: 2 });
    // Lower ⇒ the box's median (33).
    fireEvent.pointerMove(surface(container), { clientX: px(5), clientY: 68 });
    expect(calls.map((s) => s && s.label)).toEqual(['line', 'med']);
  });
});

describe('per-series cursors still leave a box to its own flag', () => {
  it('<PointCursor> draws no per-quantile dots on a box', () => {
    const { container } = render(chart(<PointCursor />));
    fireEvent.pointerMove(surface(container), { clientX: px(2), clientY: 50 });
    expect(container.querySelectorAll('svg circle')).toHaveLength(0);
  });
});
