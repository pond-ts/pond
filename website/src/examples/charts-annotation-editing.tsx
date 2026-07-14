import { useState } from 'react';
import {
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

const STEP_MS = 60_000;

/** A fully interactive edit sandbox. `editAnnotations` puts the container in
 *  edit mode (the data cursor steps aside, editable marks show handles); each
 *  mark is **controlled** — its `onChange` reports new geometry and we feed it
 *  straight back to state. Drag the region's body or edges, the marker's line,
 *  the baseline up and down. */
export default function ChartsAnnotationEditing() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const base = series.timeRange()!.begin();

  const [region, setRegion] = useState({
    from: base + 30 * STEP_MS,
    to: base + 50 * STEP_MS,
  });
  const [markerAt, setMarkerAt] = useState(base + 65 * STEP_MS);
  const [target, setTarget] = useState(0.43);

  return (
    <ChartContainer
      range={series.timeRange()}
      width={560}
      theme={theme}
      editAnnotations
    >
      <ChartRow height={220}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
          <Region
            from={region.from}
            to={region.to}
            label="drag me"
            onChange={setRegion}
          />
          <Marker at={markerAt} label="deploy" onChange={setMarkerAt} />
          <Baseline
            value={target}
            axis="pct"
            label="target"
            onChange={setTarget}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
