import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { LineCursor } from '../src/cursors.js';
import type { TrackerInfo } from '../src/context.js';

afterEach(cleanup);

/**
 * [#647] **You mount a cursor to get a cursor.** Before, a chart with no
 * cursor component still drew a line cursor (an implicit `'line'` default),
 * so the only way to say "no cursor" was the `cursor="none"` prop that was
 * being removed. Now mounting nothing means no in-chart cursor — while hover
 * keeps reporting through `onTrackerChanged`, which is not a cursor.
 */

const series = new TimeSeries({
  name: 's',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [
    [0, 10],
    [2, 50],
    [4, 90],
  ] as [number, number][],
});

const row = (cursor?: React.ReactNode) => (
  <ChartRow height={100}>
    {cursor}
    <Layers>
      <LineChart series={series} column="v" />
    </Layers>
  </ChartRow>
);

/** Every cursor mark the overlay can draw: lines, dots, bands. */
const cursorMarks = (c: HTMLElement) =>
  c.querySelectorAll('svg line, svg circle, svg rect').length;

const surfaces = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('canvas')).map((x) => x.parentElement!);

describe('no cursor component mounted', () => {
  it('draws no cursor on hover', () => {
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} showAxis={false}>
        {row()}
      </ChartContainer>,
    );
    fireEvent.pointerMove(surfaces(container)[0]!, {
      clientX: 150,
      clientY: 50,
    });
    expect(cursorMarks(container)).toBe(0);
  });

  it('still reports the hover through onTrackerChanged', () => {
    const seen: (TrackerInfo | null)[] = [];
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        showAxis={false}
        onTrackerChanged={(i) => seen.push(i)}
      >
        {row()}
      </ChartContainer>,
    );
    fireEvent.pointerMove(surfaces(container)[0]!, {
      clientX: 150,
      clientY: 50,
    });
    expect(seen.at(-1)?.values.length).toBe(1);
  });

  it('a mounted <LineCursor> is what draws the line', () => {
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} showAxis={false}>
        <LineCursor />
        {row()}
      </ChartContainer>,
    );
    fireEvent.pointerMove(surfaces(container)[0]!, {
      clientX: 150,
      clientY: 50,
    });
    expect(container.querySelectorAll('svg line').length).toBe(1);
  });

  it('a cursor mounted in one row leaves the other rows without one', () => {
    // The per-row answer to "a cursor here but not there" — the old
    // `<ChartRow cursor="none">` override has no prop form any more.
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} showAxis={false}>
        {row(<LineCursor />)}
        {row()}
      </ChartContainer>,
    );
    const [top, bottom] = surfaces(container);
    fireEvent.pointerMove(bottom!, { clientX: 150, clientY: 50 });
    // The line is shared across rows by x, but only the row that mounts a
    // cursor draws it.
    const rowsWithLine = surfaces(container).filter(
      (s) => s.parentElement!.querySelector('svg line') !== null,
    );
    expect(rowsWithLine).toHaveLength(1);
    expect(top!.parentElement!.querySelector('svg line')).not.toBeNull();
  });
});
