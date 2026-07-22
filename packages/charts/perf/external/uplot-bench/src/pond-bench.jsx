/**
 * @pond-ts/charts port of uPlot's bench page (uPlot/bench/uPlot.html).
 * Same data.json, same prep transform, same 1920x600 plot, 3 line series on
 * two scales (%, MB). `?decimate=0` turns M4 decimation off (stroke every
 * point, apples-to-apples with uPlot's draw-everything). `window.__bench`
 * carries the timings; `window.__drawStats` the last per-layer draw frame.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TimeSeries } from 'pond-ts';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  Legend,
  estelaTheme,
} from '@pond-ts/charts';

function round2(val) {
  return Math.round(val * 100) / 100;
}
function round3(val) {
  return Math.round(val * 1000) / 1000;
}

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'ram', kind: 'number' },
  { name: 'tcp', kind: 'number' },
];

// Same unpack as uPlot's prepData: epoch,idl,recv,send,read,writ,used,free.
// uPlot keeps seconds (ms:false); pond time is epoch ms, hence * 1e3.
function prepData(packed) {
  const t0 = performance.now();
  const numFields = packed[0];
  packed = packed.slice(numFields + 1);
  const n = packed.length / numFields;
  const rows = new Array(n);
  for (let i = 0, j = 0; i < packed.length; i += numFields, j++) {
    rows[j] = [
      packed[i] * 60 * 1000,
      round3(100 - packed[i + 1]),
      round2((100 * packed[i + 5]) / (packed[i + 5] + packed[i + 6])),
      packed[i + 3],
    ];
  }
  const rowsMs = performance.now() - t0;
  const t1 = performance.now();
  const series = new TimeSeries({
    name: 'server-events',
    schema: SCHEMA,
    rows,
  });
  const seriesMs = performance.now() - t1;
  return { series, rowsMs, seriesMs, count: n };
}

function Bench({ series, decimate }) {
  return (
    <ChartContainer
      width={1920}
      theme={estelaTheme}
      onDrawStats={(frame) => {
        window.__drawStats = frame;
      }}
    >
      <ChartRow height={600}>
        <YAxis id="pct" min={0} max={100} format={(v) => v.toFixed(1) + '%'} />
        <YAxis id="mb" side="right" format={(v) => v.toFixed(2) + ' MB'} />
        <Layers>
          <LineChart
            series={series}
            column="cpu"
            axis="pct"
            as="foam"
            decimate={decimate}
          />
          <LineChart
            series={series}
            column="ram"
            axis="pct"
            as="hr"
            decimate={decimate}
          />
          <LineChart
            series={series}
            column="tcp"
            axis="mb"
            as="elevation"
            decimate={decimate}
          />
        </Layers>
      </ChartRow>
      <Legend />
    </ChartContainer>
  );
}

const wait = document.getElementById('wait');
const decimate = new URLSearchParams(location.search).get('decimate') !== '0';

wait.textContent = 'Fetching data.json (2.07MB)....';
fetch('data.json')
  .then((r) => r.json())
  .then((packed) => {
    wait.textContent = 'Rendering...';
    const { series, rowsMs, seriesMs, count } = prepData(packed);
    setTimeout(() => {
      const container = document.getElementById('chart');
      const root = createRoot(container);
      const t0 = performance.now();
      flushSync(() => {
        root.render(<Bench series={series} decimate={decimate} />);
      });
      const chartSyncMs = performance.now() - t0;
      Promise.resolve().then(() => {
        const chartMs = performance.now() - t0;
        wait.textContent = 'Done!';
        window.__bench = {
          lib: 'pond',
          decimate,
          count,
          rowsMs,
          seriesMs,
          prepMs: rowsMs + seriesMs,
          chartSyncMs,
          chartMs,
          done: true,
        };
      });
    }, 0);
  });
