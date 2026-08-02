import type { Meta, StoryObj } from '@storybook/react-vite';
import { BoxList } from './BoxList.js';
import { estelaTheme } from './theme.js';
import type { ListRow } from './list.js';

/**
 * Feature fan-out for `<BoxList>` — one story per knob (see `Lists/BarList`
 * for the shared table knobs exercised there: sort variants, cells, expander,
 * selection, dividers). Here the box-specific states: full five-number box,
 * range-only, tick/label presence, multi-column, theme roles.
 */
const meta: Meta<typeof BoxList> = {
  title: 'Lists/BoxList',
  component: BoxList,
  // A fixed-width stage: the list is a width-filling table, so give it a real
  // width to fill (a bare story canvas would let the glyph tracks collapse).
  decorators: [
    (Story) => (
      <div style={{ width: 720 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof BoxList>;

const fmt = (v: number) => `${v.toFixed(0)} ms`;

/** Hand-built five-number latency summaries per service + a current tick. */
const services: ListRow[] = [
  {
    key: 'api',
    values: { p5: 12, p25: 25, p50: 34, p75: 48, p95: 90, now: 41 },
  },
  {
    key: 'auth',
    values: { p5: 8, p25: 14, p50: 19, p75: 27, p95: 44, now: 66 },
  },
  {
    key: 'search',
    values: { p5: 40, p25: 78, p50: 110, p75: 160, p95: 260, now: 130 },
  },
  {
    key: 'billing',
    values: { p5: 20, p25: 31, p50: 38, p75: 52, p95: 71, now: 35 },
  },
];

const FULL = {
  lower: 'p5',
  q1: 'p25',
  median: 'p50',
  q3: 'p75',
  upper: 'p95',
  value: 'now',
  format: fmt,
} as const;

/** The full grammar: range band (p5→p95), body (p25→p75), median line, and
 *  the current-value tick with its printed label. */
export const Default: Story = {
  render: () => <BoxList rows={services} columns={[FULL]} />,
};

/** Range-only (`lower`/`upper`, no body) — the whisker-band look. */
export const RangeOnly: Story = {
  render: () => (
    <BoxList
      rows={services}
      columns={[{ lower: 'p5', upper: 'p95', value: 'now', format: fmt }]}
    />
  ),
};

/** Body without a median line (omit the `median` name). */
export const NoMedian: Story = {
  render: () => (
    <BoxList
      rows={services}
      columns={[{ lower: 'p5', q1: 'p25', q3: 'p75', upper: 'p95' }]}
    />
  ),
};

/** Distribution only — no `value`, so no tick and no printed number. */
export const NoTick: Story = {
  render: () => (
    <BoxList
      rows={services}
      columns={[
        { lower: 'p5', q1: 'p25', median: 'p50', q3: 'p75', upper: 'p95' },
      ]}
    />
  ),
};

/** A tick without `format` draws the marker but prints nothing. */
export const TickNoLabel: Story = {
  render: () => (
    <BoxList
      rows={services}
      columns={[{ lower: 'p5', upper: 'p95', value: 'now' }]}
    />
  ),
};

/** Two distributions per row (say, read vs write latency), the second on the
 *  `secondary` role — one shared scale across both. */
export const MultiColumn: Story = {
  render: () => {
    const rows: ListRow[] = services.map((s) => ({
      ...s,
      values: {
        ...s.values,
        w_lo: (s.values.p5 as number) * 1.6,
        w_hi: (s.values.p95 as number) * 1.4,
        w_now: (s.values.now as number) * 1.5,
      },
    }));
    return (
      <BoxList
        rows={rows}
        columns={[
          FULL,
          {
            lower: 'w_lo',
            upper: 'w_hi',
            value: 'w_now',
            format: fmt,
            as: 'secondary',
          },
        ]}
      />
    );
  },
};

/** Ranking by the *current* value — `sortBy` names any `values` entry, so any
 *  stat can drive the order (here `now`; a `p95` rank is one string away). */
export const SortByCurrent: Story = {
  render: () => <BoxList rows={services} columns={[FULL]} sortBy="now" />,
};

/** The origin baseline is on by default (box lines float at `lower`, so the
 *  shared origin is what relates rows); `baseline={false}` drops the rule. */
export const NoBaseline: Story = {
  render: () => <BoxList rows={services} columns={[FULL]} baseline={false} />,
};

/** A row with no data keeps its slot as an empty line — absence, not zero. */
export const MissingData: Story = {
  render: () => (
    <BoxList
      rows={[
        ...services.slice(0, 2),
        { key: 'legacy', values: {} } satisfies ListRow,
      ]}
      columns={[FULL]}
    />
  ),
};

/** The estela dark register: teal default + filament `secondary`. */
export const EstelaTheme: Story = {
  render: () => (
    <div style={{ background: '#06191D', padding: 16 }}>
      <BoxList
        rows={services}
        columns={[FULL, { lower: 'p5', upper: 'p95', as: 'secondary' }]}
        sortBy="now"
        theme={estelaTheme}
      />
    </div>
  ),
};
