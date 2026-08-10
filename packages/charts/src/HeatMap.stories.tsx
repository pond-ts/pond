import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { HeatMap } from './HeatMap.js';
import { YAxis } from './YAxis.js';
import { Selector } from './selectors.js';
import { stacksFromColumns } from './data.js';
import { sanFranciscoTemperatures } from './sf-temperatures.fixture.js';
import { defaultTheme } from './theme.js';
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
    <ChartContainer range={RANGE} width={720} cursor="none">
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
    <ChartContainer range={RANGE} width={720} cursor="none">
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
          fontFamily: defaultTheme.font.family,
          fontSize: 12,
          color: defaultTheme.axis.label,
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
      <ChartContainer range={RANGE} width={720} cursor="none">
        <Selector
          onSelect={setSel}
          onHover={(h: SelectInfo | null) => h && setSel(h)}
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
        </Selector>
      </ChartContainer>
    </div>
  );
}

export const Selectable: Story = { render: () => <SelectableDemo /> };

// ---------------------------------------------------------------------------
// Plural selection / hover — `selected` and `hovered` are sets.
// ---------------------------------------------------------------------------

/**
 * The grid's cell **keys**, which are the bin `begin`s. On a point-keyed daily
 * series those are neighbour-spaced edges (`t − half a day`), *not* the sample
 * times, so they come from the reader the layer itself uses rather than from
 * `keyColumn().begin`. Getting this wrong is silent — a key that names no cell
 * simply lights nothing.
 */
const CELL_KEYS = stacksFromColumns(sf, ['low', 'high']).begin;

/** A `SelectInfo` naming the cell in bin `i`, row `row`. */
const tempCell = (i: number, row: 'low' | 'high'): SelectInfo => ({
  id: 'temp',
  key: CELL_KEYS[i]!,
  value: 0,
  color: RAMP[4]!,
  label: row,
});

/**
 * **Several cells selected at once.** `selected` is a **set**, and every cell a
 * member names takes the full-strength outline — five here, across both rows.
 * (This layer used to hand its draw `selection[0]`, so a multi-cell pin outlined
 * one cell and silently dropped the rest.)
 *
 * A cell's identity is two-dimensional — bin **and** row — so the two rows at
 * one instant are two distinct members, which is what the last pair below shows.
 */
export const MultiSelected: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} cursor="none">
      <Selector
        enabled={false}
        selected={[
          tempCell(40, 'low'),
          tempCell(120, 'high'),
          tempCell(200, 'low'),
          tempCell(280, 'low'),
          tempCell(280, 'high'),
        ]}
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
      </Selector>
    </ChartContainer>
  ),
};

/**
 * **Several cells hovered at once** — a drag-sweep mid-gesture (RFC A4.2).
 * `hovered` is the same set shape, drawn at the *lighter* outline weight so
 * "would be selected if you released now" stays visibly weaker than a committed
 * pick. Weight is what separates the two states, because a heat cell cannot pop
 * its colour: the colour is the datum.
 */
export const MultiHovered: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} cursor="none">
      <Selector
        enabled={false}
        hovered={[100, 101, 102, 103, 104, 105].flatMap((i) => [
          tempCell(i, 'low'),
          tempCell(i, 'high'),
        ])}
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
      </Selector>
    </ChartContainer>
  ),
};

/**
 * **Both sets at once, and the precedence between them.** Two cells are selected
 * and four hovered, with one cell in both — it draws the full-strength selected
 * outline only. `selected > hovered` is the precedence every mark layer shares,
 * so a cell never carries two stacked strokes.
 */
export const MultiSelectedAndHovered: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} cursor="none">
      <Selector
        enabled={false}
        selected={[tempCell(60, 'low'), tempCell(150, 'high')]}
        hovered={[
          tempCell(150, 'high'),
          tempCell(151, 'high'),
          tempCell(152, 'high'),
          tempCell(153, 'high'),
        ]}
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
      </Selector>
    </ChartContainer>
  ),
};

/**
 * **Shape 3 — a `ValueSeries`, one column.** The x axis is value intervals
 * rather than time: here the record re-keyed onto its own daily high, so the
 * cells bin by temperature instead of by date. Nothing about the layer
 * changes — `xKind` is inferred from the series type, exactly as `<BarChart>`
 * infers it.
 *
 * The rows are **sorted by high** first. A value axis must be non-decreasing —
 * it is the key — so `sf.byValue('high')` on the record in *date* order throws
 * (`byValue: axis 'high' must be non-decreasing`), which is what this story used
 * to do before it had a render smoke test to notice. Re-keying is a projection,
 * not a sort; the caller owns the ordering.
 */
