import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sequence, TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { estelaTheme } from './theme.js';
import type { ChartTheme } from './theme.js';
import type { SelectInfo } from './context.js';

/**
 * `<BarChart>` is also pond's **histogram** primitive: stacked bars (a group-by
 * dimension), a `horizontal` orientation (bins on the y axis), and a value-band
 * axis fed from `byColumn`. Every story below builds its data with **pond's own
 * aggregation** — `aggregate` / `partitionBy` / `byColumn` — so the "integrated
 * with the data generation" story is visible in the render, not hidden.
 */
const meta = {
  title: 'Charts/Histogram',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** Fixed base epoch (2026-01-01 00:00 UTC) → deterministic renders. */
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOUR = 3_600_000;

/** A tiny deterministic PRNG so the synthesized data is stable across renders. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ── Example 1: incidents over the past hour, 5-min buckets, stacked by host ──

const HOSTS = ['web-1', 'web-2', 'web-3', 'db-1', 'cache-1'] as const;
/** Ad-hoc per-host colours (no theme role needed — the `colors` escape hatch). */
const HOST_COLORS: Record<string, string> = {
  'web-1': '#7FE2D2',
  'web-2': '#45CDBE',
  'web-3': '#15B3A6',
  'db-1': '#E0B36A',
  'cache-1': '#C98A5B',
};

/** Raw incidents — one row per incident, a `time` key + a `host` column. */
function incidentEvents() {
  const rand = lcg(7);
  const rows: Array<[number, string]> = [];
  for (let i = 0; i < 180; i += 1) {
    const t = BASE + Math.floor(rand() * HOUR);
    const r = rand();
    const host =
      r < 0.34
        ? 'web-1'
        : r < 0.58
          ? 'web-2'
          : r < 0.76
            ? 'web-3'
            : r < 0.9
              ? 'db-1'
              : 'cache-1';
    rows.push([t, host]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return new TimeSeries({
    name: 'incidents',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'host', kind: 'string' },
    ] as const,
    rows,
  });
}

/**
 * `partitionBy('host').aggregate(every 5m, count).toMap()` — the count of
 * incidents per host per 5-minute bucket, one interval-keyed series per host on a
 * shared grid. Exactly the `Map<group, TimeSeries>` `<BarChart series={…}>` reads
 * as a stack.
 */
function incidentsByHost() {
  return incidentEvents()
    .partitionBy('host', { groups: HOSTS })
    .aggregate(
      Sequence.every('5m'),
      { n: { from: 'host', using: 'count' } },
      { range: [BASE, BASE + HOUR] },
    )
    .toMap();
}

/**
 * **Stacked bars from a `Map` of grouped series.** Each 5-minute bucket is a
 * column; the five hosts stack within it (`colors` supplies the per-host hue —
 * the ad-hoc path, no theme role needed). This is the incidents-by-host view.
 */
export const IncidentsStacked: Story = {
  render: () => {
    const byHost = incidentsByHost();
    return (
      <ChartContainer
        range={[BASE, BASE + HOUR]}
        width={660}
        theme={estelaTheme}
      >
        <ChartRow height={260}>
          <YAxis id="count" label="incidents" min={0} pad={0.06} />
          <Layers>
            <BarChart series={byHost} column="n" colors={HOST_COLORS} gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Example 2: risk usage over the hour, 5-min buckets, stacked by risk band ──

const RISK_BANDS = ['safe', 'warn', 'crit'] as const;
/** Green / orange / red — supplied via `colors`. */
const RISK_COLORS: Record<string, string> = {
  safe: '#3FB984',
  warn: '#E0A24A',
  crit: '#D9534F',
};

/** Classify a used/allowed risk fraction into a band. */
function riskBand(usagePct: number): (typeof RISK_BANDS)[number] {
  return usagePct < 75 ? 'safe' : usagePct < 90 ? 'warn' : 'crit';
}

/** Raw risk readings — a `time` key + the resolved `band`. Readings are spread
 *  evenly across the hour and usage drifts up over it, so `crit` (red) grows
 *  toward the right — the rising-risk story reads straight off the stack. */
function riskEvents() {
  const rand = lcg(11);
  const N = 240;
  const rows: Array<[number, string]> = [];
  for (let i = 0; i < N; i += 1) {
    // Even time spread (a small jitter within each slot) → uniform bucket counts.
    const t = BASE + Math.floor(((i + rand() * 0.9) / N) * HOUR);
    const drift = 45 + 50 * (i / N);
    const usage = Math.max(0, Math.min(100, drift + (rand() - 0.5) * 28));
    rows.push([t, riskBand(usage)]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return new TimeSeries({
    name: 'risk',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'band', kind: 'string' },
    ] as const,
    rows,
  });
}

function riskByBand() {
  return riskEvents()
    .partitionBy('band', { groups: RISK_BANDS })
    .aggregate(
      Sequence.every('5m'),
      { n: { from: 'band', using: 'count' } },
      { range: [BASE, BASE + HOUR] },
    )
    .toMap();
}

/**
 * **Stacked by a classified band.** Same shape as the incidents stack, but the
 * groups are risk bands — `safe` (green) / `warn` (orange) / `crit` (red). The
 * shift toward red on the right reads the rising-risk story straight off the
 * stack.
 */
export const RiskBands: Story = {
  render: () => {
    const byBand = riskByBand();
    return (
      <ChartContainer
        range={[BASE, BASE + HOUR]}
        width={660}
        theme={estelaTheme}
      >
        <ChartRow height={260}>
          <YAxis id="count" label="hosts" min={0} pad={0.06} />
          <Layers>
            <BarChart series={byBand} column="n" colors={RISK_COLORS} gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A theme that names the risk bands as `bar` roles — the *other* colour path. */
const riskTheme: ChartTheme = {
  ...estelaTheme,
  bar: {
    ...estelaTheme.bar,
    safe: { ...estelaTheme.bar.default, fill: '#3FB984' },
    warn: { ...estelaTheme.bar.default, fill: '#E0A24A' },
    crit: { ...estelaTheme.bar.default, fill: '#D9534F' },
  },
};

/**
 * **The same stack, coloured from theme roles** (`theme.bar.safe/warn/crit`)
 * instead of a `colors` prop — the convention the other layers follow (colour
 * lives in the theme). Identical render; the colour just comes from a different
 * source.
 */
export const RiskBandsThemeRoles: Story = {
  render: () => {
    const byBand = riskByBand();
    return (
      <ChartContainer range={[BASE, BASE + HOUR]} width={660} theme={riskTheme}>
        <ChartRow height={260}>
          <YAxis id="count" label="hosts" min={0} pad={0.06} />
          <Layers>
            <BarChart series={byBand} column="n" gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Example 3: heart-rate zones — horizontal bars on an ordinal band axis ──

const HR_ZONES = [
  'Recovery',
  'Endurance',
  'Aerobic',
  'Threshold',
  'Max',
] as const;
/** Five zones ⇒ six ascending edges (bpm). */
const HR_EDGES = [90, 120, 140, 160, 175, 200];

/** A ride's heart-rate trace — `hr` sampled every 5 s, `min` = minutes/sample. */
function hrSamples() {
  const rand = lcg(5);
  const rows: Array<[number, number, number]> = [];
  let hr = 118;
  for (let i = 0; i < 720; i += 1) {
    hr += (rand() - 0.47) * 7;
    hr = Math.max(96, Math.min(192, hr));
    rows.push([BASE + i * 5000, hr, 5 / 60]);
  }
  return new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'hr', kind: 'number' },
      { name: 'min', kind: 'number' },
    ] as const,
    rows,
  });
}

/**
 * `byColumn('hr', { edges }, { min: sum })` — minutes spent in each zone. The
 * `inclusive: '(]'` puts a sample on a zone's top edge in the lower zone (the
 * zone convention).
 */
function hrZoneMinutes() {
  return hrSamples().byColumn(
    'hr',
    { edges: HR_EDGES, inclusive: '(]' },
    { min: { from: 'min', using: 'sum' } },
  );
}

/**
 * **Horizontal histogram over an ordinal band axis.** The five zones sit on the
 * y axis (labelled with `<YAxis ticks>` at the slot centres); the bars grow
 * **right** for minutes-in-zone. `ordinal` gives every zone the same slot height
 * regardless of its bpm width, and `orientation="horizontal"` transposes the
 * draw. A horizontal chart puts the value on x, so it stands alone in its
 * container.
 */
export const HeartRateZones: Story = {
  render: () => {
    const bins = hrZoneMinutes();
    const zoneTicks = HR_ZONES.map((label, i) => ({ at: i + 0.5, label }));
    return (
      <ChartContainer width={660} theme={estelaTheme}>
        <ChartRow height={230}>
          <YAxis id="zone" label="zone" width={92} ticks={zoneTicks} />
          <Layers>
            <BarChart
              bins={bins}
              column="min"
              orientation="horizontal"
              ordinal
              colors={{ min: '#15B3A6' }}
              gap={8}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A light→dark ramp, one shade per zone (Recovery → Max) — the zone-intensity
 *  convention. */
const ZONE_RAMP = ['#E7D4E8', '#C89BC4', '#A96B9A', '#7E3F73', '#512250'];

/**
 * **Per-zone colour (`binColors`).** The same horizontal zones chart, but each
 * band takes its own colour from a light→dark ramp — the training-zones look.
 * `colors` is per-**group** (it would tint every bar alike on a single-series
 * chart); `binColors` is the per-**bin/band** channel, `binColors[i]` filling
 * bar `i`. Selection / hover reads out each bar in its own colour.
 */
export const HeartRateZonesColored: Story = {
  render: () => {
    const bins = hrZoneMinutes();
    const zoneTicks = HR_ZONES.map((label, i) => ({ at: i + 0.5, label }));
    return (
      <ChartContainer width={660} theme={estelaTheme}>
        <ChartRow height={230}>
          <YAxis id="zone" label="zone" width={92} ticks={zoneTicks} />
          <Layers>
            <BarChart
              bins={bins}
              column="min"
              orientation="horizontal"
              ordinal
              binColors={ZONE_RAMP}
              gap={8}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Example 4: power distribution — vertical bars over a value (W) axis ──

/** A ride's power trace — `watts` sampled every second. The walk mean-reverts to
 *  ~170 W, so the distribution reads as a bell around the rider's steady power
 *  rather than piling up against a clamp. */
function powerSamples() {
  const rand = lcg(9);
  const rows: Array<[number, number]> = [];
  let p = 170;
  for (let i = 0; i < 1200; i += 1) {
    // Random step + a pull back toward the mean (Ornstein–Uhlenbeck-ish).
    p += (rand() - 0.5) * 30 + (170 - p) * 0.04;
    p = Math.max(20, Math.min(290, p));
    rows.push([BASE + i * 1000, p]);
  }
  return new TimeSeries({
    name: 'power',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'watts', kind: 'number' },
    ] as const,
    rows,
  });
}

/**
 * `withColumn('secs', …).byColumn('watts', { width: 20 }, { secs: sum })` —
 * seconds spent in each 20-watt band. `withColumn` attaches the per-sample
 * duration (1 s cadence here) so the reducer sums real time, not a raw count.
 */
function powerDistribution() {
  const s = powerSamples();
  const secs = new Float64Array(s.length).fill(1); // 1 s per sample
  return s
    .withColumn('secs', secs)
    .byColumn('watts', { width: 20 }, { secs: { from: 'secs', using: 'sum' } });
}

/**
 * **Vertical histogram over a value axis.** The x axis is power in even 20-watt
 * bands (a numeric value axis, not time — the container infers `value` from the
 * bins); each bar's height is the seconds spent in that band. A classic
 * distribution / time-in-zone histogram.
 */
export const PowerDistribution: Story = {
  render: () => {
    const bins = powerDistribution();
    return (
      <ChartContainer range={[0, 300]} width={660} theme={estelaTheme}>
        <ChartRow height={240}>
          <YAxis id="secs" label="seconds" min={0} pad={0.06} />
          <Layers>
            <BarChart bins={bins} column="secs" gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Fan-out: orientation on a single series, and stacked hover/select ──

/**
 * **A single-series `horizontal` bar** (no stacking) — the orientation knob on
 * its own. Categories on the y axis (labelled via `<YAxis ticks>`), one bar each,
 * growing right. Built from a plain interval-keyed series with `column`.
 */
export const HorizontalSingle: Story = {
  render: () => {
    const cats = ['GET', 'POST', 'PUT', 'DELETE'];
    const counts = [412, 133, 58, 21];
    const series = new TimeSeries({
      name: 'verbs',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'count', kind: 'number' },
      ] as const,
      rows: counts.map((c, i) => [[i, i + 1], c]) as never,
    });
    const ticks = cats.map((label, i) => ({ at: i + 0.5, label }));
    return (
      <ChartContainer width={620} theme={estelaTheme}>
        <ChartRow height={200}>
          <YAxis id="verb" label="method" width={80} ticks={ticks} />
          <Layers>
            <BarChart
              series={series}
              column="count"
              orientation="horizontal"
              gap={8}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Hover + select a stacked segment.** Hover the plot — the segment under the
 * cursor pops to full opacity; click it — it stays lit **with an outline** and
 * the panel above names the host + count for that 5-minute bucket. A segment's
 * identity is `(id, bucket, host)`, so two hosts in one bucket never both light
 * up. Click empty space to clear.
 */
function HoverSelectDemo() {
  const byHost = incidentsByHost();
  const [sel, setSel] = useState<SelectInfo | null>(null);
  const clock =
    sel === null ? '' : new Date(sel.key).toISOString().slice(11, 16);
  return (
    <div>
      <div
        style={{
          height: '18px',
          marginBottom: '8px',
          fontFamily: estelaTheme.font.family,
          fontSize: '12px',
          color: estelaTheme.axis.label,
        }}
      >
        {sel === null ? (
          <span style={{ opacity: 0.5 }}>click a segment…</span>
        ) : (
          <span style={{ color: sel.color }}>
            {clock} UTC · {sel.label} · {sel.value} incidents
          </span>
        )}
      </div>
      <ChartContainer
        range={[BASE, BASE + HOUR]}
        width={660}
        theme={estelaTheme}
        onSelect={setSel}
      >
        <ChartRow height={260}>
          <YAxis id="count" label="incidents" min={0} pad={0.06} />
          <Layers>
            <BarChart
              series={byHost}
              column="n"
              colors={HOST_COLORS}
              id="incidents"
              gap={2}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const HoverSelect: Story = {
  render: () => <HoverSelectDemo />,
};
