import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { HeatMap } from './HeatMap.js';
import { YAxis } from './YAxis.js';
import { sanFranciscoTemperatures } from './sf-temperatures.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';
import type { SelectInfo } from './context.js';

const sf = sanFranciscoTemperatures();
const begins = sf.keyColumn().begin;
const RANGE: readonly [number, number] = [begins[0]!, begins[sf.length - 1]!];

/** A sequential ramp, cool → warm, in the docs palette's own family — one hue
 *  family rather than competing hues. Nine stops, so it reads as continuous
 *  while staying countable against a legend. */
const RAMP = [
  '#0b3d3a',
  '#125e57',
  '#1a8078',
  '#27a396',
  '#4cc0b0',
  '#82d6c7',
  '#b6e7dd',
  '#d5f0e9',
  '#e2f5f0',
];

const meta = {
  title: 'Charts/HeatMap',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * **Shape 1 — a `TimeSeries`, one column.** One cell per day, tiling the time
 * axis, colour carrying the daily high. A stripe is just `columns.length === 1`
 * — the same draw path as the grid below, not a special case.
 *
 * This replaces a `<BarChart>` workaround that needed a constant column (so
 * every bar was full height) plus a caller-computed colour array. Both go.
 */
export const Stripe: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} theme={docsTheme}>
      <ChartRow height={80}>
        <YAxis id="v" label="°F" />
        <Layers>
          <HeatMap series={sf} columns={['high']} colors={RAMP} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Shape 2 — a `TimeSeries`, several columns.** The y dimension is the
 * series' own columns, one row each, labelled off `binCategories`. Row `0` is
 * at the bottom, so the list reads bottom → top.
 *
 * Both rows share **one** colour domain, which is what makes them comparable:
 * the same colour means the same temperature in either row, so you can see the
 * daily range open and close across the year.
 */
export const Grid: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} theme={docsTheme}>
      <ChartRow height={120}>
        <YAxis id="v" label="°F" />
        <Layers>
          <HeatMap series={sf} columns={['low', 'high']} colors={RAMP} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **The readout is the point.** Hover or click a cell: it reports the row it is
 * in and the value it encodes, in its own colour.
 *
 * A cell's identity is two-dimensional — bin **and** row — so the two rows at
 * one instant are distinct selections. The bar-based workaround could not do
 * this at all: constant-height bars carry no value, so the number had to be
 * looked up out-of-band.
 */
