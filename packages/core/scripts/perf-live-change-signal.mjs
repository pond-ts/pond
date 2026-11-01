// [PND-HOOKSIGNAL] Cost of what the React hooks subscribe with, on the
// column-native LiveSeries: an 'event' (+ 'evict') listener builds an Event
// per pushed (and evicted) row; the payload-free signal builds none.
// 200k rows into a maxEvents: 10_000 buffer, batches of 1/10/100/1000.
// Run: npm run build --workspace=pond-ts && node scripts/perf-live-change-signal.mjs
import { LiveSeries } from '../dist/index.js';
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
];
const TOTAL = 200_000;
function run(batch, mode) {
  const live = new LiveSeries({
    name: 'x',
    schema,
    retention: { maxEvents: 10_000 },
  });
  if (mode === 'event' || mode === 'event+evict') live.on('event', () => {});
  if (mode === 'event+evict') live.on('evict', () => {});
  if (mode === 'settle') live._onSettle(() => {});
  const S = Symbol.for('pond-ts:onSignal');
  if (mode === 'signal' || mode === 'signal+evict') live[S]('event', () => {});
  if (mode === 'signal+evict') live[S]('evict', () => {});
  const batches = [];
  for (let b = 0; b < TOTAL / batch; b++) {
    const rows = new Array(batch);
    for (let i = 0; i < batch; i++) {
      const t = b * batch + i;
      rows[i] = [t * 1000, Math.sin(t), 'h' + (t % 8)];
    }
    batches.push(rows);
  }
  const t0 = performance.now();
  for (const rows of batches) live.pushMany(rows);
  return performance.now() - t0;
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const out = {};
for (const batch of [1, 10, 100, 1000])
  for (const mode of [
    'none',
    'event',
    'signal',
    'event+evict',
    'signal+evict',
  ]) {
    for (let w = 0; w < 3; w++) run(batch, mode);
    const ts = [];
    for (let r = 0; r < 7; r++) ts.push(run(batch, mode));
    out[`batch=${batch} ${mode}`] = +med(ts).toFixed(1);
  }
console.log(JSON.stringify(out, null, 1));
