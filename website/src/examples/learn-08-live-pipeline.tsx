import { useEffect, useMemo, useRef } from 'react';
import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { LiveSeries, Sequence } from 'pond-ts';
import { useSnapshot } from '@pond-ts/react';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'signal', kind: 'number' },
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

/** One live stream, three views. Raw noisy points stream into a `LiveSeries`
 *  (a 12-second sliding window); from each snapshot we **re-derive** two
 *  things with plain pond operators — a moving-average curve threaded through
 *  the cloud (`withColumn`) and 2-second average bars (`aggregate`). Nothing
 *  is mutated in place: every frame is a fresh derivation over the current
 *  window, which is exactly how a "forming" bar stays correct. */
export default function LearnLivePipeline() {
  const theme = useSiteChartTheme();
  const live = useRef(
    new LiveSeries({ name: 'signal', schema, retention: { maxAge: '12s' } }),
  ).current;
  const rand = useRef(mulberry32(19)).current;
  const tick = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      const i = tick.current++;
      // a clear wave the eye can follow, plus scatter noise around it.
      // Phase step halved vs. the push rate so faster points don't make the
      // wave itself busier — same shape, twice the density.
      const wave = 0.5 + 0.3 * Math.sin(i / 14);
      const value = Math.max(
        0.05,
        Math.min(0.95, wave + (rand() - 0.5) * 0.16),
      );
      live.push([Date.now(), value]);
    }, 60);
    return () => clearInterval(id);
  }, [live, rand]);

  const raw = useSnapshot(live, { throttle: 150 });

  // Re-derive the curve + bars from the current window each snapshot.
  const withCurve = useMemo(() => {
    if (raw === null || raw.length === 0) return null;
    const n = raw.length;
    const col = raw.column('signal');
    const smooth = new Float64Array(n);
    const k = 14; // trailing moving-average window (~0.8s at 60ms/point)
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - k + 1); j <= i; j++) {
        const v = col?.read(j);
        // Skip gaps entirely — a missing sample shouldn't drag the average
        // toward zero (it isn't a zero reading, it's no reading).
        if (v !== undefined && Number.isFinite(v)) {
          sum += v;
          count++;
        }
      }
      smooth[i] = count > 0 ? sum / count : NaN;
    }
    return raw.withColumn('smooth', smooth);
  }, [raw]);

  const bars = useMemo(
    () =>
      raw === null || raw.length === 0
        ? null
        : raw.aggregate(Sequence.every('2s'), { signal: 'avg' }),
    [raw],
  );

  if (raw === null || withCurve === null || bars === null) {
    return <div style={{ height: 340 }} />;
  }

  return (
    <ChartContainer range={raw.timeRange()} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" min={0} max={1} />
        <Layers>
          <ScatterChart
            series={withCurve}
            column="signal"
            axis="pct"
            as="secondary"
            radius={2.5}
          />
          <LineChart
            series={withCurve}
            column="smooth"
            axis="pct"
            curve="natural"
          />
        </Layers>
      </ChartRow>
      <ChartRow height={110}>
        <YAxis id="avg" side="right" format=".0%" min={0} max={1} />
        <Layers>
          <BarChart series={bars} column="signal" axis="avg" gap={2} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
