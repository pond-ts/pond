import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { CrosshairCursor } from '../src/cursors.js';
import { defaultTheme, type ChartTheme } from '../src/theme.js';
import type { CursorSnap } from '../src/context.js';

afterEach(cleanup);

/**
 * The crosshair **snaps** its reticle to one series — the one nearest the
 * pointer's height — and two things follow from that: the centre dot wears the
 * snapped series' colour (so the reticle says which line it is reading), and
 * `<CrosshairCursor onSnap>` tells the consumer which series and which point.
 */

const series = (column: string, values: [number, number, number]) =>
  new TimeSeries({
    name: column,
    schema: [
      { name: 'time', kind: 'time' },
      { name: column, kind: 'number' },
    ] as const,
    rows: [
      [0, values[0]],
      [2, values[1]],
      [4, values[2]],
    ] as [number, number][],
  });

/** `low` sits near the bottom of a [0, 100] axis, `high` near the top — so a
 *  pointer at the top of the row snaps to `high`, at the bottom to `low`. */
const low = series('low', [10, 20, 15]);
const high = series('high', [80, 90, 85]);

const RED = '#cc2222';
const GREEN = '#22aa44';

/** A theme that is NOT `defaultTheme`: it adds the two series colours, and
 *  drops `cursor` so the free-mode ink falls through to `axis.label`. */
const theme: ChartTheme = (() => {
  const { cursor: _cursor, ...rest } = defaultTheme;
  return {
    ...rest,
    line: {
      ...defaultTheme.line,
      low: { color: RED, width: 1 },
      high: { color: GREEN, width: 1 },
    },
  };
})();

const WIDTH = 300;
const HEIGHT = 100;

/** The reticle's centre dot — the crosshair draws exactly one circle. */
function centreDot(c: HTMLElement): SVGCircleElement {
  const dots = c.querySelectorAll('circle');
  expect(dots.length).toBe(1);
  return dots[0]!;
}

function surfaces(c: HTMLElement): HTMLElement[] {
  return Array.from(c.querySelectorAll('canvas')).map((x) => x.parentElement!);
}

function chart(props: {
  onSnap?: (s: CursorSnap | null) => void;
  snap?: boolean;
  rows?: 1 | 2;
}) {
  const { onSnap, snap = true, rows = 1 } = props;
  const row = (key: string) => (
    <ChartRow key={key} height={HEIGHT}>
      <Layers>
        <LineChart series={low} column="low" as="low" axis="v" />
        <LineChart series={high} column="high" as="high" axis="v" />
      </Layers>
      <YAxis id="v" side="right" width={40} min={0} max={100} />
    </ChartRow>
  );
  return (
    <ChartContainer range={[0, 4]} width={WIDTH} showAxis={false} theme={theme}>
      <CrosshairCursor snap={snap} {...(onSnap ? { onSnap } : {})} />
      {rows === 1 ? row('a') : [row('a'), row('b')]}
    </ChartContainer>
  );
}

describe('the crosshair centre dot', () => {
  it('takes the colour of the series it snapped to', () => {
    const { container } = render(chart({}));
    const [surface] = surfaces(container);
    // Near the top of the row ⇒ the `high` line (values 80–90).
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 5 });
    expect(centreDot(container).getAttribute('fill')).toBe(GREEN);
    // Near the bottom ⇒ the `low` line (values 10–20).
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 95 });
    expect(centreDot(container).getAttribute('fill')).toBe(RED);
  });

  it('keeps the cursor ink in free mode, where no series is under it', () => {
    const { container } = render(chart({ snap: false }));
    const [surface] = surfaces(container);
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 5 });
    // This theme has no `cursor`, so the ink is the axis label colour.
    expect(centreDot(container).getAttribute('fill')).toBe(
      defaultTheme.axis.label,
    );
  });
});

describe('<CrosshairCursor onSnap>', () => {
  it('reports the series and point the reticle snapped to', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(chart({ onSnap: (s) => calls.push(s) }));
    const [surface] = surfaces(container);
    // clientX 130 of a 260px plot over [0, 4] ⇒ t = 2 ⇒ the middle samples.
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 5 });
    expect(calls).toEqual([
      {
        x: 2,
        value: 90,
        label: 'high',
        color: GREEN,
        axisId: 'v',
        formatted: '90',
      },
    ]);
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 95 });
    expect(calls.at(-1)).toMatchObject({ x: 2, value: 20, label: 'low' });
  });

  it('fires only when the snapped point changes, not on every move', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(chart({ onSnap: (s) => calls.push(s) }));
    const [surface] = surfaces(container);
    // Three moves that all snap to the same point (t = 2, the `high` line).
    fireEvent.pointerMove(surface!, { clientX: 125, clientY: 5 });
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 8 });
    fireEvent.pointerMove(surface!, { clientX: 135, clientY: 3 });
    expect(calls.length).toBe(1);
    // A move to the next sample in time is a new point.
    fireEvent.pointerMove(surface!, { clientX: 255, clientY: 5 });
    expect(calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ x: 4, value: 85, label: 'high' });
  });

  it('reports null when the pointer leaves the chart', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(chart({ onSnap: (s) => calls.push(s) }));
    const [surface] = surfaces(container);
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 5 });
    fireEvent.pointerOut(surface!);
    expect(calls.at(-1)).toBeNull();
    // …once, even though every row saw the pointer go.
    expect(calls.filter((c) => c === null).length).toBe(1);
  });

  it('a row the pointer is not over does not cancel the row it is over', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(
      chart({ onSnap: (s) => calls.push(s), rows: 2 }),
    );
    const [top, bottom] = surfaces(container);
    fireEvent.pointerMove(top!, { clientX: 130, clientY: 5 });
    fireEvent.pointerMove(bottom!, { clientX: 130, clientY: 95 });
    // Both rows share the container's crosshair and both re-render on the
    // move. Only the hovered row reports; if the other one reported its own
    // "nothing here" too, the two would fight and the consumer would see a
    // stray `null` after every point.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ label: 'high' });
    expect(calls[1]).toMatchObject({ label: 'low' });
  });

  it('stays null in free mode — the reticle follows the pointer, not a series', () => {
    const calls: (CursorSnap | null)[] = [];
    const { container } = render(
      chart({ onSnap: (s) => calls.push(s), snap: false }),
    );
    const [surface] = surfaces(container);
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 5 });
    // Never snapped, so never a change to report — not even a `null`.
    expect(calls).toEqual([]);
  });

  it('an inline callback that changes every render keeps working', () => {
    // The callback is read through a ref, so a parent re-render with a new
    // arrow neither re-registers the cursor nor drops later reports.
    const seen: string[] = [];
    let bump: () => void = () => {};
    function Parent() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return chart({ onSnap: (s) => seen.push(`${n}:${s?.label ?? 'null'}`) });
    }
    const { container } = render(<Parent />);
    const [surface] = surfaces(container);
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 5 });
    act(() => bump());
    fireEvent.pointerMove(surface!, { clientX: 130, clientY: 95 });
    expect(seen).toEqual(['0:high', '1:low']);
  });
});
