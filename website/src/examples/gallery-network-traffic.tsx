import { useMemo } from 'react';
import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { siteTotal, TRAFFIC_RANGE } from './lib/cern-traffic';

/**
 * The mirrored in/out traffic chart — "to site" filling up from zero, "from
 * site" filling down — on six hours of real CERN border-router telemetry.
 *
 * The whole shape is two `<AreaChart baseline={0}>`s over the same series:
 * one draws `in`, the other draws a copy whose `out` column has been negated,
 * so it fills below the zero line. `as="in"` / `as="out"` pick the theme's two
 * traffic roles — the composition `<AreaChart baseline>`'s own docs describe
 * as "the esnet two-colour traffic look".
 *
 * With a `phase` (the Gallery card's autoplay clock) a 90-minute window sweeps
 * the six hours, so the reader sees the quiet morning become the busy midday
 * rather than a static silhouette of both.
 */
export default function GalleryNetworkTraffic({
  width,
  phase,
  height = 200,
  cursor = 'crosshair',
}: {
  width: number;
  phase?: number;
  height?: number;
  cursor?: 'none' | 'line' | 'crosshair';
}) {
  const theme = useSiteChartTheme();
  const total = siteTotal();
  // One negated copy, built once — the only transformation the mirror needs.
  const mirrored = useMemo(() => total.mapColumns({ out: (v) => -v }), [total]);

  const range =
    phase === undefined
      ? TRAFFIC_RANGE
      : scanWindow(TRAFFIC_RANGE[0], TRAFFIC_RANGE[1], 90 * 60_000, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme} cursor={cursor}>
      <ChartRow height={height}>
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
            series={total}
            column="in"
            as="in"
            axis="gbps"
            baseline={0}
          />
          <AreaChart
            series={mirrored}
            column="out"
            as="out"
            axis="gbps"
            baseline={0}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/**
 * Both directions are *magnitudes*; only the drawing is signed. The axis
 * therefore labels `|value|`, so the downward half reads "180", not "−180".
 * Hoisted rather than inline because an inline format **function** is a fresh
 * reference every render and would re-register the axis on every animated
 * frame (`<YAxis format>`'s own warning).
 */
const absGbps = (v: number) => Math.abs(v).toFixed(0);
