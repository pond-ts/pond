// Live front-eviction cost ([PND-EVICTSPLICE]): one event evicted per push
// from a buffer of `maxEvents` events, on the per-event buffers (LiveView,
// the row backing of 'drop' / 'reorder' roots, rolling history). Before the
// fix each eviction was `splice(0, n)`, which copies the whole buffer.
//
//   node scripts/perf-live-evict.mjs [path/to/dist/index.js]
import { performance } from 'node:perf_hooks';

const dist = process.argv[2] ?? '../dist/index.js';
const { LiveSeries } = await import(
  dist.startsWith('.') ? new URL(dist, import.meta.url).href : dist
);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
]);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(name, build, pushes, repeats = 5) {
  const run = () => {
    const live = build();
    const start = performance.now();
    for (let i = 0; i < pushes; i += 1) live.push([i * 100, i % 97]);
    return performance.now() - start;
  };
  run(); // warm-up
  const ms = median(Array.from({ length: repeats }, run));
  return { name, pushes, ms: Number(ms.toFixed(1)) };
}

const capped = (ordering, maxEvents) => () =>
  new LiveSeries({
    name: 'cpu',
    schema,
    ordering,
    retention: { maxEvents },
  });

const results = [];
for (const maxEvents of [1_000, 10_000]) {
  // Per-event floor: no eviction-heavy structure besides the root.
  results.push(
    benchmark(
      `strict root, maxEvents ${maxEvents}`,
      capped('strict', maxEvents),
      100_000,
    ),
  );
  results.push(
    benchmark(
      `reorder root, maxEvents ${maxEvents}`,
      capped('reorder', maxEvents),
      100_000,
    ),
  );
  results.push(
    benchmark(
      `strict root + filter view, maxEvents ${maxEvents}`,
      () => {
        const live = capped('strict', maxEvents)();
        live.filter(() => true);
        return live;
      },
      100_000,
    ),
  );
  results.push(
    benchmark(
      `strict root + 3 diff views, maxEvents ${maxEvents}`,
      () => {
        const live = capped('strict', maxEvents)();
        live.diff('cpu');
        live.rate('cpu');
        live.pctChange('cpu');
        return live;
      },
      100_000,
    ),
  );
}
// Large buffers (past V8's in-place shift limit): one eviction per push,
// and a burst of 20k evictions from a 100k buffer in one pushMany.
results.push(
  benchmark(
    'reorder root, maxEvents 100k',
    capped('reorder', 100_000),
    110_000,
    3,
  ),
);
results.push(
  benchmark(
    'strict root + filter view, maxEvents 100k',
    () => {
      const live = capped('strict', 100_000)();
      live.filter(() => true);
      return live;
    },
    110_000,
    3,
  ),
);
{
  const burst = () => {
    const live = capped('reorder', 100_000)();
    live.filter(() => true);
    const rows = (from) =>
      Array.from({ length: 20_000 }, (_, i) => [(from + i) * 100, i % 97]);
    const start = performance.now();
    for (let b = 0; b < 8; b += 1) live.pushMany(rows(b * 20_000));
    return performance.now() - start;
  };
  burst();
  const ms = median([burst(), burst(), burst()]);
  results.push({
    name: 'reorder root + filter view, maxEvents 100k, pushMany 20k x 8',
    pushes: 160_000,
    ms: Number(ms.toFixed(1)),
  });
}
// Sparse: no eviction at all (the shift path must not cost the no-op case).
results.push(
  benchmark(
    'strict root + filter view, no retention',
    () => {
      const live = new LiveSeries({ name: 'cpu', schema });
      live.filter(() => true);
      return live;
    },
    100_000,
  ),
);
console.log(JSON.stringify(results, null, 2));
