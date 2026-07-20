/**
 * `<Legend>` ([PND-LEGEND], #508 item 2) — the series key rendered from the
 * layers' own registrations: resolved-style swatches (so the key can't drift
 * from the plot), chart-row → declaration ordering, `id ?? label` dedup,
 * per-layer opt-out/rename, id-gated interactions, and the `items` escape
 * hatch (standalone mode).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BandChart } from '../src/BandChart.js';
import { BarChart } from '../src/BarChart.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { Legend } from '../src/Legend.js';
import { YAxis } from '../src/YAxis.js';
import { orderLegendRows, type LegendItemSpec } from '../src/swatch.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
      { name: 'w', kind: 'number' },
    ] as const,
    rows: [
      [0, 1, 2],
      [1000, 5, 3],
      [2000, 9, 4],
    ],
  });

function renderChart(ui: React.ReactElement) {
  const stub = stubCanvasContext();
  try {
    return render(ui);
  } finally {
    stub.restore();
  }
}

function legendCard(container: HTMLElement): HTMLElement {
  const card = container.querySelector('[data-legend]');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

describe('<Legend> — zero-config enumeration', () => {
  it('lists layers in chart-row → declaration order, swatch per row', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="v" as="foam" axis="a" />
            <BandChart series={series()} lower="v" upper="w" as="iv" axis="a" />
          </Layers>
        </ChartRow>
        <ChartRow height={100}>
          <YAxis id="b" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="w" as="swell" axis="b" />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    const labels = Array.from(card.querySelectorAll('span')).map(
      (s) => s.textContent,
    );
    expect(labels).toEqual(['foam', 'iv', 'swell']);
    // One swatch glyph per row.
    expect(card.querySelectorAll('svg')).toHaveLength(3);
  });

  it('dedups by identity — two layers sharing an `as` collapse to one row', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="v" as="foam" axis="a" />
            <LineChart series={series()} column="w" as="foam" axis="a" />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    expect(within(card).getAllByText('foam')).toHaveLength(1);
  });

  it('legend={false} opts a layer out; legend="name" renames its row', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart
              series={series()}
              column="v"
              as="foam"
              axis="a"
              legend={false}
            />
            <LineChart
              series={series()}
              column="w"
              as="swell"
              axis="a"
              legend="Swell (m)"
            />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    expect(within(card).queryByText('foam')).toBeNull();
    expect(within(card).getByText('Swell (m)')).toBeTruthy();
  });

  it('a stacked bar registers one row per group, in stack order', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={20} />
          <Layers>
            <BarChart series={series()} columns={['v', 'w']} axis="a" />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    const labels = Array.from(card.querySelectorAll('span')).map(
      (s) => s.textContent,
    );
    expect(labels).toEqual(['v', 'w']);
  });

  it('a stacked bar WITH an id keeps one row per group (dedup is per stack position)', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={20} />
          <Layers>
            <BarChart
              series={series()}
              columns={['v', 'w']}
              id="stack"
              axis="a"
            />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    const labels = Array.from(card.querySelectorAll('span')).map(
      (s) => s.textContent,
    );
    // Pre-fix, the shared layer id collapsed the groups to one row.
    expect(labels).toEqual(['v', 'w']);
  });

  it('an unmounted layer unregisters its row', () => {
    const stub = stubCanvasContext();
    try {
      const chart = (both: boolean) => (
        <ChartContainer range={[0, 2000]} width={400}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={10} />
            <Layers>
              <LineChart series={series()} column="v" as="foam" axis="a" />
              {both ? (
                <LineChart series={series()} column="w" as="swell" axis="a" />
              ) : null}
            </Layers>
          </ChartRow>
          <Legend />
        </ChartContainer>
      );
      const { container, rerender } = render(chart(true));
      expect(within(legendCard(container)).getByText('swell')).toBeTruthy();
      rerender(chart(false));
      expect(within(legendCard(container)).queryByText('swell')).toBeNull();
      expect(within(legendCard(container)).getByText('foam')).toBeTruthy();
    } finally {
      stub.restore();
    }
  });

  it('renders nothing with no registered rows', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart
              series={series()}
              column="v"
              as="foam"
              axis="a"
              legend={false}
            />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    expect(container.querySelector('[data-legend]')).toBeNull();
  });
});

describe('<Legend> — id-gated interactions', () => {
  it('echoes the container selection: the selected row reads emphasized', () => {
    const { container } = renderChart(
      <ChartContainer
        range={[0, 2000]}
        width={400}
        selected={{ id: 'pts', key: 0, value: 0, color: '#000', label: 'dots' }}
      >
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <ScatterChart
              series={series()}
              column="v"
              id="pts"
              as="dots"
              axis="a"
            />
            <LineChart series={series()} column="w" as="foam" axis="a" />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    const dotsRow = within(card).getByText('dots').parentElement!;
    const foamRow = within(card).getByText('foam').parentElement!;
    expect(dotsRow.style.fontWeight).toBe('600');
    expect(foamRow.style.fontWeight).toBe('400');
  });

  it('clicking an id-bearing row toggles selection through the frame', () => {
    const onSelect = vi.fn();
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400} onSelect={onSelect}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <ScatterChart
              series={series()}
              column="v"
              id="pts"
              as="dots"
              axis="a"
            />
            <LineChart series={series()} column="w" as="foam" axis="a" />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    act(() => within(card).getByText('dots').click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({
      id: 'pts',
      label: 'dots',
    });
    // Toggle: clicking the (now-selected) row again deselects.
    act(() => within(card).getByText('dots').click());
    expect(onSelect).toHaveBeenLastCalledWith(null);
    // A row without an id is inert by default.
    act(() => within(card).getByText('foam').click());
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('hovering an id-bearing row echoes into the container hovered channel', () => {
    const onHover = vi.fn();
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400} onHover={onHover}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <ScatterChart
              series={series()}
              column="v"
              id="pts"
              as="dots"
              axis="a"
            />
          </Layers>
        </ChartRow>
        <Legend />
      </ChartContainer>,
    );
    const card = legendCard(container);
    const row = within(card).getByText('dots').parentElement!;
    // React derives onPointerEnter/Leave from the bubbling over/out pair.
    act(() => {
      row.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, cancelable: true }),
      );
    });
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onHover.mock.calls[0]![0]).toMatchObject({ id: 'pts' });
    act(() => {
      row.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, cancelable: true }),
      );
    });
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('onRowClick takes over the default select behavior', () => {
    const onSelect = vi.fn();
    const onRowClick = vi.fn();
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400} onSelect={onSelect}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <ScatterChart
              series={series()}
              column="v"
              id="pts"
              as="dots"
              axis="a"
            />
          </Layers>
        </ChartRow>
        <Legend onRowClick={onRowClick} />
      </ChartContainer>,
    );
    const card = legendCard(container);
    act(() => within(card).getByText('dots').click());
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]![0]).toMatchObject({ id: 'pts' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('<Legend items> — the escape hatch', () => {
  it('renders explicit rows standalone, outside any container', () => {
    const { container } = render(
      <Legend
        items={[
          {
            label: 'observed',
            swatch: { kind: 'line', color: '#123', width: 2 },
          },
          {
            label: 'forecast',
            swatch: { kind: 'line', color: '#456', width: 2, dash: [4, 3] },
          },
        ]}
      />,
    );
    const card = legendCard(container);
    expect(within(card).getByText('observed')).toBeTruthy();
    expect(within(card).getByText('forecast')).toBeTruthy();
    // Standalone card is in normal flow (the consumer places it).
    expect(card.style.position).not.toBe('absolute');
  });

  it('inside a container, `items` replaces the registry', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="v" as="foam" axis="a" />
          </Layers>
        </ChartRow>
        <Legend
          items={[{ label: 'only', swatch: { kind: 'bar', fill: '#789' } }]}
        />
      </ChartContainer>,
    );
    const card = legendCard(container);
    expect(within(card).getByText('only')).toBeTruthy();
    expect(within(card).queryByText('foam')).toBeNull();
  });
});

describe('orderLegendRows — ordering + dedup', () => {
  const rowA = Symbol('rowA');
  const rowB = Symbol('rowB');
  const spec = (
    label: string,
    rowKey: symbol,
    index: number,
    subIndex = 0,
    id?: string,
  ): LegendItemSpec => ({
    label,
    ...(id !== undefined ? { id } : {}),
    swatch: { kind: 'bar', fill: '#000' },
    rowKey,
    index,
    subIndex,
  });

  it('sorts by chart-row order, then declaration index, then subIndex', () => {
    const out = orderLegendRows(
      [
        spec('b-first', rowB, 0),
        spec('a-second', rowA, 1),
        spec('a-first-s1', rowA, 0, 1),
        spec('a-first-s0', rowA, 0, 0),
      ],
      [rowA, rowB],
    );
    expect(out.map((r) => r.label)).toEqual([
      'a-first-s0',
      'a-first-s1',
      'a-second',
      'b-first',
    ]);
  });

  it('dedups on id ?? label — the first row in display order stands', () => {
    const out = orderLegendRows(
      [
        spec('foam', rowA, 0),
        spec('foam', rowA, 1), // same label → collapsed
        spec('other', rowA, 2, 0, 'x'),
        spec('renamed', rowA, 3, 0, 'x'), // same id → collapsed despite label
      ],
      [rowA],
    );
    expect(out.map((r) => r.label)).toEqual(['foam', 'other']);
  });
});
