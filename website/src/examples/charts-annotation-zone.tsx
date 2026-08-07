import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  Zone,
  type ChartTheme,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

/** The bands' palette — one theme role per band, so the *scale* lives in one
 *  place and the call site only names which band it is. */
function bandedTheme(base: ChartTheme): ChartTheme {
  return {
    ...base,
    annotation: {
      ...base.annotation!,
      roles: {
        healthy: { color: '#1f9d63', fillOpacity: 0.14 },
        warning: { color: '#c2a20f', fillOpacity: 0.16 },
        critical: { color: '#d8473f', fillOpacity: 0.12 },
      },
    },
  };
}

/** CPU utilisation banded into healthy / warning / critical — the zone set
 *  turns the y axis into a scale you can read a verdict off. The top band is
 *  open-ended (`to={Infinity}`), so it reaches the plot edge without an
 *  invented ceiling. */
const BANDS = [
  { role: 'healthy', from: 0, to: 0.6, label: 'healthy' },
  { role: 'warning', from: 0.6, to: 0.85, label: 'warning' },
  { role: 'critical', from: 0.85, to: Infinity, label: 'critical' },
];

/** A `<Zone>` set — shaded **y** spans, the value-axis counterpart of
 *  `<Region>`. Inert background context by default: no boundary lines, no
 *  pointer response, so the traces read over an unbroken wash of colour. */
export default function ChartsAnnotationZone({ width }: { width: number }) {
  const theme = bandedTheme(useSiteChartTheme());
  const series = singleHostSeries();
  // Pan/zoom the time axis; the bands don't move, because they're anchored to
  // the *value* axis — which is the point of them.
  const range = series.timeRange()!;

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      panZoom
      bounds={[range.begin(), range.end()]}
      minDuration={5 * 60 * 1000}
    >
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" min={0} max={1} />
        <Layers>
          {BANDS.map((b) => (
            <Zone
              key={b.role}
              from={b.from}
              to={b.to}
              axis="pct"
              role={b.role}
              label={b.label}
            />
          ))}
          <LineChart series={series} column="cpu" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
