// [PND-ROWSOUT] toJSON / toPoints on 1M rows: fresh series (column path),
// one event built (mixed path), all events built (event path).
// Run: npm run build --workspace=pond-ts && node --max-old-space-size=6000 scripts/perf-rows-out.mjs
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
  time[i] = i * 1000;
  cpu[i] = i % 10 === 0 ? NaN : Math.sin(i);
  host[i] = 'h' + (i % 8);
}
const fresh = () =>
  TimeSeries.fromColumns({ name: 'x', schema, columns: { time, cpu, host } });
const ops = {
  'toJSON()': (s) => s.toJSON(),
  "toJSON({rowFormat:'object'})": (s) => s.toJSON({ rowFormat: 'object' }),
  'toPoints()': (s) => s.toPoints(),
  'toJSON() events already built': (s) => s.toJSON(),
  'toJSON() one event built': (s) => s.toJSON(),
};
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const out = {};
for (const [k, f] of Object.entries(ops)) {
  const prep = k.includes('one')
    ? () => {
        const s = fresh();
        s.at(5);
        return s;
      }
    : k.includes('built')
      ? () => {
          const s = fresh();
          s.events;
          return s;
        }
      : fresh;
  for (let w = 0; w < 3; w++) f(prep());
  const ts = [];
  for (let r = 0; r < 7; r++) {
    const s = prep();
    const t0 = performance.now();
    f(s);
    ts.push(performance.now() - t0);
  }
  out[k] = +med(ts).toFixed(0);
}
console.log(JSON.stringify(out));
