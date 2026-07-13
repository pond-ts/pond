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

/** `createLiveValue` updates the pinned pill via `.set()` — an isolated
 *  repaint of just that pill, not a re-render of the whole chart tree
 *  (`YAxisIndicator`'s `source` subscribes via `useSyncExternalStore`). */
export default function LearnLiveValue() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const live = useRef(createLiveValue(0.4)).current;
  const rand = useRef(mulberry32(11)).current;

  useEffect(() => {
    const id = setInterval(() => {
      live.set(Math.max(0.05, Math.min(0.95, 0.4 + (rand() - 0.5) * 0.4)));
    }, 200);
    return () => clearInterval(id);
  }, [live, rand]);

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" />
          <YAxisIndicator source={live} axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
