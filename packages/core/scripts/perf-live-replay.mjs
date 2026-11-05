// [PND-LIVEREPLAY] Attaching live operators to a LiveSeries that already
// holds 200k rows, and the pushes right after it.
// Run: npm run build --workspace=pond-ts && node scripts/perf-live-replay.mjs
// Set POND_DIST to time another build (e.g. main's) with the same script.
const { LiveSeries, Sequence } = await import(
  process.env.POND_DIST ?? new URL('../dist/index.js', import.meta.url).href
);
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
];
const N = 200_000;
const B = 1000;
const batch = (from, n) => {
  const rows = [];
  for (let j = from; j < from + n; j++) {
    rows.push([j * 1000, Math.sin(j), 'h' + (j % 8)]);
  }
  return rows;
};
const fill = (options) => {
  const live = new LiveSeries({ name: 'l', schema, ...options });
  for (let i = 0; i < N; i += B) live.pushMany(batch(i, B));
  return live;
};
const ops = {
  'filter view': (s) => s.filter((e) => e.get('cpu') > 0),
  "rolling('1m', avg)": (s) => s.rolling('1m', { cpu: 'avg' }),
  "aggregate(every('1m'), avg)": (s) =>
    s.aggregate(Sequence.every('1m'), { cpu: 'avg' }),
  'reduce(avg)': (s) => s.reduce({ cpu: 'avg' }),
  "partitionBy('host').collect()": (s) => s.partitionBy('host').collect(),
  "partitionBy('host').rolling('1m', avg)": (s) =>
    s.partitionBy('host').rolling('1m', { cpu: 'avg' }),
};
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const out = {};
for (const [name, op] of Object.entries(ops)) {
  op(fill());
  const attach = [];
  for (let r = 0; r < 5; r++) {
    const s = fill();
    const t0 = performance.now();
    op(s);
    attach.push(performance.now() - t0);
  }
  out[`attach: ${name}`] = +med(attach).toFixed(1);
}
// The pushes right after attaching a view to a full, retention-capped
// series ([PND-LATCACHE]): median of the next 50 pushes of 1,600 rows.
{
  const s = fill({ retention: { maxEvents: N } });
  s.filter(() => true);
  const times = [];
  let next = N;
  for (let p = 0; p < 50; p++) {
    const rows = batch(next, 1600);
    next += 1600;
    const t0 = performance.now();
    s.pushMany(rows);
    times.push(performance.now() - t0);
  }
  out['next 50 pushes after a view, median per push'] = +med(times).toFixed(2);
}
console.log(JSON.stringify(out, null, 1));
