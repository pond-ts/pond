// CPU profiles behind the report's "where does the time go" figures, so they
// can be re-run and checked. Run from the repo root after
// `npm run build --workspace=pond-ts`:
//
//   node spikes/offscreen-stream/profile.mjs > spikes/offscreen-stream/results/profile.txt
//
// 1. `pushMany` with 1,600-row batches (100k ticks/s pushed every 16 ms), the
//    rows built beforehand so only the push is profiled.
// 2. A `live.window()` LiveView kept up to date: 160-row pushes (10k ticks/s
//    every 16 ms) into a 50k-event window, after the window has filled.
//
// For each: the functions with the most "self time" (time spent in the
// function's own code, not in what it calls), and for a few named functions
// their "total time" (own code plus everything it calls). Shares are of the
// time spent in the workload. Uses V8's sampling profiler through
// node:inspector, which slows the code down; the shares are what to read,
// not the milliseconds.
import { Session } from 'node:inspector/promises';
import { LiveSeries } from '../../packages/core/dist/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
];
function rows(n, t0, step) {
  const out = new Array(n);
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.random() - 0.5;
    out[i] = [t0 + i * step, p, 1];
  }
  return out;
}

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 50 }); // µs

async function profile(fn) {
  fn(); // warm up (JIT) outside the profile
  // Named so the summary can keep only samples taken inside it.
  const workload = () => fn();
  await session.post('Profiler.start');
  workload();
  const { profile } = await session.post('Profiler.stop');
  return profile;
}

/** Self and total time per function from a V8 CPU profile. */
function summarize(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes)
    for (const c of n.children ?? []) parent.set(c, n.id);
  const selfUs = new Map();
  profile.samples.forEach((id, i) =>
    selfUs.set(id, (selfUs.get(id) ?? 0) + profile.timeDeltas[i]),
  );
  const name = (n) => {
    const f = n.callFrame;
    const file = f.url ? f.url.split('/').slice(-2).join('/') : '';
    return `${f.functionName || '(anonymous)'}${file ? ` ${file}:${f.lineNumber + 1}` : ''}`;
  };
  // Keep only samples taken inside `workload` (drops the profiler's own
  // start/stop time). A sample's total time counts once for every distinct
  // function on its stack.
  let total = 0;
  const self = new Map();
  const tot = new Map();
  for (const [id, us] of selfUs) {
    const stack = new Set();
    for (let n = id; n != null; n = parent.get(n)) stack.add(name(byId.get(n)));
    if (![...stack].some((k) => k.startsWith('workload '))) continue;
    total += us;
    const k = name(byId.get(id));
    self.set(k, (self.get(k) ?? 0) + us);
    for (const f of stack) tot.set(f, (tot.get(f) ?? 0) + us);
  }
  return { total, self, tot };
}

function print(title, s, named) {
  const pct = (us) => `${((100 * us) / s.total).toFixed(1).padStart(5)}%`;
  console.log(`\n## ${title}`);
  console.log(`profiled ${(s.total / 1000).toFixed(0)} ms of workload`);
  console.log('\nself time, top 10:');
  for (const [k, us] of [...s.self].sort((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(`  ${pct(us)}  ${k}`);
  console.log('\ntotal time (own code + what it calls):');
  for (const want of named)
    for (const [k, us] of s.tot)
      if (k.startsWith(`${want} `) || k === want)
        console.log(`  ${pct(us)}  ${k}`);
}

console.log(
  `# node ${process.version}, ${new Date().toISOString().slice(0, 10)}`,
);

// 1. pushMany, 1,600-row batches.
{
  const batches = Array.from({ length: 625 }, (_, k) =>
    rows(1600, 1e12 + k * 16, 0.01),
  ); // 1M ticks
  const p = await profile(() => {
    const live = new LiveSeries({
      name: 't',
      schema,
      retention: { maxAge: '10s' },
    });
    for (const b of batches) live.pushMany(b);
  });
  print('1. pushMany, 1,600-row batches, 1M rows', summarize(p), [
    'pushMany',
    'validateAndNormalizeColumnar',
    'normalizeKey',
  ]);
}

// 2. live.window() view, 50k-event window, 160-row pushes.
{
  const W = 50_000;
  const live = new LiveSeries({
    name: 't',
    schema,
    retention: { maxAge: `${W * 0.1}ms` },
  });
  live.window(`${W * 0.1}ms`);
  let t = 1e12;
  const push = () => {
    live.pushMany(rows(160, t, 0.1));
    t += 16;
  };
  for (let k = 0; k < (W * 2) / 160; k++) push(); // fill the window
  const p = await profile(() => {
    for (let k = 0; k < 200; k++) push();
  });
  print(
    '2. live.window() view kept up to date, 50k-event window, 160-row pushes',
    summarize(p),
    ['pushMany', 'splice'],
  );
}
process.exit(0);
