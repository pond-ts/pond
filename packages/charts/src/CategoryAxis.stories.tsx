import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
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
 * **High cardinality.** ~30 categories on one axis — the labels crowd at this
 * density (the thin / truncate / rotate label policy is the Phase 1 PR3
 * follow-on); the bars themselves stay fixed-pitch and readable.
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
 * **Click a bar.** With an `id` the category bars are selectable; a click reports
 * the **category name** (`SelectInfo.label`). (A stable per-column identity is the
 * PR3 follow-on; the `key` is the slot index for now.)
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