const byHighAscending = (() => {
  const high = sf.column('high');
  const low = sf.column('low');
  const order = Array.from({ length: sf.length }, (_, i) => i).sort(
    (a, b) => (high.read(a) ?? NaN) - (high.read(b) ?? NaN),
  );
  return ValueSeries.fromColumns({
    name: 'byHigh',
    schema: [
      { name: 'high', kind: 'value' },
      { name: 'low', kind: 'number' },
    ] as const,
    columns: {
      high: order.map((i) => high.read(i)!),
      low: order.map((i) => low.read(i)!),
    },
  });
})();

export const ValueAxisStripe: Story = {
  render: () => {
    const byHigh = byHighAscending;
    const axis = byHigh.axisValues();
    return (
      <ChartContainer
        range={[axis[0]!, axis[axis.length - 1]!]}
        width={720}
        cursor="none"
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
    <ChartContainer range={RANGE} width={720} cursor="none">
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
        cursor="none"
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
function ExpressionGrid({ panZoom }: { panZoom?: 'none' | 'panZoomY' }) {
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
    <ChartContainer width={440} cursor="none" panZoom={panZoom ?? 'none'}>
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
}

/** The transpose on its own — bins down y, columns as categories across x. */
export const Horizontal: Story = { render: () => <ExpressionGrid /> };

/**
 * **`panZoom="panZoomY"`** — wheel to zoom the bin axis, drag to pan it.
 *
 * `panZoomY` and not `panZoomXY`, because x here is a **category** axis: eight
 * samples, with no continuous domain to zoom. Asking for `panZoomXY` would name
 * an axis that cannot move, the aspect ratio would change anyway, and nothing
 * would say so — which is exactly what the earlier single `panZoom2D` mode did
 * before the modes spelled out their axes.
 *
 * So the ratio changing here is correct and declared. Reach for `panZoomXY` when
 * both axes really are continuous — a scatter, or a heat map binned on both —
 * and it holds the ratio with one factor about the cursor.
 */
export const PanZoomY: Story = {
  render: () => <ExpressionGrid panZoom="panZoomY" />,
};

/**
 * **`panZoom="panZoomXY"`** — wheel zooms **both** axes about the cursor, drag
 * pans both, and the aspect ratio holds.
 *
 * Both axes have to be continuous for `XY` to mean anything, which is why this
 * is a separate story from `PanZoomY` rather than a prop flip on it: that one
 * has eight sample *categories* across x, so naming `XY` there would name an
 * axis that cannot move. Here x is a real time axis and y is 60 rows, so there
 * is something to zoom in both directions.
 *
 * What to check, since one factor drives both axes:
 *
 * - A cell that looks square stays square as you zoom. That is the aspect lock,
 *   and it is the difference between `panZoomXY` and asking for each axis
 *   separately.
 * - Zoom about a corner and that corner stays put — the pivot is the cursor, not
 *   the plot centre.
 * - Drag past the end and it stops at the data rather than running into blank
 *   canvas.
 */
export const PanZoomXY: Story = {
  render: () => {
    const N = 300;
    const ROWS = Array.from({ length: 60 }, (_, i) => `r${i}`);
    const columns: Record<string, number[]> = {
      time: Array.from({ length: N }, (_, i) => Date.UTC(2024, 0, 1 + i)),
    };
    ROWS.forEach((r, g) => {
      // Diagonal banding, so a shear or a squash is obvious the moment the
      // aspect ratio slips.
      columns[r] = Array.from(
        { length: N },
        (_, i) => 50 + 45 * Math.sin((i / 9 + g / 5) * 0.7),
      );
    });
    const series = TimeSeries.fromColumns({
      name: 'grid',
      schema: [
        { name: 'time', kind: 'time' },
        ...ROWS.map((r) => ({ name: r, kind: 'number' as const })),
      ] as const,
      columns,
    });
    const t = columns.time!;
    return (
      <ChartContainer
        range={[t[0]!, t[N - 1]!]}
        width={620}
        cursor="none"
        panZoom="panZoomXY"
      >
        <ChartRow height={420}>
          {/* Explicit ticks rather than the layer's `binCategories`: 60 rows in
              420px is 7px each, so labelling every one smears them together.
              Sparse numbers also make the y zoom legible — you can watch the
              span narrow. */}
          <YAxis
            id="v"
            label="row"
            ticks={[0, 15, 30, 45, 60].map((n) => ({
              at: n,
              label: String(n),
            }))}
          />
          <Layers>
            <HeatMap series={series} columns={ROWS} colors={RAMP} axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
