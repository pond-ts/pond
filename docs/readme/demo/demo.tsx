/**
 * The README's animated demo: a live fleet monitor built only from pond-ts,
 * @pond-ts/charts and React. `record.mjs` bundles this page, opens it in
 * headless Chromium, and calls `window.step()` once per frame, so every frame
 * is the real library running: events pushed into a `LiveSeries`, then
 * `baseline`, `outliers`, `partitionBy(...).rolling` and `aggregate` run on a
 * snapshot, and the charts draw the results.
 *
 * Time is synthetic (a fixed start, half a second per event) and the noise is
 * seeded, so every recording is the same.
 */
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveSeries, Sequence } from 'pond-ts';
import {
  BandChart,
  BarChart,
  ChartContainer,
  ChartRow,
  FlagCursor,
  Layers,
  Legend,
  LineChart,
  ScatterChart,
  YAxis,
  defaultTheme,
} from '@pond-ts/charts';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu', kind: 'number' },
  { name: 'latency', kind: 'number' },
  { name: 'requests', kind: 'number' },
] as const;

const HOSTS = ['api-1', 'api-2', 'api-3'] as const;
const ROLES = ['primary', 'secondary', 'context'] as const;
const STEP_MS = 500;
const VIEW_MS = 120_000;
const T0 = Date.UTC(2026, 10, 20, 14, 0, 0);
const WIDTH = 880;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(7);
const live = new LiveSeries({
  name: 'fleet',
  schema,
  retention: { maxAge: '3m' },
});
let tick = 0;
let pushed = 0;

/** Push one half-second of readings: one row per host. */
function pushTick() {
  const i = tick++;
  const t = T0 + i * STEP_MS;
  HOSTS.forEach((host, h) => {
    const load =
      0.42 +
      0.16 * Math.sin(i / 70 + h * 2.1) +
      0.07 * Math.sin(i / 17 + h) +
      (rand() - 0.5) * 0.06 +
      // api-3 takes a batch job for a while.
      (h === 2 && i % 500 > 300 && i % 500 < 380 ? 0.22 : 0);
    const cpu = Math.max(0.02, Math.min(0.98, load));
    const spike = rand() < 0.012 ? 60 + rand() * 60 : 0;
    const latency = 38 + 40 * cpu + (rand() - 0.5) * 14 + spike;
    // Traffic rises and falls in waves, with the odd burst.
    const wave = 1 + 0.55 * Math.sin(i / 45) + 0.25 * Math.sin(i / 13 + 1);
    const burst = i % 160 > 140 ? 0.8 : 0;
    const requests = Math.round(
      (90 + 120 * cpu) * (wave + burst) + (rand() - 0.5) * 30,
    );
    live.push([t, host, cpu, latency, requests]);
    pushed++;
  });
}

const theme = {
  ...defaultTheme,
  background: '#ffffff',
  scatter: {
    ...defaultTheme.scatter,
    anomaly: {
      ...defaultTheme.scatter.default,
      color: '#d64545',
      radius: 4.5,
    },
  },
};

const fmtInt = (n: number) => n.toLocaleString('en-US');

function Monitor({ frame }: { frame: number }) {
  void frame; // re-render per frame; the data lives in `live`
  const snap = live.toTimeSeries();
  const range = snap.timeRange()!;
  const end = range.end();
  const view: [number, number] = [end - VIEW_MS, end];

  const api1 = snap.filter((e) => e.get('host') === 'api-1');
  const bands = api1.baseline('latency', {
    window: '20s',
    sigma: 2.5,
    minSamples: 10,
  });
  const anomalies = api1.outliers('latency', {
    window: '20s',
    sigma: 2.5,
    minSamples: 10,
  });
  const cpuByHost = snap
    .partitionBy('host')
    .rolling('10s', { cpu: 'avg' })
    .toMap();
  const traffic = snap.aggregate(Sequence.every('5s'), { requests: 'sum' });
  const p95 = api1.reduce('latency', 'p95') as number;

  return (
    <div className="card">
      <div className="head">
        <div className="title">
          <span className="dot" />
          <span>
            <b>Live fleet monitor</b>
            <span className="sub"> · pond-ts + @pond-ts/charts</span>
          </span>
        </div>
        <div className="stats">
          <Stat label="events pushed" value={fmtInt(pushed)} />
          <Stat label="anomalies (3 min)" value={String(anomalies.length)} />
          <Stat label="api-1 p95 latency" value={`${p95.toFixed(0)} ms`} />
        </div>
      </div>
      <ChartContainer range={view} width={WIDTH - 32} theme={theme}>
        <FlagCursor showTime />
        <ChartRow height={150}>
          <YAxis
            id="ms"
            side="left"
            label="api-1 latency (ms)"
            format=",.0f"
            width={58}
            min={0}
            max={300}
          />
          <Layers>
            <BandChart
              series={bands}
              lower="lower"
              upper="upper"
              axis="ms"
              as="inner"
              legend="normal range (±2.5σ)"
            />
            <LineChart
              series={api1}
              column="latency"
              axis="ms"
              legend="latency"
            />
            <ScatterChart
              series={anomalies}
              column="latency"
              axis="ms"
              as="anomaly"
              legend="anomaly"
            />
            <Legend placement="top-left" />
          </Layers>
        </ChartRow>
        <ChartRow height={130}>
          <YAxis
            id="cpu"
            side="left"
            label="cpu, 10 s avg"
            format=".0%"
            width={58}
            min={0}
            max={1}
          />
          <Layers>
            {HOSTS.map((host, i) => {
              const s = cpuByHost.get(host);
              return s ? (
                <LineChart
                  key={host}
                  series={s}
                  column="cpu"
                  axis="cpu"
                  as={ROLES[i]}
                  legend={host}
                />
              ) : null;
            })}
            <Legend placement="top-left" />
          </Layers>
        </ChartRow>
        <ChartRow height={100}>
          <YAxis
            id="req"
            side="left"
            label="requests / 5 s"
            format=",.0f"
            width={58}
            min={0}
          />
          <Layers>
            <BarChart
              series={traffic}
              column="requests"
              axis="req"
              gap={2}
              legend="requests"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

let setFrame: (n: number) => void = () => {};
function App() {
  const [frame, set] = useState(0);
  setFrame = set;
  return useMemo(() => <Monitor frame={frame} />, [frame]);
}

// Ninety seconds of history before the first frame, so the chart opens full.
for (let k = 0; k < 180; k++) pushTick();

const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<App />));

let frameNo = 0;
/** Advance one second of data and re-render synchronously. */
(window as unknown as { step: () => void }).step = () => {
  pushTick();
  pushTick();
  frameNo++;
  flushSync(() => setFrame(frameNo));
};
