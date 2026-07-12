import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';
import { docsTheme } from './docs-theme.fixture.js';

const N = 60;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step, so the time axis
 *  shows wall-clock labels and the visual baselines stay deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** A deterministic sine series for layout fixtures. */
function demo(phase = 0, amp = 40, mid = 50) {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1)
    rows.push([BASE + i * STEP, mid + amp * Math.sin(i / 5 + phase)]);
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

/**
 * Stories for the layout system (`ChartContainer` / `ChartRow` / `YAxis` /
 * `Layers`) rather than a single chart's data. They double as the visual
 * baselines for the row + axis layout, and grow as features land (dual-axis,
 * estela-shaped — M2.4).
 */
const meta = {
  title: 'Layout',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** Baseline: one row, no axis — the plot fills the full container width. */
export const SingleRow: Story = {
  render: () => {
    const series = demo();
    return (
      <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
        <ChartRow height={200}>
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * One left y-axis: the gutter reserves space, the plot shrinks, and ticks read
 * the row's scale. The line names no `axis`, so it binds to the first (default)
 * axis.
 */
export const LeftAxis: Story = {
  render: () => {
    const series = demo();
    return (
      <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
        <ChartRow height={200}>
          <YAxis id="value" label="v" />
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * Two y-axes with independent scales — a left axis and a right one (authored
 * *after* `<Layers>`). Each line links to its own axis via `axis="…"`, so the
 * two series share the time axis but read different y-domains. `as="secondary"`
 * gives the right-axis line its own colour — style (`as`) and scale (`axis`)
 * are separate.
 */
export const DualAxis: Story = {
  render: () => {
    const temp = demo(0, 8, 20); // ~12–28
    const humidity = demo(2, 28, 58); // ~30–86
    return (
      <ChartContainer range={TIME_RANGE} width={560} theme={docsTheme}>
        <ChartRow height={220}>
          <YAxis id="temp" label="°C" />
          <Layers>
            <LineChart series={temp} column="v" axis="temp" />
            <LineChart
              series={humidity}
              column="v"
              axis="humidity"
              as="secondary"
            />
          </Layers>
          <YAxis id="humidity" side="right" label="%" />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Proof that each line is bound to its own axis's scale.** The *same* series
 * (values ~2–22) is drawn twice: once against a left `0–25` axis, once against a
 * right `0–100` axis. Identical data, two scales → the `0–25` line rides high
 * (22 is near the top of 25) while the `0–100` line sits low (22 is ~a fifth up
 * 100). If the `axis` binding were broken — both lines reading one scale — the
 * two curves would overlap exactly; their divergence is the test. (`DualAxis`
 * can't show this: each line auto-fits, so both fill the plot regardless.)
 */
export const SameSeriesTwoAxes: Story = {
  render: () => {
    const series = demo(0, 10, 12); // one series, values ~2–22
    return (
      <ChartContainer range={TIME_RANGE} width={560} theme={docsTheme}>
        <ChartRow height={240}>
          <YAxis id="zoomed" label="0–25" min={0} max={25} />
          <Layers>
            <LineChart series={series} column="v" axis="zoomed" />
            <LineChart series={series} column="v" axis="full" as="secondary" />
          </Layers>
          <YAxis id="full" side="right" label="0–100" min={0} max={100} />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * Three stacked rows on one shared time axis — the canonical dashboard. Each row
 * auto-fits its own y-scale; the single time axis is drawn once at the bottom.
 */
export const MultiRow: Story = {
  render: () => (
    <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
      <ChartRow height={120}>
        <YAxis id="a" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="b" label="v" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="secondary" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="c" label="v" />
        <Layers>
          <LineChart series={demo(3)} column="v" as="context" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * Rows with different gutters still left-align: the top row has a y-axis, the
 * bottom has none, yet both plots start at the same x (and under the time axis)
 * because the container reserves a *uniform* gutter and the axis-less row pads
 * with a spacer.
 */
export const VaryingGutters: Story = {
  render: () => (
    <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
      <ChartRow height={130}>
        <YAxis id="withAxis" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={130}>
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="context" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * The estela shape on `estelaTheme`: a dual-axis activity chart — power (left,
 * `as="foam"` → `--es-foam`) + heart rate (right, `as="hr"` → the warm
 * `--es-filament` accent) — on estela's dark ground with dashed gridlines. The
 * whole look comes from swapping `theme={estelaTheme}`; the chart markup is
 * identical to {@link DualAxis}. This is the "drop-in for estela" proof for M2
 * (the variance band + elevation underlay land in M3).
 */
export const EstelaShaped: Story = {
  render: () => {
    const power = demo(0, 60, 220); // ~160–280 W
    const hr = demo(0.8, 22, 150); // ~128–172 bpm
    return (
      <ChartContainer range={TIME_RANGE} width={560} theme={estelaTheme}>
        <ChartRow height={220}>
          <YAxis id="power" label="W" />
          <Layers>
            <LineChart series={power} column="v" axis="power" as="foam" />
            <LineChart series={hr} column="v" axis="hr" as="hr" />
          </Layers>
          <YAxis id="hr" side="right" label="bpm" />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * Two left axes on one row, different widths (64 + 44). Authored outer→inner —
 * the last `<YAxis>` before `<Layers>` sits against the plot. Each axis gets its
 * own slot; the plot starts after both. Each line binds to its own axis.
 */
export const TwoLeftAxes: Story = {
  render: () => {
    const power = demo(0, 60, 220);
    const hr = demo(0.8, 22, 150);
    return (
      <ChartContainer range={TIME_RANGE} width={560} theme={docsTheme}>
        <ChartRow height={220}>
          <YAxis id="watts" label="W" width={64} />
          <YAxis id="bpm" label="bpm" width={44} />
          <Layers>
            <LineChart series={power} column="v" axis="watts" />
            <LineChart series={hr} column="v" axis="bpm" as="secondary" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **The per-slot rule.** Top row: one wide left axis (80). Bottom row: two
 * narrower left axes (40 outer + 40 inner). Slot 0 (nearest the plot) reserves
 * max(80, 40) = 80, slot 1 reserves 40 → leftGutter = 120 on both, so the plots
 * start at the same x under the one time axis. The bottom row's inner axis is
 * right-aligned within the 80-wide slot 0 (40px slack on its left), so the inner
 * axes share a column. This is the case M2's single-block gutter got wrong.
 */
export const PerSlotAlignment: Story = {
  render: () => (
    <ChartContainer range={TIME_RANGE} width={560} theme={docsTheme}>
      <ChartRow height={130}>
        <YAxis id="wide" label="wide" width={80} />
        <Layers>
          <LineChart series={demo(0)} column="v" axis="wide" />
        </Layers>
      </ChartRow>
      <ChartRow height={130}>
        <YAxis id="outer" label="out" width={40} />
        <YAxis id="inner" label="in" width={40} />
        <Layers>
          <LineChart series={demo(1.5)} column="v" axis="outer" />
          <LineChart
            series={demo(2.5)}
            column="v"
            axis="inner"
            as="secondary"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * Multiple axes on **both** sides with different widths — two left (60 + 44),
 * two right (44 + 56). Each side splits into slots; left axes align flush-right
 * (toward the plot), right axes flush-left. The plot is what's left in the
 * middle, identical across rows.
 */
export const MultiAxisBothSides: Story = {
  render: () => {
    const power = demo(0, 60, 220);
    const hr = demo(0.8, 22, 150);
    const cadence = demo(1.2, 18, 85);
    const temp = demo(2, 8, 20);
    return (
      <ChartContainer range={TIME_RANGE} width={620} theme={docsTheme}>
        <ChartRow height={240}>
          <YAxis id="watts" label="W" width={60} />
          <YAxis id="bpm" label="bpm" width={44} />
          <Layers>
            <LineChart series={power} column="v" axis="watts" as="primary" />
            <LineChart series={hr} column="v" axis="bpm" as="secondary" />
            <LineChart series={cadence} column="v" axis="rpm" as="context" />
            <LineChart series={temp} column="v" axis="degc" as="slow" />
          </Layers>
          <YAxis id="rpm" side="right" label="rpm" width={44} />
          <YAxis id="degc" side="right" label="°C" width={56} />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * `rowGap` on `<ChartContainer>` puts vertical space between rows (but not under
 * the time axis, which still hugs the last row). Three stacked rows, 24px apart.
 */
export const RowGap: Story = {
  render: () => (
    <ChartContainer
      range={TIME_RANGE}
      width={520}
      rowGap={24}
      theme={docsTheme}
    >
      <ChartRow height={110}>
        <YAxis id="a" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={110}>
        <YAxis id="b" label="v" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="secondary" />
        </Layers>
      </ChartRow>
      <ChartRow height={110}>
        <YAxis id="c" label="v" />
        <Layers>
          <LineChart series={demo(3)} column="v" as="context" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * Rows can be different heights — each `<ChartRow>` sets its own `height` (80 /
 * 180 / 120 here). They still left-align on the shared gutter, and the one time
 * axis sits under all of them.
 */
export const DifferentHeights: Story = {
  render: () => (
    <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
      <ChartRow height={80}>
        <YAxis id="a" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" />
        </Layers>
      </ChartRow>
      <ChartRow height={180}>
        <YAxis id="b" label="v" />
        <Layers>
          <LineChart series={demo(1.5)} column="v" as="secondary" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="c" label="v" />
        <Layers>
          <LineChart series={demo(3)} column="v" as="context" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * `showAxis={false}` drops the shared x axis — for a compact, sparkline-style
 * chart, or when the time context comes from elsewhere. The rows keep their
 * heights; the ~22px axis strip is simply omitted.
 */
export const NoTimeAxis: Story = {
  render: () => (
    <ChartContainer
      range={TIME_RANGE}
      width={520}
      showAxis={false}
      theme={docsTheme}
    >
      <ChartRow height={140}>
        <YAxis id="a" label="v" />
        <Layers>
          <LineChart series={demo(0)} column="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Explicit ticks at chosen values.** `ticks={[{ at, label }]}` overrides d3's
 * auto-picked ticks with chosen positions (a coarse 0/25/50/75/100) — labels and
 * gridlines aligned. Same `{ at, label }` shape as `<XAxis ticks>`.
 */
export const ExplicitTicks: Story = {
  render: () => (
    <ChartContainer range={TIME_RANGE} width={520} theme={docsTheme}>
      <ChartRow height={200}>
        <YAxis
          id="value"
          label="v"
          min={0}
          max={100}
          ticks={[0, 25, 50, 75, 100].map((at) => ({ at, label: String(at) }))}
        />
        <Layers>
          <LineChart series={demo()} column="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **A pace axis** — the motivating case for `{ at, label }` ticks. A run is
 * plotted in PACE space: y is **negated sec/km**, so faster sits higher
 * (estela's `DataChart` convention). Auto ticks can't help — the axis wants
 * round-pace positions (4:00, 4:30, …) with `m:ss` labels, which don't fall on
 * the scale's "nice" numbers. Explicit `{ at, label }` ticks place each label
 * at the negated-sec/km value it sits at. (estela `paceTicks`; the feature that
 * unblocks the `DataChart` → charts port.)
 */
export const PaceAxisTicks: Story = {
  render: () => {
    const rows: Array<[number, number]> = [];
    for (let i = 0; i < N; i += 1) {
      const secPerKm = 300 + 45 * Math.sin(i / 6); // ~4:15–5:45 /km
      rows.push([BASE + i * STEP, -secPerKm]); // negate → faster (fewer sec) is higher
    }
    const run = new TimeSeries({
      name: 'run',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'pace', kind: 'number' },
      ] as const,
      rows,
    });
    const mmss = (secKm: number) =>
      `${Math.floor(secKm / 60)}:${String(secKm % 60).padStart(2, '0')}`;
    // round paces 4:00…6:00, each at the negated-sec/km value it plots at
    const ticks = [240, 270, 300, 330, 360].map((secKm) => ({
      at: -secKm,
      label: mmss(secKm),
    }));
    return (
      <ChartContainer range={TIME_RANGE} width={560} theme={docsTheme}>
        <ChartRow height={220}>
          <YAxis id="pace" label="/km" min={-360} max={-240} ticks={ticks} />
          <Layers>
            <LineChart series={run} column="pace" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