function SelectableDemo() {
  const [sel, setSel] = useState<SelectInfo | null>(null);
  return (
    <div>
      <div
        style={{
          height: 18,
          marginBottom: 8,
          fontFamily: docsTheme.font.family,
          fontSize: 12,
          color: docsTheme.axis.label,
        }}
      >
        {sel === null ? (
          <span style={{ opacity: 0.5 }}>hover or click a cell…</span>
        ) : (
          <span style={{ color: sel.color }}>
            {new Date(sel.key).toISOString().slice(0, 10)} · {sel.label}{' '}
            {sel.value.toFixed(1)}°F
          </span>
        )}
      </div>
      <ChartContainer
        range={RANGE}
        width={720}
        theme={docsTheme}
        onSelect={setSel}
        onHover={(h) => h && setSel(h)}
      >
        <ChartRow height={120}>
          <YAxis id="v" label="°F" />
          <Layers>
            <HeatMap
              series={sf}
              columns={['low', 'high']}
              colors={RAMP}
              id="temp"
              gap={0.5}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const Selectable: Story = { render: () => <SelectableDemo /> };

/**
 * **Shape 3 — a `ValueSeries`, one column.** The x axis is value intervals
 * rather than time: here the record re-keyed onto its own daily high, so the
 * cells bin by temperature instead of by date. Nothing about the layer
 * changes — `xKind` is inferred from the series type, exactly as `<BarChart>`
 * infers it.
 */
export const ValueAxisStripe: Story = {
  render: () => {
    const byHigh = sf.byValue('high');
    const axis = byHigh.axisValues();
    return (
      <ChartContainer
        range={[axis[0]!, axis[axis.length - 1]!]}
        width={720}
        theme={docsTheme}
      >
        <ChartRow height={80}>
          <YAxis id="v" label="°F" />
          <Layers>
            <HeatMap series={byHigh} columns={['low']} colors={RAMP} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **A pinned colour domain.** By default the ramp spans the finite extent of
 * the *whole grid*. Pin `domain` when two charts must be read against each
 * other, or when the window is a slice of a longer record and the colours
 * should not re-mean themselves as it moves — a colour scale has no tick
 * labels to reveal that it moved.
 *
 * Pinned wider than the data (40–100°F) here, so the record uses only the
 * middle of the ramp: the reading you would get if this were one city among
 * several on a shared scale.
 */
export const PinnedDomain: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} theme={docsTheme}>
      <ChartRow height={120}>
        <YAxis id="v" label="°F" />
        <Layers>
          <HeatMap
            series={sf}
            columns={['low', 'high']}
            colors={RAMP}
            domain={[40, 100]}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Many rows.** A synthetic five-band grid, to show the axis labelling and
 * cell geometry holding up as rows multiply — and that a `gap` reads as a grid
 * rather than a continuous field.
 */
const bands = (() => {
  const N = 120;
  const rows: Array<[number, number, number, number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const t = Date.UTC(2024, 0, 1) + i * 86_400_000;
    const s = Math.sin((i / N) * Math.PI * 2);
    rows.push([
      t,
      50 + 40 * s,
      50 + 30 * Math.sin(i / 9),
      50 + 25 * Math.cos(i / 7),
      50 - 20 * s,
      50 + 15 * Math.sin(i / 4),
    ]);
  }
  return new TimeSeries({
    name: 'bands',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'p50', kind: 'number' },
      { name: 'p75', kind: 'number' },
      { name: 'p90', kind: 'number' },
      { name: 'p95', kind: 'number' },
      { name: 'p99', kind: 'number' },
    ] as const,
    rows,
  });
})();

export const ManyRows: Story = {
  render: () => {
    const b = bands.keyColumn().begin;
    return (
      <ChartContainer
        range={[b[0]!, b[bands.length - 1]!]}
        width={720}
        theme={docsTheme}
      >
        <ChartRow height={200}>
          <YAxis id="v" label="°F" />
          <Layers>
            <HeatMap
              series={bands}
              columns={['p50', 'p75', 'p90', 'p95', 'p99']}
              colors={RAMP}
              gap={1}
              id="lat"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **`orientation="horizontal"`** — the bins run down **y** and the columns
 * become the categories across **x**.
 *
 * This is the shape gene-expression heat maps are drawn in, and it is the
 * orientation that makes the constraint work rather than fight: the long
 * dimension (thousands of gene buckets) is the **key** axis, so pond's ordinary
 * binning operators — `byColumn`, `aggregate` — bucket it, and the few columns
 * become the handful of category rows across the top.
 *
 * The mock below stands in for that: 400 buckets down y against 8 samples
 * across x, with a signal that reverses between the first four columns and the
 * last four so the two blocks read as opposites.
 */
export const Horizontal: Story = {
  render: () => {
    const SAMPLES = [
      'Control 1',
      'Control 2',
      'Exp 1',
      'Exp 2',
      'Exp 3',
      'Exp 4',
      'Exp 5',
      'Exp 6',
    ];
    const N = 400;
    const columns: Record<string, number[]> = {
      time: Array.from({ length: N }, (_, i) => i),
    };
    SAMPLES.forEach((s, si) => {
      const control = si < 2 ? 1 : -1;
      columns[s] = Array.from({ length: N }, (_, i) => {
        // Rank 0 is experimental-high, rank N-1 control-high, plus a little
        // per-sample noise so the columns are not identical.
        const shift = 1 - (2 * i) / (N - 1);
        return -control * shift + Math.sin(i / 7 + si) * 0.18;
      });
    });
    const series = TimeSeries.fromColumns({
      name: 'expression',
      schema: [
        { name: 'time', kind: 'time' },
        ...SAMPLES.map((s) => ({ name: s, kind: 'number' as const })),
      ] as const,
      columns,
    });
    // No `range`: x is the CATEGORY axis here, so the container builds its band
    // scale from the columns the layer reports. The bin axis is y, and its
    // extent is pinned on the <YAxis> instead.
    return (
      <ChartContainer width={440} theme={docsTheme} panZoom="panZoom2D">
        <ChartRow height={420}>
          <YAxis id="rank" label="gene rank" min={0} max={N} />
          <Layers>
            <HeatMap
              series={series}
              columns={SAMPLES}
              colors={RAMP}
              orientation="horizontal"
              domain={[-1.2, 1.2]}
              axis="rank"
              id="expr"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
