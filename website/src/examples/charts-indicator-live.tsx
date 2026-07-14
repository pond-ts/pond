import { useEffect, useRef } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  YAxisIndicator,
  createLiveValue,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

/** A tiny deterministic PRNG (mulberry32) — no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Crosshair the chart to read any sample; meanwhile a live `YAxisIndicator`
 *  jiggles at the curve's leading edge — a mean-reverting random walk pushed
 *  through `createLiveValue.set()`, so only the pill repaints, not the chart.
 *  The pill takes the **line's colour** so it reads as that series' live value. */
export default function ChartsIndicatorLive() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const last = series.at(series.length - 1)?.get('cpu') ?? 0.4;

  const live = useRef(createLiveValue(last)).current;
  const rand = useRef(mulberry32(23)).current;
  const valueRef = useRef(last);

  useEffect(() => {
    const id = setInterval(() => {
      // Mean-revert toward `last` with a small per-tick jiggle — it wanders
      // (live) but stays near the curve's end (doesn't drift off-screen).
      const next =
        valueRef.current +
        (last - valueRef.current) * 0.1 +
        (rand() - 0.5) * 0.05;
      valueRef.current = Math.max(0.05, Math.min(0.95, next));
      live.set(valueRef.current);
    }, 150);
    return () => clearInterval(id);
  }, [live, rand, last]);

  return (
    <ChartContainer
      range={series.timeRange()}
      width={560}
      theme={theme}
      cursor="crosshair"
    >
      <ChartRow height={220}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
          <YAxisIndicator
            source={live}
            axis="pct"
            color={theme.line.default.color}
            format=".1%"
            line
            pointer
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
