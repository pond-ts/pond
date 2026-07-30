import { parentPort, workerData } from 'node:worker_threads';
import { TimeSeries } from '../../packages/core/dist/index.js';
import { sma, bollinger, zScore } from '../../packages/financial/dist/index.js';

// Resident model: build this worker's TimeSeries ONCE over the shared
// buffers (fromColumns adopts the Float64Array views zero-copy), then
// serve study jobs against it. This is the residency lesson from the WASM
// spike applied to workers — per-call series shipping would be the
// "bridged" shape that killed that spike's wins.
const time = new Float64Array(workerData.timeSab);
const close = new Float64Array(workerData.closeSab);
const bars = TimeSeries.fromColumns({
  name: 'bars',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'close', kind: 'number' },
  ],
  columns: { time, close },
});

const STUDIES = {
  sma20: () => sma(bars, { period: 20 }),
  sma50: () => sma(bars, { period: 50 }),
  sma200: () => sma(bars, { period: 200 }),
  bollinger20: () => bollinger(bars, { period: 20 }),
  zscore20: () => zScore(bars, { period: 20 }),
};

parentPort.on('message', (msg) => {
  if (msg.kind === 'ping') {
    parentPort.postMessage({ id: msg.id });
    return;
  }
  const result = STUDIES[msg.study]();
  // Ship one output column back, transferred (zero-copy move) — the round
  // trip an integration would actually pay.
  const out = result.column(msg.readback).toFloat64Array();
  const buf =
    out.buffer.byteLength === out.byteLength ? out.buffer : out.slice().buffer;
  parentPort.postMessage({ id: msg.id, buf }, [buf]);
});
