// [PND-TRIMCOL] trim on 1M rows, per key kind.
// Run: npm run build --workspace=pond-ts && node --max-old-space-size=6000 scripts/perf-trim.mjs
// Set POND_DIST to time another build (e.g. main's) with the same script.
const { TimeSeries } = await import(
  process.env.POND_DIST ?? new URL('../dist/index.js', import.meta.url).href
);
const N = 1_000_000;
const cpu = new Float64Array(N);
const host = new Array(N);
for (let i = 0; i < N; i++) {
  cpu[i] = Math.sin(i);
  host[i] = 'h' + (i % 8);
}
const make = (kind) => {
  const schema = [
    { name: 'k', kind },
    { name: 'cpu', kind: 'number' },
    { name: 'host', kind: 'string' },
  ];
  if (kind === 'time') {
    const k = new Float64Array(N).map((_, i) => i * 1000);
    return () =>
      TimeSeries.fromColumns({ name: 'x', schema, columns: { k, cpu, host } });
  }
  const rows = Array.from({ length: N }, (_, i) =>
    kind === 'timeRange'
      ? [[i * 1000, i * 1000 + 5000], cpu[i], host[i]]
      : [['L' + i, i * 1000, i * 1000 + 5000], cpu[i], host[i]],
  );
  return () => new TimeSeries({ name: 'x', schema, rows });
};
const range = [500, (N - 500) * 1000];
const time = make('time');
const timeRange = make('timeRange');
const interval = make('interval');
const built = (f) => () => {
  const s = f();
  s.events;
  return s;
};
const ops = {
  'time: trim to all but the edges': [time, (s) => s.trim(range)],
  'time: trim to half': [time, (s) => s.trim([0, (N / 2) * 1000])],
  'timeRange: trim (clips both ends)': [timeRange, (s) => s.trim(range)],
  'interval: trim (clips both ends)': [interval, (s) => s.trim(range)],
  'timeRange: trim, events already built': [
    built(timeRange),
    (s) => s.trim(range),
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
  out[k] = +med(ts).toFixed(1);
}
console.log(JSON.stringify(out, null, 1));
