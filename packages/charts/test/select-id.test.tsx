import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';

afterEach(cleanup);

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;
const bars = new TimeSeries({
  name: 'b',
  schema,
  rows: [
    [0, 1],
    [1, 2],
    [2, 3],
  ] as [number, number][],
});

/**
 * `id` gates interactivity (selection RFC, Amendment 3): a layer is selectable
 * only when it carries an `id`. The dev-warn catches the migration footgun —
 * wiring `selected`/`onSelect` but forgetting the `id`, so nothing is selectable.
 */
describe('selection dev-warn: wired but no selectable layer', () => {
  const tree = (
    props: Partial<Parameters<typeof ChartContainer>[0]>,
    barId?: string,
  ) => (
    <ChartContainer range={[0, 3]} width={300} {...props}>
      <ChartRow height={100}>
        <YAxis id="a" min={0} max={5} />
        <Layers>
          <BarChart
            series={bars}
            column="v"
            axis="a"
            {...(barId === undefined ? {} : { id: barId })}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );

  it('warns when `onSelect` is wired but no layer has an `id`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(tree({ onSelect: () => {} }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/no layer has an `id`/);
    warn.mockRestore();
  });

  it('warns when controlled `selected` is set but no layer has an `id`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(tree({ selected: null }));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does NOT warn when a layer carries an `id`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(tree({ onSelect: () => {} }, 'v'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does NOT warn when selection is not wired at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(tree({}));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
