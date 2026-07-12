import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';
import type { SelectInfo } from './context.js';

const N = 24;
/** Fixed base epoch (2026-01-01 00:00 UTC) + hourly buckets → deterministic. */
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOUR = 3_600_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + N * HOUR];

const bucketSchema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'count', kind: 'number' },
] as const;

/**
 * Hourly request volume as a **timeRange-keyed** series: each event's key spans
 * one hour `[h, h+1)`, so each bar fills its bucket. The shape is a daily
 * traffic curve (quiet overnight, a morning ramp, a midday peak). The kind of
 * series a pond `window`/`aggregate` rollup produces.
 */
function hourlyVolume() {
  const rows: Array<[[number, number], number]> = [];
  for (let i = 0; i < N; i += 1) {
    const begin = BASE + i * HOUR;
    // Deterministic daily curve: a broad daytime hump + a smaller wiggle.
    const hump = 60 * Math.max(0, Math.sin(((i - 6) / 18) * Math.PI));
    const wiggle = 8 + 6 * Math.sin(i * 1.7);
    rows.push([[begin, begin + HOUR], Math.round(hump + wiggle)]);
  }
  return new TimeSeries({ name: 'volume', schema: bucketSchema, rows });
}

/**
 * A net-flow series straddling zero (timeRange-keyed): hourly inflow minus
 * outflow, some hours net-positive, some net-negative. Drives the diverging-bar
 * baseline — `barExtent` pulls `0` into the domain so the bars grow up from /
 * hang down off the zero line.
 */
function netFlow() {
  const rows: Array<[[number, number], number]> = [];
  for (let i = 0; i < N; i += 1) {
    const begin = BASE + i * HOUR;
    const v = Math.round(
      40 * Math.sin((i / N) * 2 * Math.PI) + 12 * Math.sin(i * 1.3),
    );
    rows.push([[begin, begin + HOUR], v]);
  }
  return new TimeSeries({ name: 'flow', schema: bucketSchema, rows });
}

const meta = {
  title: 'Charts/BarChart',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * The primary form: an interval-keyed series, one bar per bucket spanning its
 * hour, resting on the zero line (the auto-fit domain includes `0`). The `gap`
 * insets each bar so the buckets read as discrete columns.
 */
export const Buckets: Story = {
  render: () => {
    const v = hourlyVolume();
    return (
      <ChartContainer range={TIME_RANGE} width={640} theme={docsTheme}>
        <ChartRow height={240}>
          <YAxis id="count" label="req" min={0} />
          <Layers>
            <BarChart series={v} column="count" gap={3} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * Diverging bars: a series that straddles zero grows up for positive values and
 * hangs down for negative ones, both off the zero baseline (pulled into the
 * domain). No per-bar colour — the single styling channel still applies; sign is
 * read from position, not hue.
 */
export const Diverging: Story = {
  render: () => {
    const f = netFlow();
    return (
      <ChartContainer range={TIME_RANGE} width={640} theme={docsTheme}>
        <ChartRow height={240}>
          <YAxis id="flow" label="net" />
          <Layers>
            <BarChart series={f} column="count" gap={3} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Hover + select.** Hover the plot — the bar **under the cursor** lights up
 * (hover-highlight) and a flag rises from its top-centre with the value
 * (`cursor='flag'`). Click a bar — it stays lit **with an outline** and the panel
 * above shows the selection; click empty space to clear. Hover and select both
 * resolve by containment (the flag reads the same bar you click) and match the
 * bar's key **and** this series' label, so they're unambiguous across series
 * sharing a timestamp.
 */
function HoverSelectDemo() {
  const v = hourlyVolume();
  const [sel, setSel] = useState<SelectInfo | null>(null);
  const clock =
    sel === null ? '' : new Date(sel.key).toISOString().slice(11, 16);
  return (
    <div>
      <div
        style={{
          height: '18px',
          marginBottom: '8px',
          display: 'flex',
          gap: '16px',
          fontFamily: docsTheme.font.family,
          fontSize: '12px',
          color: docsTheme.axis.label,
        }}
      >
        {sel === null ? (
          <span style={{ opacity: 0.5 }}>click a bar…</span>
        ) : (
          <span style={{ color: sel.color }}>
            {clock} UTC · {sel.label} {sel.value}
          </span>
        )}
      </div>
      <ChartContainer
        range={TIME_RANGE}
        width={640}
        theme={docsTheme}
        cursor="flag"
        onSelect={setSel}
      >
        <ChartRow height={240}>
          <YAxis id="count" label="req" min={0} />
          <Layers>
            <BarChart series={v} column="count" id="count" gap={3} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const HoverSelect: Story = {
  render: () => <HoverSelectDemo />,
};

/**
 * **Controlled selection.** The other half of the select API: the app pins the
 * selection via the `selected` prop (here the 12:00 bar), the way a master/detail
 * view or a deep-link would. The matching bar draws highlighted with no click —
 * the select-analog of the controlled tracker. The `SelectInfo` carries the bar's
 * key (its `begin`), value, the resolved fill colour, and the series label.
 */
export const ControlledSelection: Story = {
  render: () => {
    const v = hourlyVolume();
    const key = BASE + 12 * HOUR;
    const value = v.nearest(key)!.get('count') as number;
    const pinned: SelectInfo = {
      id: 'count',
      key,
      value,
      color: docsTheme.bar.default.fill,
      label: 'count',
    };
    return (
      <ChartContainer
        range={TIME_RANGE}
        width={640}
        theme={docsTheme}
        selected={pinned}
      >
        <ChartRow height={240}>
          <YAxis id="count" label="req" min={0} />
          <Layers>
            <BarChart series={v} column="count" id="count" gap={3} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
