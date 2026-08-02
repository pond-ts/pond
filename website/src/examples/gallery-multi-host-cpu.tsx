import { useMemo } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { fleetCpu, FLEET_HOSTS, FLEET_RANGE } from './lib/ops-fixtures';

/**
 * Fleet CPU: one line per host, from a single long-form series split by
 * `partitionBy('host')`.
 *
 * The shape ops telemetry arrives in is **long** — one row per host per
 * scrape, with the host as a column — and `partitionBy` is the seam that turns
 * that into the several series a multi-line chart draws, without a reshape
 * step of your own.
 *
 * Four hosts is inside the categorical palette, so each takes its own hue via
 * a `line` role. Past ~4 series the rule flips to a tonal ramp (see the
 * traffic-by-interface card) — four competing colours read as four things;
 * eight read as a pie chart.
 *
 * `web-02`'s node is recycled at 15:20 and its scrapes go **missing** for 24
 * minutes. `gaps="dashed"` is what says so: the line breaks and a faint dashed
 * connector spans the hole, so the absence is visible as an absence rather
 * than drawn through as if the box had been idle.
 */
export default function GalleryMultiHostCpu({
  width,
  phase,
  height = 210,
  legend = false,
}: {
  width: number;
  phase?: number;
  height?: number;
  legend?: boolean;
}) {
  const theme = useSiteChartTheme();
  const series = fleetCpu();
  const byHost = useMemo(() => series.partitionBy('host').toMap(), [series]);

  const range =
    phase === undefined
      ? FLEET_RANGE
      : // Six hours of the day, sweeping — wide enough to hold the batch
        // window or the restart whole, narrow enough that they read.
        scanWindow(FLEET_RANGE[0], FLEET_RANGE[1], 6 * 3_600_000, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme} cursor="line">
      <ChartRow height={height}>
        <YAxis id="pct" side="right" format=".0%" width={44} max={1} min={0} />
        <Layers>
          {FLEET_HOSTS.map((host, i) => {
            const hostSeries = byHost.get(host);
            return hostSeries ? (
              <LineChart
                key={host}
                series={hostSeries}
                column="cpu"
                axis="pct"
                as={HOST_ROLES[i]}
                gaps="dashed"
                legend={host}
              />
            ) : null;
          })}
          {legend ? <Legend placement="top-left" /> : null}
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/** One `line` role per host — the categorical set, in fleet order. */
const HOST_ROLES = ['primary', 'secondary', 'context', 'slow'] as const;
