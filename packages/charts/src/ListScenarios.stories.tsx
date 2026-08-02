import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { BarList } from './BarList.js';
import { BoxList } from './BoxList.js';
import { listRowsFromTimeSeries } from './list.js';
import { defaultTheme, estelaTheme } from './theme.js';
import type { ChartTheme } from './theme.js';
import type { ListRow } from './list.js';

/**
 * The list family's use-case anchors — full compositions from real pond
 * pipelines (`partitionBy` + `reduce` facts; a per-split rollup through
 * `listRowsFromTimeSeries`), the "how would I build X" demos beside the
 * per-knob fan-outs in `Lists/BarList` / `Lists/BoxList`.
 */
const meta: Meta = {
  title: 'Lists/Scenarios',
};
export default meta;

const BASE = Date.UTC(2026, 7, 2, 8, 0, 0);

/** Human traffic-rate formatting (values in Mbps). */
const fmtRate = (mbps: number) =>
  mbps >= 1000 ? `${(mbps / 1000).toFixed(1)}Gbps` : `${mbps.toFixed(0)}Mbps`;

/**
 * Synthetic multi-interface traffic: one long series with an `iface` partition
 * column and in/out rates, deterministic wiggles per interface so each
 * distribution has real spread and its own magnitude.
 */
function trafficByInterface() {
  const IFACES: ReadonlyArray<{ name: string; type: string; scale: number }> = [
    { name: 'CERN-CR6 111-LAG-3-522', type: 'LHCONE (SAP)', scale: 90_000 },
    { name: 'CERN-CR6 7061-LAG-3-3525', type: 'OTHER (SAP)', scale: 18_000 },
    { name: 'CERN-CR6 111-LAG-3-521', type: 'LHCONE (SAP)', scale: 40_000 },
    { name: 'CERN-CR6 7150-LAG-3-3504', type: 'OTHER (SAP)', scale: 2_400 },
    { name: 'CERN-CR6 7041-LAG-3-3507', type: 'OTHER (SAP)', scale: 1_900 },
    { name: 'CERN-CR6 293-LAG-1-2028', type: 'OTHER (SAP)', scale: 350 },
  ];
  const rows: Array<[number, string, number, number]> = [];
  // Time-major so the key column stays non-decreasing across the partitions.
  for (let i = 0; i < 240; i += 1) {
    for (let g = 0; g < IFACES.length; g += 1) {
      const { name, scale } = IFACES[g]!;
      // A slow diurnal swell + faster per-interface wiggle; out runs ~15% of in.
      const swell = 0.55 + 0.45 * Math.sin(i / 40 + g);
      const wiggle = 0.25 * Math.sin(i * 1.7 + g * 3) + 0.1 * Math.sin(i * 5.3);
      const inRate = Math.max(scale * (swell + wiggle), scale * 0.02);
      rows.push([BASE + i * 60_000, name, inRate, inRate * 0.15]);
    }
  }
  const series = new TimeSeries({
    name: 'traffic',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'iface', kind: 'string' },
      { name: 'in', kind: 'number' },
      { name: 'out', kind: 'number' },
    ] as const,
    rows,
  });
  // The real pipeline: partition on the interface, then whole-window facts per
  // partition — the quantiles are computed by pond, the list only reads them.
  const byIface = series.partitionBy('iface').toMap();
  const listRows: ListRow[] = [...byIface].map(([name, s]) => ({
    key: name,
    label: (
      <a href="#" style={{ color: '#2563eb', textDecoration: 'none' }}>
        {name}
      </a>
    ),
    values: {
      type: IFACES.find((d) => d.name === name)!.type,
      ...(s.reduce({
        in_p5: { from: 'in', using: 'p5' },
        in_p25: { from: 'in', using: 'p25' },
        in_p50: { from: 'in', using: 'p50' },
        in_p75: { from: 'in', using: 'p75' },
        in_p95: { from: 'in', using: 'p95' },
        in_now: { from: 'in', using: 'last' },
        out_p5: { from: 'out', using: 'p5' },
        out_p25: { from: 'out', using: 'p25' },
        out_p50: { from: 'out', using: 'p50' },
        out_p75: { from: 'out', using: 'p75' },
        out_p95: { from: 'out', using: 'p95' },
        out_now: { from: 'out', using: 'last' },
      }) as Record<string, number>),
    },
  }));
  return listRows;
}

/**
 * A story-local restyle: the same roles, paler — the printed rate labels sit
 * over the bands, so the bands step back (lighter whisker hues + a thinner
 * body fill) while the tick keeps its full-strength ink.
 */
const trafficTheme: ChartTheme = {
  ...defaultTheme,
  box: {
    ...defaultTheme.box,
    default: {
      ...defaultTheme.box.default,
      fillOpacity: 0.16,
      whisker: '#c9d8f3',
    },
    secondary: {
      ...defaultTheme.box.secondary!,
      fillOpacity: 0.16,
      whisker: '#f6dcd2',
    },
  },
};

