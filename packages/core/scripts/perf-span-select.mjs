// [PND-SPANFILTER] / [PND-ROWSOUT] key-span selectors and row exports on 1M rows.
// Run: npm run build --workspace=pond-ts && node --max-old-space-size=6000 scripts/perf-span-select.mjs
// Set POND_DIST to time another build (e.g. main's) with the same script.
const { TimeSeries } = await import(
  process.env.POND_DIST ?? new URL('../dist/index.js', import.meta.url).href
);
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
  cpu[i] = Math.sin(i);
  host[i] = 'h' + (i % 8);
}
const fresh = () =>
  TimeSeries.fromColumns({ name: 'x', schema, columns: { time, cpu, host } });
const built = () => {
  const s = fresh();
  s.events;
  return s;
};
const mid = (N / 2) * 1000;
const ops = {
  'slice (reference)': [fresh, (s) => s.slice(1000, N - 1000)],
  'after(mid)': [fresh, (s) => s.after(mid)],
  'before(mid)': [fresh, (s) => s.before(mid)],
  'within(1s, end-1s)': [fresh, (s) => s.within(1000, (N - 2) * 1000)],
  "tail('1h')": [fresh, (s) => s.tail('1h')],
  'overlapping([0, mid])': [fresh, (s) => s.overlapping([0, mid])],
  'containedBy([0, mid])': [fresh, (s) => s.containedBy([0, mid])],
  'after(mid), events already built': [built, (s) => s.after(mid)],
  rows: [fresh, (s) => s.rows],
  toObjects: [fresh, (s) => s.toObjects()],
  'rows, events already built': [built, (s) => s.rows],
  'after(mid).rows': [fresh, (s) => s.after(mid).rows],
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
  out[k] = +med(ts).toFixed(1);
}
console.log(JSON.stringify(out, null, 1));
