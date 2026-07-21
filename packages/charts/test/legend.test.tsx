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
import { orderLegendItems, type LegendItemSpec } from '../src/swatch.js';
import { useChartLegend } from '../src/useChartLegend.js';
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

  it('a stacked bar WITH an id keeps one row per group + unique React keys', () => {
    // The segments share the layer id, so the card must key on (id + label),
    // not id alone — otherwise React dev-warns on duplicate keys.
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args) => errors.push(args));
    let container: HTMLElement;
    try {
      container = renderChart(
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
      ).container;
    } finally {
      spy.mockRestore();
    }
    const card = legendCard(container);
    const labels = Array.from(card.querySelectorAll('span')).map(
      (s) => s.textContent,
    );
    // Pre-fix, the shared layer id collapsed the groups to one row.
    expect(labels).toEqual(['v', 'w']);
    // …and no duplicate-key warning (pre-key-fix both rows keyed "stack").
    const dupKeyWarned = errors.some((a) => String(a[0]).includes('same key'));
    expect(dupKeyWarned).toBe(false);
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

  it('scopes to its ChartRow when placed inside a <Layers>', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="v" as="top" axis="a" />
            {/* Scoped: this legend should list ONLY the top row's layer. */}
            <Legend />
          </Layers>
        </ChartRow>
        <ChartRow height={100}>
          <YAxis id="b" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="w" as="bottom" axis="b" />
          </Layers>
        </ChartRow>
        {/* Container-level: lists BOTH rows. */}
        <Legend />
      </ChartContainer>,
    );
    const cards = container.querySelectorAll('[data-legend]');
    expect(cards).toHaveLength(2);
    const labelsOf = (card: Element) =>
      Array.from(card.querySelectorAll('span')).map((s) => s.textContent);
    // The scoped card (inside the first row's Layers) is the first in the DOM.
    expect(labelsOf(cards[0]!)).toEqual(['top']);
    // The container-level card lists every row.
    expect(labelsOf(cards[1]!)).toEqual(['top', 'bottom']);
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
    // Selection reads by contrast: the selected row is bold at full opacity,
    // every other row dulls.
    expect(dotsRow.style.fontWeight).toBe('600');
    expect(dotsRow.style.opacity).toBe('1');
    expect(foamRow.style.fontWeight).toBe('400');
    expect(foamRow.style.opacity).toBe('0.45');
  });

  it('with no selection, no row is dulled', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
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
    expect(within(card).getByText('dots').parentElement!.style.opacity).toBe(
      '1',
    );
    expect(within(card).getByText('foam').parentElement!.style.opacity).toBe(
      '1',
    );
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

describe('<Legend> — swatch glyphs + placement (the #512 follow-up polish)', () => {
  it('a bar swatch is a centred rounded square', () => {
    const { container } = render(
      <Legend
        items={[{ label: 'volume', swatch: { kind: 'bar', fill: '#93c5fd' } }]}
      />,
    );
    const rect = legendCard(container).querySelector('rect')!;
    expect(rect.getAttribute('x')).toBe('5'); // centred in the 20px box
    expect(rect.getAttribute('width')).toBe('10'); // square
    expect(rect.getAttribute('height')).toBe('10');
    expect(rect.getAttribute('rx')).toBe('2'); // slightly rounded
  });

  it('a dashed line swatch hand-renders exactly three dashes', () => {
    const { container } = render(
      <Legend
        items={[
          {
            label: 'forecast',
            swatch: { kind: 'line', color: '#64748b', width: 2, dash: [6, 4] },
          },
        ]}
      />,
    );
    const lines = legendCard(container).querySelectorAll('line');
    expect(lines).toHaveLength(3);
    // No dasharray — the three segments ARE the dashes (canonical glyph,
    // independent of the layer's own dash cadence).
    Array.from(lines).forEach((l) =>
      expect(l.getAttribute('stroke-dasharray')).toBeNull(),
    );
  });

  it('a solid line swatch stays one full-width stroke', () => {
    const { container } = render(
      <Legend
        items={[
          {
            label: 'observed',
            swatch: { kind: 'line', color: '#123', width: 2 },
          },
        ]}
      />,
    );
    expect(legendCard(container).querySelectorAll('line')).toHaveLength(1);
  });

  it('left/right placements inset by the axis gutter (plot-area anchoring)', () => {
    const { container } = renderChart(
      <ChartContainer range={[0, 2000]} width={400}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart series={series()} column="v" as="foam" axis="a" />
          </Layers>
        </ChartRow>
        <Legend placement="top-left" />
      </ChartContainer>,
    );
    const card = legendCard(container);
    const left = parseFloat(card.style.left);
    // The y-axis gutter is reserved on the left, so the card sits past it —
    // strictly more than the bare 8px inset (pre-fix it overlapped the axis).
    expect(left).toBeGreaterThan(8);
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

describe('useChartLegend — the headless legend', () => {
  function Harness({
    sink,
  }: {
    sink: (legend: ReturnType<typeof useChartLegend>) => void;
  }) {
    sink(useChartLegend());
    return null;
  }

  function mountHook(
    onSelect?: (s: unknown) => void,
    onHover?: (s: unknown) => void,
  ) {
    let legend: ReturnType<typeof useChartLegend> | null = null;
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer
          range={[0, 2000]}
          width={400}
          {...(onSelect ? { onSelect } : {})}
          {...(onHover ? { onHover } : {})}
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
          <Harness sink={(l) => (legend = l)} />
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    return () => legend!;
  }

  it('groups items by chart row with live selected/hovered state', () => {
    const legend = mountHook();
    // Both layers are in one ChartRow ⇒ one row group with two items.
    expect(legend().rows).toHaveLength(1);
    const items = legend().rows.flatMap((r) => r.items);
    expect(items.map((it) => it.label)).toEqual(['dots', 'foam']);
    expect(items.map((it) => it.selected)).toEqual([false, false]);
    expect(items[0]!.swatch.kind).toBe('scatter');
  });

  it('exposes the axis gutters so a custom legend can align to the plot', () => {
    const legend = mountHook();
    // A left <YAxis> reserved a gutter; the right side has none.
    expect(legend().gutters.left).toBeGreaterThan(0);
    expect(legend().gutters.right).toBe(0);
  });

  it('exposes cursorTime: null when idle, the axis instant under a tracker', () => {
    // Idle (no cursor): null — the "show the CURRENT value" branch.
    expect(mountHook()().cursorTime).toBeNull();

    // A controlled trackerPosition resolves to a cursor pixel; the hook
    // inverts it back to axis units — the "value at the cursor" branch.
    let legend: ReturnType<typeof useChartLegend> | null = null;
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer range={[0, 2000]} width={400} trackerPosition={1000}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={10} />
            <Layers>
              <LineChart series={series()} column="v" as="foam" axis="a" />
            </Layers>
          </ChartRow>
          <Harness sink={(l) => (legend = l)} />
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    expect(legend!.cursorTime).toBeCloseTo(1000, 3);
  });

  it('select() toggles the container selection; hover() echoes; both id-gated', () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    const legend = mountHook(onSelect, onHover);
    const items = () => legend().rows.flatMap((r) => r.items);
    const [dots, foam] = [items()[0]!, items()[1]!];

    act(() => legend().select(dots));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ id: 'pts' });
    // The state flows back onto the items…
    expect(items()[0]!.selected).toBe(true);
    // …and a second select of the same item clears (toggle).
    act(() => legend().select(items()[0]!));
    expect(onSelect).toHaveBeenLastCalledWith(null);

    act(() => legend().hover(dots));
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(items()[0]!.hovered).toBe(true);
    act(() => legend().hover(null));
    expect(onHover).toHaveBeenLastCalledWith(null);

    // Id-less items are inert through both verbs.
    act(() => legend().select(foam));
    act(() => legend().hover(foam));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onHover).toHaveBeenCalledTimes(2);
  });

  it('throws outside a <ChartContainer>', () => {
    expect(() => render(<Harness sink={() => {}} />)).toThrow(
      /useChartLegend\(\) must be used inside/,
    );
  });

  it('scopes to the enclosing row when called inside a <Layers>', () => {
    let scoped: ReturnType<typeof useChartLegend> | null = null;
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer range={[0, 2000]} width={400}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={10} />
            <Layers>
              <LineChart series={series()} column="v" as="top" axis="a" />
              <Harness sink={(l) => (scoped = l)} />
            </Layers>
          </ChartRow>
          <ChartRow height={100}>
            <YAxis id="b" min={0} max={10} />
            <Layers>
              <LineChart series={series()} column="w" as="bottom" axis="b" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    // The hook saw a RowContext ⇒ only the enclosing row's layer.
    expect(scoped!.rows).toHaveLength(1);
    expect(scoped!.rows.flatMap((r) => r.items).map((it) => it.label)).toEqual([
      'top',
    ]);
  });

  it('at the container level groups items into one row per chart row', () => {
    let legend: ReturnType<typeof useChartLegend> | null = null;
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer range={[0, 2000]} width={400}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={10} />
            <Layers>
              <LineChart series={series()} column="v" as="top" axis="a" />
            </Layers>
          </ChartRow>
          <ChartRow height={100}>
            <YAxis id="b" min={0} max={10} />
            <Layers>
              <LineChart series={series()} column="v" as="mid" axis="b" />
              <LineChart series={series()} column="w" as="low" axis="b" />
            </Layers>
          </ChartRow>
          <Harness sink={(l) => (legend = l)} />
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    // Two chart rows ⇒ two groups; the second carries both its layers.
    expect(legend!.rows).toHaveLength(2);
    expect(legend!.rows.map((r) => r.items.map((it) => it.label))).toEqual([
      ['top'],
      ['mid', 'low'],
    ]);
  });
});

describe('orderLegendItems — ordering + dedup', () => {
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
    const out = orderLegendItems(
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
    const out = orderLegendItems(
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
