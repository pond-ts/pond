import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import styles from './styles.module.css';

/**
 * The data→analytics→chart pipeline on one screen (plan §5a.3): raw rows go
 * through a real `baseline()` pass and come out as a band chart with the
 * outliers lit — the platform's whole motion in one gesture. The middle chip
 * is the actual call that produced the right-hand chart.
 */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
] as const;

/** A tiny deterministic PRNG (mulberry32). */
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

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const N = 120;
const source = (() => {
  const rand = mulberry32(21);
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i++) {
    const wave = 0.45 + 0.16 * Math.sin(i / 14) + (rand() - 0.5) * 0.1;
    const spike = i === 42 || i === 87 ? 0.3 : i === 66 ? -0.26 : 0;
    rows.push([BASE + i * 1000, Math.max(0.02, Math.min(0.98, wave + spike))]);
  }
  return TimeSeries.fromJSON({ name: 'cpu', schema, rows });
})();

const SHOWN_ROWS = source
  .toRows()
  .slice(0, 4)
  .map((r, i) => ({
    t: `00:0${i}`,
    v: (r[1] as number).toFixed(2),
  }));

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

function Arrow(): ReactNode {
  return (
    <span className={styles.arrow} aria-hidden="true">
      →
    </span>
  );
}

export default function PipelineStrip(): ReactNode {
  const theme = useSiteChartTheme();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();

  // The real pass — the chip below quotes exactly this call.
  const bands = useMemo(
    () => source.baseline('cpu', { window: '30s', sigma: 2, minSamples: 10 }),
    [],
  );
  const outliers = useMemo(
    () =>
      bands.filter((e) => {
        const v = e.get('cpu') as number | undefined;
        const lo = e.get('lower') as number | undefined;
        const hi = e.get('upper') as number | undefined;
        return v != null && lo != null && hi != null && (v > hi || v < lo);
      }),
    [bands],
  );

  return (
    <div className={styles.strip}>
      <div className={styles.stage}>
        <span className={styles.stageLabel}>rows</span>
        <table className={styles.rows}>
          <tbody>
            {SHOWN_ROWS.map((r) => (
              <tr key={r.t}>
                <td>{r.t}</td>
                <td>{r.v}</td>
              </tr>
            ))}
            <tr>
              <td>⋮</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <Arrow />
      <div className={styles.stage}>
        <span className={styles.stageLabel}>analytics</span>
        <code className={styles.chip}>
          series.baseline('cpu', &#123;
          <br />
          &nbsp;&nbsp;window: '30s', sigma: 2,
          <br />
          &nbsp;&nbsp;minSamples: 10 &#125;)
        </code>
      </div>
      <Arrow />
      <div className={styles.stage_chart}>
        <span className={styles.stageLabel}>chart</span>
        <div ref={boxRef} className={styles.chartBox}>
          {width > 0 ? (
            <ChartContainer
              range={source.timeRange()!}
              width={width}
              theme={theme}
            >
              <ChartRow height={110}>
                <YAxis
                  id="v"
                  side="left"
                  min={0}
                  max={1}
                  width={8}
                  format={() => ''}
                />
                <Layers>
                  <BandChart
                    series={bands}
                    lower="lower"
                    upper="upper"
                    as="inner"
                    axis="v"
                  />
                  <LineChart series={bands} column="cpu" axis="v" />
                  <ScatterChart
                    series={outliers}
                    column="cpu"
                    axis="v"
                    as="secondary"
                    radius={3.2}
                  />
                </Layers>
              </ChartRow>
            </ChartContainer>
          ) : (
            <div style={{ height: 110 }} />
          )}
        </div>
      </div>
    </div>
  );
}