/**
 * The esnet "Traffic by Interface" table: link labels, a type cell, one box
 * line per direction (`in` on the default role, `out` on `secondary`) showing
 * where traffic *ranges* vs where it *is now*, ranked by current inbound rate,
 * with a selectable row. No median line — the story reads range + IQR + now;
 * the label ink stays legible over the paled bands.
 */
export const TrafficByInterface: StoryObj = {
  render: function TrafficStory() {
    const rows = useMemo(trafficByInterface, []);
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <div style={{ width: 900 }}>
        <h3 style={{ font: '600 14px system-ui', color: '#334155' }}>
          Traffic by Interface
        </h3>
        <BoxList
          rows={rows}
          columns={[
            {
              lower: 'in_p5',
              q1: 'in_p25',
              q3: 'in_p75',
              upper: 'in_p95',
              value: 'in_now',
              format: fmtRate,
            },
            {
              lower: 'out_p5',
              q1: 'out_p25',
              q3: 'out_p75',
              upper: 'out_p95',
              value: 'out_now',
              format: fmtRate,
              as: 'secondary',
            },
          ]}
          sortBy="in_now"
          before={[
            {
              key: 'type',
              render: (r) => (
                <span style={{ color: '#64748b' }}>{r.values.type}</span>
              ),
            },
          ]}
          selected={selected}
          onRowClick={(r) => setSelected(r.key === selected ? null : r.key)}
          barHeight={12}
          theme={trafficTheme}
        />
      </div>
    );
  },
};

/** m:ss pace from mph (minutes per mile). */
const fmtPace = (mph: number) => {
  const min = 60 / mph;
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}/mi`;
};
const fmtTime = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/** Seven one-mile splits — the per-split rollup a run produces upstream. */
function splitSeries() {
  return new TimeSeries({
    name: 'splits',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'speed', kind: 'number' },
      { name: 'elev', kind: 'number' },
      { name: 'seconds', kind: 'number' },
    ] as const,
    rows: [
      [BASE, 7.3, 21, 493],
      [BASE + 500_000, 15.3, 10, 146],
      [BASE + 1_000_000, 11.8, 31, 305],
      [BASE + 1_500_000, 16.0, 0, 225],
      [BASE + 2_000_000, 13.5, 51, 267],
      [BASE + 2_500_000, 15.8, 20, 228],
      [BASE + 3_000_000, 21.3, 10, 169],
    ] as Array<[number, number, number, number]>,
  });
}

/**
 * The activity **splits** table on the dark register: numbered rows, one speed
 * bar per split on a shared scale, speed + climb data cells, and an expander
 * revealing the split's full stat line — `listRowsFromTimeSeries` straight off
 * the per-split series.
 */
export const Splits: StoryObj = {
  render: function SplitsStory() {
    const rows = useMemo(
      () =>
        listRowsFromTimeSeries(splitSeries(), {
          label: (i) => (
            <span style={{ color: '#4E6B6B' }}>{String(i + 1)}</span>
          ),
        }),
      [],
    );
    const bright = { color: '#F1FBF9' };
    const dim = { color: '#4E6B6B' };
    return (
      <div style={{ background: '#0b1618', padding: '16px 20px', width: 720 }}>
        <div
          style={{
            font: '600 11px "JetBrains Mono", ui-monospace, monospace',
            letterSpacing: 2,
            color: '#4E6B6B',
            marginBottom: 8,
          }}
        >
          SPLITS
        </div>
        <BarList
          rows={rows}
          columns={[{ column: 'speed' }]}
          divided={false}
          theme={estelaTheme}
          after={[
            {
              key: 'speed',
              align: 'right',
              render: (r) => (
                <span style={bright}>
                  {(r.values.speed as number).toFixed(1)} mph
                </span>
              ),
            },
            {
              key: 'elev',
              align: 'right',
              render: (r) => <span style={dim}>+{r.values.elev} ft</span>,
            },
          ]}
          renderExpanded={(r) => {
            const speed = r.values.speed as number;
            const cell = (title: string, value: string) => (
              <div>
                <div style={{ ...dim, letterSpacing: 1.5, fontSize: 10 }}>
                  {title}
                </div>
                <div style={{ ...bright, fontSize: 14, marginTop: 4 }}>
                  {value}
                </div>
              </div>
            );
            return (
              <div style={{ display: 'flex', gap: 40, padding: '6px 0 4px' }}>
                {cell('TIME', fmtTime(r.values.seconds as number))}
                {cell('PACE', fmtPace(speed))}
                {cell('SPEED', `${speed.toFixed(1)} mph`)}
                {cell('ELEV', `+${r.values.elev} ft`)}
              </div>
            );
          }}
          defaultExpanded={[rows[1]!.key]}
        />
      </div>
    );
  },
};
