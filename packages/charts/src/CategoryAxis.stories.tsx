import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { transposeRow } from './data.js';
import { estelaTheme } from './theme.js';
import type { SelectInfo } from './context.js';

/**
 * The **ordinal category x-axis** (categorical-axis RFC, Phase 1): one bar per
 * category on a first-class band scale — the transpose view's "columns on x".
 * `<BarChart categories={[{ label, value }]}>` infers `xKind:'category'`; the
 * container builds a {@link ScaleBand} over the labels and the bottom axis ticks
 * once per category. Colour per category with `binColors`.
 */
const meta = {
  title: 'Charts/CategoryAxis',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const TICKERS = [
  { label: 'AAPL', value: 42 },
  { label: 'MSFT', value: 31 },
  { label: 'GOOG', value: 27 },
  { label: 'NVDA', value: 55 },
  { label: 'AMZN', value: 19 },
  { label: 'META', value: 23 },
];

/** estela palette, one hue per category. */
const PALETTE = [
  '#15B3A6',
  '#45CDBE',
  '#7FE2D2',
  '#E0B36A',
  '#C98A5B',
  '#4E6B6B',
];

/**
 * **The category axis.** Six tickers on x, each a bar coloured per category
 * (`binColors`). The x-axis ticks once per category at the band centre — a
 * first-class ordinal axis, not the hand-placed `<XAxis ticks>` hack. Bars are
 * fixed-pitch (the band scale) and inset by `gap`.
 */
export const Tickers: Story = {
  render: () => (
    <ChartContainer width={640} theme={estelaTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="net Δ" min={0} pad={0.08} />
        <Layers>
          <BarChart categories={TICKERS} binColors={PALETTE} gap={6} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Single hue.** Without `binColors` every bar takes the theme's default bar
 * fill — the category axis doesn't require per-bar colour.
 */
export const SingleHue: Story = {
  render: () => (
    <ChartContainer width={640} theme={estelaTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="net Δ" min={0} pad={0.08} />
        <Layers>
          <BarChart categories={TICKERS} gap={6} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **High cardinality (short labels).** ~30 categories — short labels (`S01`…)
 * still fit each slot, so the axis shows them all; the bars stay fixed-pitch.
 */
export const HighCardinality: Story = {
  render: () => {
    const data = Array.from({ length: 30 }, (_, i) => ({
      label: `S${String(i + 1).padStart(2, '0')}`,
      // deterministic hump so the shape reads
      value: Math.round(10 + 40 * Math.abs(Math.sin((i / 30) * Math.PI))),
    }));
    return (
      <ChartContainer width={720} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="v" label="count" min={0} pad={0.08} />
          <Layers>
            <BarChart categories={data} gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Crowded long labels.** ~20 categories with long names that can't all fit —
 * the axis **thins** (keeps every k-th) and **truncates** the kept labels with an
 * ellipsis so they stay legible, while every bar still draws. (Width-estimated,
 * no DOM measure; rotation is a later option.)
 */
export const CrowdedLabels: Story = {
  render: () => {
    const data = Array.from({ length: 20 }, (_, i) => ({
      label: `ACME-DESK-${String(i + 1).padStart(2, '0')}`,
      value: Math.round(15 + 35 * Math.abs(Math.sin((i / 20) * Math.PI + 0.4))),
    }));
    return (
      <ChartContainer width={720} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="v" label="orders" min={0} pad={0.08} />
          <Layers>
            <BarChart categories={data} gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Click a bar.** With an `id` the category bars are selectable; a click reports
 * the **category name** in both `SelectInfo.label` and the stable `SelectInfo.mark`
 * — the per-column identity a controlled `selected` pins on, so it survives a
 * column reorder (the slot index doesn't; the name does).
 */
function SelectDemo() {
  const [sel, setSel] = useState<SelectInfo | null>(null);
  return (
    <div>
      <div
        style={{
          height: 18,
          marginBottom: 8,
          fontFamily: estelaTheme.font.family,
          fontSize: 12,
          color: estelaTheme.axis.label,
        }}
      >
        {sel === null ? (
          <span style={{ opacity: 0.5 }}>click a bar…</span>
        ) : (
          <span style={{ color: sel.color }}>
            {sel.label}: {sel.value}
          </span>
        )}
      </div>
      <ChartContainer width={640} theme={estelaTheme} onSelect={setSel}>
        <ChartRow height={240}>
          <YAxis id="v" label="net Δ" min={0} pad={0.08} />
          <Layers>
            <BarChart
              categories={TICKERS}
              binColors={PALETTE}
              id="tickers"
              gap={6}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const Select: Story = { render: () => <SelectDemo /> };

// ── The transpose reader: read one row of a WIDE series across (PR2) ──

const NAMES = ['AAPL', 'MSFT', 'GOOG', 'NVDA', 'AMZN'] as const;
const N_ROWS = 12;
const BASE = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

/**
 * A **wide** time×category series — one numeric column per ticker, a row per
 * hour. In practice you'd get this from `series.pivotByGroup('ticker', 'value')`
 * (long → wide); here it's built directly with clean column names. Each row is a
 * cross-section; `transposeRow` reads one **across**.
 */
function wideSeries() {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'AAPL', kind: 'number' },
    { name: 'MSFT', kind: 'number' },
    { name: 'GOOG', kind: 'number' },
    { name: 'NVDA', kind: 'number' },
    { name: 'AMZN', kind: 'number' },
  ] as const;
  const rows = Array.from({ length: N_ROWS }, (_, r) => [
    BASE + r * HOUR,
    ...NAMES.map((_n, c) =>
      Math.round(30 + 25 * Math.sin((r / N_ROWS) * Math.PI + c)),
    ),
  ]);
  return new TimeSeries({ name: 'wide', schema, rows: rows as never });
}

/**
 * **The transpose.** `transposeRow(wide, { at: 'last' })` reads the wide series'
 * **head row** across — its columns (the tickers) become the categories, that
 * row's cells the bar heights. The head row is the live snapshot; this is
 * "columns on x" sourced from a real series rather than a hand-written array.
 */
export const Transpose: Story = {
  render: () => {
    const data = transposeRow(wideSeries(), { at: 'last' });
    return (
      <ChartContainer width={640} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="v" label="value" min={0} pad={0.08} />
          <Layers>
            <BarChart categories={data} binColors={PALETTE} gap={6} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Scrub the row.** The same wide series, read at a chosen row index — drag the
 * slider and the bars re-transpose. `transposeRow(wide, { at: rowIndex })` is the
 * only data step; the read-down time chart and this read-across bar chart are two
 * views of one matrix. (Binding the row to a shared **time cursor** — scrub a
 * sibling time chart and this animates — is Phase 2; here it's driven by hand.)
 */
function ScrubDemo() {
  const wide = useMemo(() => wideSeries(), []);
  const [row, setRow] = useState(N_ROWS - 1);
  const data = useMemo(() => transposeRow(wide, { at: row }), [wide, row]);
  return (
    <div>
      <div
        style={{
          marginBottom: 8,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          fontFamily: estelaTheme.font.family,
          fontSize: 12,
          color: estelaTheme.axis.label,
        }}
      >
        <span>
          row {row} · {new Date(BASE + row * HOUR).toISOString().slice(11, 16)}{' '}
          UTC
        </span>
        <input
          type="range"
          min={0}
          max={N_ROWS - 1}
          value={row}
          onChange={(e) => setRow(Number(e.target.value))}
        />
      </div>
      <ChartContainer width={640} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="v" label="value" min={0} pad={0.08} />
          <Layers>
            <BarChart categories={data} binColors={PALETTE} gap={6} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const TransposeScrub: Story = { render: () => <ScrubDemo /> };
