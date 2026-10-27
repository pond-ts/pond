import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { XAxis } from '../src/XAxis.js';
import { TimeAxis } from '../src/TimeAxis.js';

afterEach(cleanup);

/**
 * [PND-XAXISOWN] — a mounted `<XAxis>` wins over the container's implicit
 * strip. Before, the container always drew one, so declaring an axis drew
 * two and every story in `Axes.stories.tsx` passed `showAxis={false}`.
 */
const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [60_000, 2],
      [120_000, 3],
    ],
  });

const axes = (root: HTMLElement) => root.querySelectorAll("[data-axis='x']");

function Chart(props: { showAxis?: boolean; children?: React.ReactNode }) {
  return (
    <ChartContainer
      width={400}
      {...(props.showAxis !== undefined ? { showAxis: props.showAxis } : {})}
    >
      <ChartRow height={100}>
        <Layers>
          <LineChart series={series()} column="v" />
        </Layers>
      </ChartRow>
      {props.children}
    </ChartContainer>
  );
}

describe('a mounted <XAxis> owns the x axis', () => {
  it('with no declared axis, the implicit strip still draws', () => {
    const { container } = render(<Chart />);
    expect(axes(container)).toHaveLength(1);
  });

  it('a declared <XAxis> replaces the implicit strip — one axis, not two', () => {
    const { container } = render(
      <Chart>
        <XAxis label="time" />
      </Chart>,
    );
    expect(axes(container)).toHaveLength(1);
    expect(container.textContent).toContain('time');
  });

  it('so does a <TimeAxis>, and an <XAxis> declared inside a row', () => {
    const top = render(
      <Chart>
        <TimeAxis side="top" />
      </Chart>,
    );
    expect(axes(top.container)).toHaveLength(1);
    cleanup();
    const { container } = render(
      <ChartContainer width={400}>
        <ChartRow height={100}>
          <Layers>
            <LineChart series={series()} column="v" />
          </Layers>
          <XAxis />
        </ChartRow>
      </ChartContainer>,
    );
    expect(axes(container)).toHaveLength(1);
  });

  it('unmounting the declared axis brings the implicit strip back', () => {
    let toggle: (on: boolean) => void = () => {};
    function Toggle() {
      const [on, setOn] = useState(true);
      toggle = setOn;
      return <Chart>{on ? <XAxis label="mine" /> : null}</Chart>;
    }
    const { container } = render(<Toggle />);
    expect(axes(container)).toHaveLength(1);
    act(() => toggle(false));
    expect(axes(container)).toHaveLength(1);
    expect(container.textContent).not.toContain('mine');
  });

  it('`showAxis={false}` still hides everything but the declared axis', () => {
    const { container } = render(<Chart showAxis={false} />);
    expect(axes(container)).toHaveLength(0);
  });

  it('`showAxis` true + a declared axis keeps both, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(
        <Chart showAxis>
          <XAxis label="mine" />
        </Chart>,
      );
      expect(axes(container)).toHaveLength(2);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('two x axes')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
