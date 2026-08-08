import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { XAxis } from './XAxis.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';
import { defaultTheme } from './theme.js';
import type { SelectInfo } from './context.js';

/**
 * **Threshold banding** ([PND-BANDBAR2]) — one bar coloured *along its length*
 * against a ladder, so a long bar shows how far through the ladder it
 * travelled rather than only which band it ended in.
 *
 * The alternative is N `<BarChart>` layers drawn outermost-first, each clipped
 * to a band, compositing the gradient by overpainting. That produces the same
 * pixels and loses the thing that matters: N layers means N hit targets, N
 * `SelectInfo.mark` identities and N legend rows for what the reader sees as
 * one bar. `thresholds` keeps it one bar.
 *
 * Breakpoints are data and live on the prop; band fills come from
 * `BarStyle.bands` on the resolved theme role, overridable per chart with
 * `bandColors`.
 */
const meta = {
  title: 'Bars/Thresholds',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** Capacity used per service, in arbitrary units against a 1 / 2 ladder. */
const LOAD = [
  { label: 'api', value: 2.7 },
  { label: 'auth', value: 1.4 },
  { label: 'cache', value: 0.6 },
  { label: 'db', value: 3.2 },
  { label: 'queue', value: 1.05 },
  { label: 'search', value: 0.3 },
];

/** The same shape with both signs — net flow rather than a magnitude. */
const FLOW = [
  { label: 'api', value: 2.7 },
  { label: 'auth', value: -1.4 },
  { label: 'cache', value: 0.6 },
  { label: 'db', value: -3.2 },
  { label: 'queue', value: 1.05 },
  { label: 'search', value: -0.3 },
];

const BANDS = ['#2f9e6e', '#e0a13c', '#d05353'];

// ── Per-prop fan-out ────────────────────────────────────────────────────────

/**
 * **Default.** Two breakpoints ⇒ three bands. `db` (3.2) crosses the whole
 * ladder and shows all three; `cache` (0.6) never leaves the first, so only
 * one rect is drawn for it — a band a bar doesn't reach isn't painted.
 */
export const Default: Story = {
  render: () => (
    <ChartContainer width={640} theme={docsTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <BarChart
            categories={LOAD}
            thresholds={[1, 2]}
            bandColors={BANDS}
            gap={6}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **One threshold.** The minimal ladder — two bands, a plain ok/over split.
 */
export const SingleThreshold: Story = {
  render: () => (
    <ChartContainer width={640} theme={docsTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <BarChart
            categories={LOAD}
            thresholds={[2]}
            bandColors={['#2f9e6e', '#d05353']}
            gap={6}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **A longer ladder.** Four breakpoints ⇒ five bands. Nothing about the
 * geometry is fixed at three; the ladder is however long the caller makes it.
 */
export const FiveBands: Story = {
  render: () => (
    <ChartContainer width={640} theme={docsTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <BarChart
            categories={LOAD}
            thresholds={[0.7, 1.4, 2.1, 2.8]}
            bandColors={['#2f9e6e', '#8fbf5a', '#e0a13c', '#d97b45', '#d05353']}
            gap={6}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Themed, no `bandColors`.** The ladder resolves from
 * `theme.bar.default.bands` — the design-system path. This story uses the
 * library default theme, whose ladder is the bar's own **teal** (the resting
 * fill of the interaction-state palette) → amber → red.
 */
export const FromTheme: Story = {
  render: () => (
    <ChartContainer width={640} theme={defaultTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <BarChart categories={LOAD} thresholds={[1, 2]} gap={6} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Per-role ladder.** `as="capacity"` resolves `theme.bar.capacity`, so two
 * bar roles in one chart can walk different ladders — the reason the ladder
 * lives on `BarStyle` rather than as a single `theme.bar.bands` sibling.
 */
export const PerRoleLadder: Story = {
  render: () => {
    const theme = {
      ...docsTheme,
      bar: {
        ...docsTheme.bar,
        capacity: {
          ...docsTheme.bar.default,
          bands: ['#4a7fb5', '#e0a13c', '#d05353'],
        },
      },
    };
    return (
      <ChartContainer width={640} theme={theme}>
        <ChartRow height={240}>
          <YAxis id="v" label="" min={0} max={3.6} />
          <Layers>
            <BarChart
              categories={LOAD}
              as="capacity"
              thresholds={[1, 2]}
              gap={6}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Negative values band symmetrically.** The ladder is walked on the
 * magnitude and re-signed, so a bar hanging below the baseline reads the same
 * ±ladder — no negative breakpoints needed. This is the diverging case.
 */
export const Signed: Story = {
  render: () => (
    <ChartContainer width={640} theme={docsTheme}>
      <ChartRow height={260}>
        <YAxis id="v" label="" min={-3.6} max={3.6} />
        <Layers>
          <BarChart
            categories={FLOW}
            thresholds={[1, 2]}
            bandColors={BANDS}
            gap={6}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Horizontal.** The transposed path — bands slice along x while the bin span
 * runs down y. The `<YAxis>` derives one tick per category ([PND-HCAT]).
 */
export const Horizontal: Story = {
  render: () => (
    // `showAxis={false}` because the explicit <XAxis> below is the value axis;
    // leaving the container's implicit one on renders the ticks twice.
    <ChartContainer width={640} theme={docsTheme} showAxis={false}>
      <ChartRow height={260}>
        <YAxis id="v" label="" />
        <Layers>
          <BarChart
            categories={LOAD}
            orientation="horizontal"
            thresholds={[1, 2]}
            bandColors={BANDS}
            gap={6}
          />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/**
 * **On a time series.** Banding isn't categorical-only — any single-value bar
 * takes it, including a time-bucketed histogram.
 */
export const TimeSeriesBars: Story = {
  render: () => {
    const BASE = Date.UTC(2026, 0, 1);
    const HOUR = 3_600_000;
    const rows: Array<[number, number]> = [];
    for (let i = 0; i < 24; i += 1) {
      rows.push([
        BASE + i * HOUR,
        1.8 + 1.4 * Math.sin((i / 24) * Math.PI * 2),
      ]);
    }
    const series = new TimeSeries({
      name: 'load',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows,
    });
    return (
      <ChartContainer
        range={[BASE, BASE + 24 * HOUR]}
        width={640}
        theme={docsTheme}
        showAxis={false}
      >
        <ChartRow height={220}>
          <YAxis id="v" label="" min={0} max={3.6} />
          <Layers>
            <BarChart
              series={series}
              column="v"
              thresholds={[1, 2]}
              bandColors={BANDS}
            />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>
    );
  },
};

/**
 * **Selection.** Click a bar. A banded bar is still **one** bar: wherever in
 * the ladder you click, the same `SelectInfo.mark` comes back, and the outline
 * takes the colour of the band the value actually reached. The overpaint
 * workaround returns a different layer's selection per band.
 */
function SelectDemo() {
  const [sel, setSel] = useState<SelectInfo | null>(null);
  return (
    <div>
      <ChartContainer
        width={640}
        theme={docsTheme}
        selected={sel}
        onSelect={setSel}
      >
        <ChartRow height={240}>
          <YAxis id="v" label="" min={0} max={3.6} />
          <Layers>
            <BarChart
              categories={LOAD}
              id="load"
              thresholds={[1, 2]}
              bandColors={BANDS}
              gap={6}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
      <p style={{ font: '13px system-ui', color: '#888' }}>
        selected: {sel?.mark ?? '—'}
      </p>
    </div>
  );
}

export const Selectable: Story = { render: () => <SelectDemo /> };

/**
 * **Yields to `binColors`.** Both set is a conflict — two answers to "what
 * colour is this bar" — so the more specific per-bar array wins and the chart
 * dev-warns rather than silently picking one. Shown so the precedence is
 * visible rather than discovered.
 */
export const YieldsToBinColors: Story = {
  render: () => (
    <ChartContainer width={640} theme={docsTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <BarChart
            categories={LOAD}
            thresholds={[1, 2]}
            bandColors={BANDS}
            binColors={[
              '#6b7fa8',
              '#6b7fa8',
              '#6b7fa8',
              '#6b7fa8',
              '#6b7fa8',
              '#6b7fa8',
            ]}
            gap={6}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Unsorted breakpoints are sorted, not rejected.** `[2, 1]` and `[1, 2]`
 * describe the same three bands — the bands are defined by their boundaries,
 * so there is no second reading to guess at. Renders identically to `Default`.
 */
export const UnsortedThresholds: Story = {
  render: () => (
    <ChartContainer width={640} theme={docsTheme}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <BarChart
            categories={LOAD}
            thresholds={[2, 1]}
            bandColors={BANDS}
            gap={6}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
