// pond-ts side of examples/perf_live.rs: same data, same steps.
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/live_pond_ts.mjs
import { LiveSeries, Sequence } from '../../../packages/core/dist/index.js';

const N = 1_000_000;
let seed = 20261027;
const next = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const hosts = ['a', 'b', 'c', 'd'];
const rows = [];
const late = [];
for (let i = 0; i < N; i++) {
  const host = hosts[i % 4];
  const cpu = next() < 0.02 ? undefined : next();
  const mem = 100 + (i % 50);
  const t = i * 100;
  rows.push([t, host, cpu, mem]);
  const shift = next() < 0.05 ? Math.floor(next() * 1000) : 0;
  late.push([t - shift, host, cpu, mem]);
}
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string', required: false },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'mem', kind: 'number', required: false },
];
const mapping = {
  cpu_avg: { from: 'cpu', using: 'avg' },
  mem_max: { from: 'mem', using: 'max' },
  n: { from: 'cpu', using: 'count' },
};
const minute = Sequence.every('1m');
const busy = (e) => (e.get('cpu') ?? -1) > 0.5;

// Warm-up runs first: V8 is still compiling during the first ones.
const median = (f) => {
  for (let i = 0; i < 2; i++) f();
  const t = [];
  for (let i = 0; i < 5; i++) {
    const a = performance.now();
    f();
    t.push(performance.now() - a);
  }
  t.sort((a, b) => a - b);
  return t[2];
};
const oneByOne = (live, rs) => {
  for (const r of rs) live.push(r);
};
const capped = () =>
  new LiveSeries({ name: 'live', schema, retention: { maxEvents: 10_000 } });

const cases = [
  [
    'push one at a time',
    () => oneByOne(new LiveSeries({ name: 'live', schema }), rows),
  ],
  [
    'push_many, batches of 1000',
    () => {
      const live = new LiveSeries({ name: 'live', schema });
      for (let i = 0; i < N; i += 1000) live.pushMany(rows.slice(i, i + 1000));
    },
  ],
  [
    'push one at a time, max_events 10k',
    () =>
      oneByOne(
        new LiveSeries({
          name: 'live',
          schema,
          retention: { maxEvents: 10_000 },
        }),
        rows,
      ),
  ],
  [
    'reorder, 5% late within 1s, grace 2s',
    () =>
      oneByOne(
        new LiveSeries({
          name: 'live',
          schema,
          ordering: 'reorder',
          graceWindow: '2s',
        }),
        late,
      ),
  ],
  [
    'filter + aggregate 1m, nothing watched',
    () => {
      const live = new LiveSeries({ name: 'live', schema });
      live.filter(busy);
      live.aggregate(minute, mapping);
      oneByOne(live, rows);
    },
  ],
  [
    'filter + aggregate 1m, every output watched',
    () => {
      const live = new LiveSeries({ name: 'live', schema });
      const f = live.filter(busy);
      const a = live.aggregate(minute, mapping);
      let outputs = 0;
      const count = () => {
        outputs += 1;
      };
      live.on('event', count);
      live.on('batch', count);
      f.on('event', count);
      a.on('event', count);
      a.on('bucket', count);
      a.on('update', count);
      oneByOne(live, rows);
      if (outputs <= 3 * N) throw new Error('too few outputs');
    },
  ],
  [
    'filter + aggregate on max_events 10k',
    () => {
      const live = new LiveSeries({
        name: 'live',
        schema,
        retention: { maxEvents: 10_000 },
      });
      const f = live.filter(busy);
      f.aggregate(minute, mapping);
      f.on('evict', () => {});
      oneByOne(live, rows);
    },
  ],
  [
    'diff + rate + pct_change, max_events 10k',
    () => {
      const live = capped();
      live.diff('cpu');
      live.rate('cpu');
      live.pctChange('mem');
      oneByOne(live, rows);
    },
  ],
  [
    'fill hold + cumulative sum, max_events 10k',
    () => {
      const live = capped();
      live.fill('hold');
      live.cumulative({ cpu: 'sum' });
      oneByOne(live, rows);
    },
  ],
  [
    'map + select + sample 10, max_events 10k',
    () => {
      const live = capped();
      live.map((e) => {
        const v = e.get('cpu');
        return v === undefined ? e : e.set('cpu', v * 2);
      });
      live.select('cpu');
      live.sample({ stride: 10 });
      oneByOne(live, rows);
    },
  ],
  [
    'window 1000 rows + window 30s',
    () => {
      const live = capped();
      live.window(1000);
      live.window('30s');
      oneByOne(live, rows);
    },
  ],
  [
    'reorder 5% late: diff + fill + window 30s',
    () => {
      const live = new LiveSeries({
        name: 'live',
        schema,
        ordering: 'reorder',
        graceWindow: '2s',
        retention: { maxEvents: 10_000 },
      });
      live.diff('cpu');
      live.fill('hold');
      live.window('30s');
      oneByOne(live, late);
    },
  ],
];
const report = {};
for (const [name, f] of cases) {
  const ms = median(f);
  report[name] = Number(ms.toFixed(2));
  console.log(`${name.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms`);
}
console.log(JSON.stringify(report));
