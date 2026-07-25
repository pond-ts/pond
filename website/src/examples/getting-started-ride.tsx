import { useLayoutEffect, useRef, useState } from 'react';
import {
  Baseline,
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { computePower } from '@pond-ts/fit';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { ride, RIDE_ELAPSED_S, RIDE_FTP } from './lib/ride-fixtures';

// ── 1. The ride, and one core transform ────────────────────────────────────
const rideSeries = ride(); // 1 h 54 m of real 1 Hz power

// Coasting is real (0 W means you stopped pedalling) but drawing it as a line
// to the floor turns every descent into a picket fence. Blank those samples and
// the chart's gap handling breaks the line instead.
const wattsRaw = rideSeries.column('watts').toFloat64Array();
const pedalling = Array.from(wattsRaw, (w) => (w > 0 ? w : undefined));

// A 2-minute mean: long enough to read the *shape* of the ride rather than the
// pedal stroke. Smoothed over the gapped column, then blanked wherever the
// source was — otherwise a window of pure coasting averages to a hard 0 and
// puts the drop we just removed straight back into the picture.
const smoothedRaw = rideSeries
  .withColumn('pedalling', pedalling)
  .smooth('pedalling', 'movingAverage', { window: '2m', output: 'trend' })
  .column('trend')
  .toFloat64Array();

const traces = rideSeries.withColumn('pedalling', pedalling).withColumn(
  'trend',
  Array.from(smoothedRaw, (v, i) =>
    pedalling[i] === undefined ? undefined : v,
  ),
);

// ── 2. The histogram — pond's own value-axis aggregation ───────────────────
// Samples are 1 Hz, so counting rows in a watt band *is* seconds in that band.
const bins = rideSeries
  .byColumn('watts', { width: 25 }, { secs: { from: 'watts', using: 'count' } })
  .map((b) => ({ ...b, minutes: b.secs / 60 }));

// The 0–25 W bucket is half an hour of coasting — three times any other bar.
// Cap the axis at the tallest *pedalling* bar so it doesn't flatten the part of
// the distribution worth reading; the coasting bar then runs off the top, and
// is drawn faintly so it reads as context rather than as the headline.
const pedallingPeak = Math.max(...bins.slice(1).map((b) => b.minutes));
const fadeFirstBar = (fill: string) =>
  bins.map((_, i) =>
    i === 0 ? (/^#[0-9a-f]{6}$/i.test(fill) ? `${fill}80` : fill) : undefined,
  );

// ── 3. The domain layer — @pond-ts/fit turns watts into ride analytics ──────
// fit works in typed arrays: elapsed seconds + watts.
const startMs = rideSeries.keyColumn().begin[0]!;
const timeSec = Float64Array.from(
  rideSeries.keyColumn().begin,
  (ms) => (ms - startMs) / 1000,
);
const power = computePower(
  timeSec,
  rideSeries.column('watts').toFloat64Array(),
  RIDE_FTP,
  RIDE_ELAPSED_S,
);

/** The ride's full extent — the outer limit for panning and zooming. */
const RIDE_BOUNDS = [startMs, startMs + RIDE_ELAPSED_S * 1000] as const;

/** Measure the container so the charts fill whatever width they're given. */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function GettingStartedRide() {
  const theme = useSiteChartTheme();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();

  return (
    <div ref={boxRef} style={{ width: '100%' }}>
      {width > 0 && (
        <>
          {/* Time axis: the ride as it happened. `origin="data"` labels the
              ticks as time into the ride — nobody cares what o'clock it was in
              2016. Drag to pan, wheel to zoom; `bounds` stops you leaving. */}
          <ChartContainer
            range={rideSeries.timeRange()}
            width={width}
            theme={theme}
            cursor="crosshair"
            origin="data"
            panZoom="panZoom"
            bounds={RIDE_BOUNDS}
          >
            <ChartRow height={220}>
              <YAxis id="w" label="watts" min={0} width={52} />
              <Layers>
                <LineChart
                  series={traces}
                  column="pedalling"
                  axis="w"
                  as="muted"
                  legend="power"
                />
                <LineChart
                  series={traces}
                  column="trend"
                  axis="w"
                  as="primary"
                  legend="2 min average"
                />
                <Baseline
                  value={power.normalizedWatts}
                  axis="w"
                  label={`NP ${Math.round(power.normalizedWatts)} W`}
                  indicator
                />
              </Layers>
            </ChartRow>
            <Legend placement="top-right" />
          </ChartContainer>

          {/* Value axis: where the time actually went. */}
          <ChartContainer range={[0, 450]} width={width} theme={theme}>
            <ChartRow height={130}>
              <YAxis
                id="min"
                label="minutes"
                min={0}
                max={pedallingPeak}
                width={52}
              />
              <Layers>
                <BarChart
                  bins={bins}
                  column="minutes"
                  axis="min"
                  binColors={fadeFirstBar(theme.bar.default.fill)}
                  gap={2}
                />
              </Layers>
            </ChartRow>
          </ChartContainer>
        </>
      )}
    </div>
  );
}
