import { useEffect, useRef } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { LiveSeries } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
] as const;

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

/** Pushes a new event every 150ms; `useSnapshot`'s 400ms throttle means
 *  several pushes coalesce into one re-render — the re-render model this
 *  chapter is teaching, made visible by choosing push < throttle. */
export default function LearnLiveSeries() {
  const theme = useSiteChartTheme();
  const live = useRef(
    new LiveSeries({ name: 'live-cpu', schema, retention: { maxEvents: 60 } }),
  ).current;
  const rand = useRef(mulberry32(7)).current;
  const cpu = useRef(0.4);

  useEffect(() => {
    const id = setInterval(() => {
      cpu.current = Math.max(
        0.05,
        Math.min(0.95, cpu.current + (rand() - 0.5) * 0.06),
      );
      live.push([Date.now(), cpu.current]);
    }, 150);
    return () => clearInterval(id);
  }, [live, rand]);

  const snapshot = useSnapshot(live, { throttle: 400 });

  if (snapshot === null || snapshot.length === 0) {
    return <div style={{ height: 220 }} />;
  }

  return (
    <ChartContainer range={snapshot.timeRange()} width={560} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={snapshot} column="cpu" axis="pct" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
