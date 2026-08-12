import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { AreaChart } from './AreaChart.js';
import { YAxis } from './YAxis.js';
import { Selector } from './selectors.js';
import type { SelectInfo } from './context.js';

/**
 * **Threshold banding on an area** ([PND-BANDAREA]) — the fill (and the value
 * line on its top edge) coloured *along its height* against a ladder, so every
 * stretch of the series shows which zone it sits in: low / medium / high as
 * bands that switch exactly at the breakpoints.
 *
 * One hard-stop gradient carries the whole ladder, which is what keeps this
 * **one area**: one hit region, one legend row, one readout identity — where
 * the workaround (N clipped `<AreaChart>` layers) splits all three. Same
 * currency as `<BarChart thresholds>` ([PND-BANDBAR2]): breakpoints are data
 * and live on the prop; band fills come from `AreaStyle.bands` on the theme
 * role, overridable per chart with `bandColors`.
 */
const meta = {
  title: 'Areas/Thresholds',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const BASE = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

/** A diurnal-ish load curve crossing a 1 / 2 ladder — deterministic. */
function load(n = 48) {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    rows.push([
      BASE + i * HOUR,
      1.8 + 1.4 * Math.sin((i / n) * Math.PI * 2) + 0.25 * Math.sin(i / 1.7),
    ]);
  }
  return new TimeSeries({
    name: 'load',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

/** The same shape with both signs — net flow against the zero axis. */
function flow(n = 48) {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    rows.push([
      BASE + i * HOUR,
      2.6 * Math.sin((i / n) * Math.PI * 4) + 0.3 * Math.sin(i / 2.1),
    ]);
  }
  return new TimeSeries({
    name: 'flow',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

/** Load with a dropout — a run of missing values mid-window. */
function loadWithGap(n = 48) {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < n; i += 1) {
    const inGap = i >= 18 && i < 26;
    rows.push([
      BASE + i * HOUR,
      inGap
        ? undefined
        : 1.8 +
          1.4 * Math.sin((i / n) * Math.PI * 2) +
          0.25 * Math.sin(i / 1.7),
    ]);
  }
  return new TimeSeries({
    name: 'load',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

const RANGE: [number, number] = [BASE, BASE + 47 * HOUR];
const BANDS = ['#2f9e6e', '#e0a13c', '#d05353'];

// ── Per-prop fan-out ────────────────────────────────────────────────────────

/**
 * **Default.** The docs call, verbatim: two breakpoints, no colours supplied —
 * the ladder resolves from `theme.area.default.bands` (the default theme's
 * teal → amber → red). The curve travels through all three zones and the
 * outline switches hue exactly where it crosses 1 and 2.
 */
export const Default: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <AreaChart series={load()} column="v" thresholds={[1, 2]} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **`bandColors`.** The call-site override for a one-off ladder that shouldn't
 * mint a theme role — same split as the bar's: breakpoints are data, colour
 * stays themeable.
 */
export const BandColors: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <AreaChart
            series={load()}
            column="v"
            thresholds={[1, 2]}
            bandColors={BANDS}
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
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <AreaChart
            series={load()}
            column="v"
            thresholds={[2]}
            bandColors={['#2f9e6e', '#d05353']}
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
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <AreaChart
            series={load()}
            column="v"
            thresholds={[0.7, 1.4, 2.1, 2.8]}
            bandColors={['#2f9e6e', '#8fbf5a', '#e0a13c', '#d97b45', '#d05353']}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Signed.** An above/below-axis area (`baseline={0}`) walks the same
 * ±ladder without negative breakpoints: the ladder is on the magnitude, so
 * the deep-negative swings band red exactly as the deep-positive ones do.
 */
export const Signed: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={-3.2} max={3.2} />
        <Layers>
          <AreaChart
            series={flow()}
            column="v"
            baseline={0}
            thresholds={[1, 2]}
            bandColors={BANDS}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Smoothing curve.** Banding rides the paint, not the geometry — a
 * `monotone` edge bands identically, and the hue still switches exactly at
 * the breakpoint heights (the gradient is in pixel space, not per-segment).
 */
export const MonotoneCurve: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <AreaChart
            series={load()}
            column="v"
            curve="monotone"
            thresholds={[1, 2]}
            bandColors={BANDS}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Gaps compose.** The fill and outline break at the dropout as ever; the
 * inferred `dashed` connector keeps the role's line colour rather than a zone
 * colour — it is a guess about absent data, and zone ink would over-claim
 * exactly where nothing was measured.
 */
export const WithGaps: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <AreaChart
            series={loadWithGap()}
            column="v"
            gaps="dashed"
            thresholds={[1, 2]}
            bandColors={BANDS}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Log axis.** Breakpoints are positive by construction, so they always have
 * a position on a log scale; the negative mirrors don't exist there and are
 * simply not drawn. The band heights follow the axis's own spacing — wider
 * apart near the bottom, compressed at the top.
 */
export const LogAxis: Story = {
  render: () => {
    const rows: Array<[number, number]> = [];
    for (let i = 0; i < 48; i += 1) {
      rows.push([
        BASE + i * HOUR,
        Math.exp(0.9 + 0.85 * Math.sin((i / 48) * Math.PI * 2)) / 2,
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
      <ChartContainer range={RANGE} width={640}>
        <ChartRow height={240}>
          <YAxis id="v" label="" scale="log" min={0.2} max={4} />
          <Layers>
            <AreaChart
              series={series}
              column="v"
              thresholds={[1, 2]}
              bandColors={BANDS}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Selection.** Click the area. A banded area is still **one** area:
 * wherever in the ladder you click, the same series-scoped selection comes
 * back, and the emphasis strengthens the fill while keeping the band colours
 * — one hue would erase the very thing the bands encode.
 */
function SelectDemo() {
  const [sel, setSel] = useState<SelectInfo | null>(null);
  return (
    <div>
      <ChartContainer range={RANGE} width={640}>
        <Selector selected={sel} onSelect={setSel}>
          <ChartRow height={240}>
            <YAxis id="v" label="" min={0} max={3.6} />
            <Layers>
              <AreaChart
                series={load()}
                column="v"
                id="load"
                thresholds={[1, 2]}
                bandColors={BANDS}
              />
            </Layers>
          </ChartRow>
        </Selector>
      </ChartContainer>
      <p style={{ font: '13px system-ui', color: '#888' }}>
        selected: {sel?.mark ?? '—'}
      </p>
    </div>
  );
}

export const Selectable: Story = { render: () => <SelectDemo /> };

/**
 * **Unsorted breakpoints are sorted, not rejected.** `[2, 1]` and `[1, 2]`
 * describe the same three bands — the bands are defined by their boundaries,
 * so there is no second reading to guess at. Renders identically to
 * `BandColors`.
 */
export const UnsortedThresholds: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={640}>
      <ChartRow height={240}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <AreaChart
            series={load()}
            column="v"
            thresholds={[2, 1]}
            bandColors={BANDS}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
