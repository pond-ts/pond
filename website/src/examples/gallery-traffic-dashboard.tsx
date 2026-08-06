import { useMemo, useState } from 'react';
import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  DEVICE,
  sapSeries,
  sapStats,
  siteTotal,
  TRAFFIC_RANGE,
} from './lib/cern-traffic';
import styles from './gallery-traffic-dashboard.module.css';

/**
 * The network-traffic **dashboard**: the mirrored in/out chart driven by a
 * selectable per-interface table — the panel pair the CERN capture actually
 * comes out of.
 *
 * The linking is the teachable part, and it is deliberately dull: one piece of
 * React state holds the selected interface id, the table writes it, and the
 * chart reads it to choose which series to draw. Nothing in `@pond-ts/charts`
 * mediates that — the chart is a *view* of whatever series you hand it, so
 * "selection drives the chart" is a `useState` and a ternary.
 *
 * The table's bullet bars are plain DOM, not a chart. At ~90px per row, a
 * `<BarChart>` would cost a canvas, a scale and a container each, to draw one
 * rectangle; a div with a width is the honest primitive. Reach for a chart
 * when you need an axis.
 */
export default function GalleryTrafficDashboard({
  width,
  chartHeight = 220,
}: {
  width: number;
  chartHeight?: number;
}) {
  const theme = useSiteChartTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const stats = sapStats();

  // The chart's source: one interface when a row is picked, the whole site
  // otherwise. Both have the same `in` / `out` columns, so nothing else in the
  // composition changes.
  const series = selected === null ? siteTotal() : sapSeries(selected);
  const mirrored = useMemo(
    () => series.mapColumns({ out: (v) => -v }),
    [series],
  );

  // The bullet bars share one scale across rows — the busiest interface's peak
  // — so a row's bar is readable *against the others*, which is the entire
  // reason to put them in a column.
  const scale = Math.max(...stats.map((s) => Math.max(s.peakIn, s.peakOut)));

  return (
    <div className={styles.panel}>
      <ChartContainer
        range={TRAFFIC_RANGE}
        width={width}
        theme={theme}
        cursor="crosshair"
      >
        <ChartRow height={chartHeight}>
          <YAxis
            id="gbps"
            side="right"
            label="Gbps"
            labelPlacement="top"
            format={absGbps}
            width={52}
          />
          <Layers>
            <AreaChart
              series={series}
              column="in"
              as="in"
              axis="gbps"
              baseline={0}
              legend="to site"
            />
            <AreaChart
              series={mirrored}
              column="out"
              as="out"
              axis="gbps"
              baseline={0}
              legend="from site"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>

      <div className={styles.head}>
        <span className={styles.title}>
          {selected === null ? `${DEVICE} — all interfaces` : selected}
        </span>
        <button
          type="button"
          className={styles.clear}
          disabled={selected === null}
          onClick={() => setSelected(null)}
        >
          Clear selection
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Interface</th>
              <th scope="col">Class</th>
              <th scope="col">In</th>
              <th scope="col" className={styles.numeric}>
                peak
              </th>
              <th scope="col">Out</th>
              <th scope="col" className={styles.numeric}>
                peak
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr
                key={s.name}
                className={styles.row}
                aria-selected={s.name === selected}
                onClick={() => setSelected(s.name === selected ? null : s.name)}
              >
                <td className={styles.name}>{s.name}</td>
                <td>
                  <span className={styles.tag}>{s.category}</span>
                </td>
                <td>
                  <Bullet
                    mean={s.meanIn}
                    peak={s.peakIn}
                    scale={scale}
                    color="var(--pond-viz-1)"
                    label={`${s.name} inbound`}
                  />
                </td>
                <td className={styles.numeric}>{s.peakIn.toFixed(1)}</td>
                <td>
                  <Bullet
                    mean={s.meanOut}
                    peak={s.peakOut}
                    scale={scale}
                    color="var(--pond-viz-4)"
                    label={`${s.name} outbound`}
                  />
                </td>
                <td className={styles.numeric}>{s.peakOut.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One inline in/out bar: a filled segment for the mean, a tick at the peak. */
function Bullet({
  mean,
  peak,
  scale,
  color,
  label,
}: {
  mean: number;
  peak: number;
  scale: number;
  color: string;
  label: string;
}) {
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  return (
    <div
      className={styles.bullet}
      role="img"
      aria-label={`${label}: mean ${mean.toFixed(2)} Gbps, peak ${peak.toFixed(2)} Gbps`}
    >
      <div
        className={styles.bulletFill}
        style={{ width: pct(mean), background: color }}
      />
      <div className={styles.bulletTick} style={{ left: pct(peak) }} />
    </div>
  );
}

/** Magnitudes on both halves — only the drawing is signed. Hoisted so the
 *  axis isn't re-registered every render. */
const absGbps = (v: number) => Math.abs(v).toFixed(0);
