// [PND-GROUPEVENTS] groupBy / pivotByGroup on 1M rows.
// Run: npm run build --workspace=pond-ts && node --max-old-space-size=6000 scripts/perf-group-columns.mjs
import { TimeSeries } from '../dist/index.js';
const N = 1_000_000;
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
];
const time = new Float64Array(N),
  cpu = new Float64Array(N),
  host = new Array(N);
for (let i = 0; i < N; i++) {
  time[i] = Math.floor(i / 8) * 1000;
  cpu[i] = Math.sin(i);
  host[i] = 'h' + (i % 8);
}
const fresh = () =>
  TimeSeries.fromColumns({ name: 'x', schema, columns: { time, cpu, host } });
const sparse = () =>
  TimeSeries.fromColumns({
    name: 'x',
    schema,
    columns: {
      time: time.map((_, i) => i * 1000),
      cpu,
      host: host.map((_, i) => 'h' + (i % 1000)),
    },
  });
const ops = {
  "groupBy('host') 8 groups": [fresh, (s) => s.groupBy('host')],
  "groupBy('host') 1000 groups": [sparse, (s) => s.groupBy('host')],
  "pivotByGroup('host','cpu') 8 groups": [
    fresh,
    (s) => s.pivotByGroup('host', 'cpu'),
  ],
  'groupBy, events already built': [
    () => {
      const s = fresh();
      s.events;
      return s;
    },
    (s) => s.groupBy('host'),
  ],
};
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const out = {};
for (const [k, [prep, f]] of Object.entries(ops)) {
  for (let w = 0; w < 2; w++) f(prep());
  const ts = [];
  for (let r = 0; r < 5; r++) {
    const s = prep();
    const t0 = performance.now();
    f(s);
    ts.push(performance.now() - t0);
  }
  out[k] = +med(ts).toFixed(0);
}
console.log(JSON.stringify(out));
