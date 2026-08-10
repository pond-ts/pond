import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { LineChart } from '../src/LineChart.js';
import { AreaChart } from '../src/AreaChart.js';
import { MultiSelector } from '../src/selectors.js';
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

  // `onSelect` on the container is deprecated in favour of a mounted
  // `<Selector>` (interaction RFC §7), so wiring it now also emits the
  // migration warning. These cases are about the *no-selectable-layer* warning,
  // so they count that one rather than every `console.warn`.
  const noIdWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c) => /no layer has an `id`/.test(String(c[0])));

  it('warns when `onSelect` is wired but no layer has an `id`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(tree({ onSelect: () => {} }));
    expect(noIdWarnings(warn)).toHaveLength(1);
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
    expect(noIdWarnings(warn)).toHaveLength(0);
    warn.mockRestore();
  });

  it('does NOT warn when selection is not wired at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(tree({}));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The guard has to know about every selectable layer, or it accuses a correctly
 * wired chart. Traces became selectable in [PND-TRACESEL] but never registered,
 * so a `<LineChart id>` / `<AreaChart id>` under a `<MultiSelector>` — the exact
 * shape the new stories ship — drew the warning *and* was told to add an `id` to
 * a `<BarChart>`/`<ScatterChart>`/`<BoxPlot>`, none of which were mounted.
 */
describe('selection dev-warn: a trace counts as selectable', () => {
  const noIdWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c) => /no layer has an `id`/.test(String(c[0])));

  const traceTree = (kind: 'line' | 'area', withId: boolean) => {
    const Trace = kind === 'line' ? LineChart : AreaChart;
    return (
      <ChartContainer range={[0, 3]} width={300}>
        <MultiSelector onSelect={() => {}} />
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={5} />
          <Layers>
            <Trace
              series={bars}
              column="v"
              axis="a"
              {...(withId ? { id: 't' } : {})}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  };

  it.each(['line', 'area'] as const)(
    'does NOT warn for a <%sChart> carrying an `id`',
    (kind) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(traceTree(kind, true));
      expect(noIdWarnings(warn)).toHaveLength(0);
      warn.mockRestore();
    },
  );

  it.each(['line', 'area'] as const)(
    'still warns for a <%sChart> with no `id` — nothing is selectable',
    (kind) => {
      // The other half: registering on `id` must not turn the guard off
      // wholesale, or the footgun it exists for stops being caught on traces.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(traceTree(kind, false));
      expect(noIdWarnings(warn)).toHaveLength(1);
      warn.mockRestore();
    },
  );

  it('names the trace components in the remedy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(traceTree('line', false));
    const msg = String(noIdWarnings(warn)[0]![0]);
    expect(msg).toContain('<LineChart>');
    expect(msg).toContain('<AreaChart>');
    warn.mockRestore();
  });
});
