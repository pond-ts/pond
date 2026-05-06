/**
 * Bench for the fused multi-window rolling primitive
 * (`live.partitionBy('host').rolling({ '1m': m1, '200ms': m2 }, { trigger })`).
 *
 * Mirrors the gRPC experiment's V6→V7 cost story (PR #19): the
 * regression was the second `LivePartitionedSyncRolling` doubling
 * every per-event pond hop. Fused rolling does the per-event work
 * once over a shared deque per partition; the win should show up as
 * "fused ≈ single rolling" rather than "fused = 2× single rolling."
 *
 * Scenarios:
 *   1. Single rolling — baseline cost.
 *   2. Two separate rollings — V7 shape (what gRPC ran).
 *   3. Fused two-window rolling — V8 shape (the new primitive).
 *   4. Same shapes on the partitioned variant (this is what gRPC
 *      actually uses, with `byHost.rolling(..., { trigger })`).
 *
 * Acceptance bar (from gRPC RFC #20):
 *   - Fused ≈ single-rolling cost (within run-to-run noise).
 *   - Significantly less than two-rollings cost (the doubled-hop
 *     story closes).
 *   - Heap delta similarly tracks single rather than two-rollings.
 */
import { performance } from 'node:perf_hooks';
import { LiveSeries, Trigger } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function tryGc() {
  if (typeof globalThis.gc === 'function') globalThis.gc();
}

function benchmark(label, fn, repeats = 5) {
  for (let run = 0; run < 2; run += 1) fn();
  tryGc();
  const wall = [];
  const heap = [];
  for (let run = 0; run < repeats; run += 1) {
    tryGc();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    fn();
    const end = performance.now();
    const heapAfter = process.memoryUsage().heapUsed;
    wall.push(end - start);
    heap.push((heapAfter - heapBefore) / (1024 * 1024));
  }
  return {
    label,
    medianMs: Number(median(wall).toFixed(2)),
    minMs: Number(Math.min(...wall).toFixed(2)),
    maxMs: Number(Math.max(...wall).toFixed(2)),
    medianHeapMb: Number(median(heap).toFixed(2)),
  };
}

const results = [];

// ── 1. Non-partitioned: single vs two-separate vs fused ────────

{
  const N = 100_000;
  const trig = Trigger.every('100ms');

  results.push(
    benchmark(`non-partitioned single rolling — ${N} events`, () => {
      const live = new LiveSeries({ name: 'cpu', schema });
      const r = live.rolling(
        '1m',
        { cpu_avg: { from: 'cpu', using: 'avg' } },
        { trigger: trig },
      );
      void r;
      for (let i = 0; i < N; i++) {
        live.push([i, i % 100, 'host']);
      }
    }),
  );

  results.push(
    benchmark(`non-partitioned two separate rollings — ${N} events`, () => {
      const live = new LiveSeries({ name: 'cpu', schema });
      const r1 = live.rolling(
        '1m',
        { cpu_avg: { from: 'cpu', using: 'avg' } },
        { trigger: trig },
      );
      const r2 = live.rolling(
        '200ms',
        { cpu_max: { from: 'cpu', using: 'max' } },
        { trigger: trig },
      );
      void r1;
      void r2;
      for (let i = 0; i < N; i++) {
        live.push([i, i % 100, 'host']);
      }
    }),
  );

  results.push(
    benchmark(`non-partitioned fused two-window — ${N} events`, () => {
      const live = new LiveSeries({ name: 'cpu', schema });
      const r = live.rolling(
        {
          '1m': { cpu_avg: { from: 'cpu', using: 'avg' } },
          '200ms': { cpu_max: { from: 'cpu', using: 'max' } },
        },
        { trigger: trig },
      );
      void r;
      for (let i = 0; i < N; i++) {
        live.push([i, i % 100, 'host']);
      }
    }),
  );
}

// ── 2. Partitioned: single vs two-separate vs fused ────────────
// This is the gRPC use case shape — `byHost.rolling(...)` with
// clock trigger. The agent's RFC sets the V6/V7/V8 acceptance bar
// here.

{
  const N = 100_000;
  const hosts = 100;
  const trig = Trigger.every('100ms');

  results.push(
    benchmark(
      `partitioned single sync rolling — ${N} events × ${hosts} hosts`,
      () => {
        const live = new LiveSeries({ name: 'cpu', schema });
        const r = live
          .partitionBy('host')
          .rolling(
            '1m',
            { cpu_avg: { from: 'cpu', using: 'avg' } },
            { trigger: trig },
          );
        void r;
        for (let i = 0; i < N; i++) {
          live.push([i, i % 100, `host-${i % hosts}`]);
        }
      },
      3,
    ),
  );

  results.push(
    benchmark(
      `partitioned two separate sync rollings — ${N} events × ${hosts} hosts`,
      () => {
        const live = new LiveSeries({ name: 'cpu', schema });
        const r1 = live
          .partitionBy('host')
          .rolling(
            '1m',
            { cpu_avg: { from: 'cpu', using: 'avg' } },
            { trigger: trig },
          );
        const r2 = live
          .partitionBy('host')
          .rolling(
            '200ms',
            { cpu_max: { from: 'cpu', using: 'max' } },
            { trigger: trig },
          );
        void r1;
        void r2;
        for (let i = 0; i < N; i++) {
          live.push([i, i % 100, `host-${i % hosts}`]);
        }
      },
      3,
    ),
  );

  results.push(
    benchmark(
      `partitioned fused two-window — ${N} events × ${hosts} hosts`,
      () => {
        const live = new LiveSeries({ name: 'cpu', schema });
        const r = live.partitionBy('host').rolling(
          {
            '1m': { cpu_avg: { from: 'cpu', using: 'avg' } },
            '200ms': { cpu_max: { from: 'cpu', using: 'max' } },
          },
          { trigger: trig },
        );
        void r;
        for (let i = 0; i < N; i++) {
          live.push([i, i % 100, `host-${i % hosts}`]);
        }
      },
      3,
    ),
  );
}

// ── 3. Higher cardinality (matches V7 ceiling regime) ──────────

{
  const N = 100_000;
  const hosts = 1000;
  const trig = Trigger.every('100ms');

  results.push(
    benchmark(
      `partitioned two separate sync rollings — ${N} events × ${hosts} hosts`,
      () => {
        const live = new LiveSeries({ name: 'cpu', schema });
        const r1 = live
          .partitionBy('host')
          .rolling(
            '1m',
            { cpu_avg: { from: 'cpu', using: 'avg' } },
            { trigger: trig },
          );
        const r2 = live
          .partitionBy('host')
          .rolling(
            '200ms',
            { cpu_max: { from: 'cpu', using: 'max' } },
            { trigger: trig },
          );
        void r1;
        void r2;
        for (let i = 0; i < N; i++) {
          live.push([i, i % 100, `host-${i % hosts}`]);
        }
      },
      3,
    ),
  );

  results.push(
    benchmark(
      `partitioned fused two-window — ${N} events × ${hosts} hosts`,
      () => {
        const live = new LiveSeries({ name: 'cpu', schema });
        const r = live.partitionBy('host').rolling(
          {
            '1m': { cpu_avg: { from: 'cpu', using: 'avg' } },
            '200ms': { cpu_max: { from: 'cpu', using: 'max' } },
          },
          { trigger: trig },
        );
        void r;
        for (let i = 0; i < N; i++) {
          live.push([i, i % 100, `host-${i % hosts}`]);
        }
      },
      3,
    ),
  );
}

// ── 4. Scaling — N rollings vs fused-N-windows ────────────────
// The architectural argument: every per-event pond hop runs ONCE
// in fused vs N times in N separate rollings. So the win should
// compound at N=3, 4, 5 even before the doubled-deque heap effect
// stacks. These scenarios make that scaling visible.
//
// Each rolling/window uses a different reducer over the same
// source column — `avg`, `stdev`, `max`, `min`, `count`. Different
// windows for diversity.

const reducerKinds = ['avg', 'stdev', 'max', 'min', 'count'];
const windowDurations = ['1m', '30s', '10s', '5s', '1s'];

function buildSeparate(live, n, trig) {
  const accs = [];
  for (let i = 0; i < n; i++) {
    accs.push(
      live.partitionBy('host').rolling(
        windowDurations[i],
        {
          [`cpu_${reducerKinds[i]}`]: { from: 'cpu', using: reducerKinds[i] },
        },
        { trigger: trig },
      ),
    );
  }
  return accs;
}

function buildFused(live, n, trig) {
  const mapping = {};
  for (let i = 0; i < n; i++) {
    mapping[windowDurations[i]] = {
      [`cpu_${reducerKinds[i]}`]: { from: 'cpu', using: reducerKinds[i] },
    };
  }
  return live.partitionBy('host').rolling(mapping, { trigger: trig });
}

{
  const N = 100_000;
  const hosts = 100;
  const trig = Trigger.every('100ms');

  for (const n of [2, 3, 4, 5]) {
    results.push(
      benchmark(
        `scaling — ${n} separate rollings — ${N} events × ${hosts} hosts`,
        () => {
          const live = new LiveSeries({ name: 'cpu', schema });
          const accs = buildSeparate(live, n, trig);
          void accs;
          for (let i = 0; i < N; i++) {
            live.push([i, i % 100, `host-${i % hosts}`]);
          }
        },
        3,
      ),
    );

    results.push(
      benchmark(
        `scaling — fused ${n}-window — ${N} events × ${hosts} hosts`,
        () => {
          const live = new LiveSeries({ name: 'cpu', schema });
          const r = buildFused(live, n, trig);
          void r;
          for (let i = 0; i < N; i++) {
            live.push([i, i % 100, `host-${i % hosts}`]);
          }
        },
        3,
      ),
    );
  }
}

// ── 5. Non-partitioned firehose regression (gRPC PR #26) ──────
// Pre-v0.15.2 the non-partitioned rolling used `Array.shift()` to
// evict the deque front. At firehose rates with a multi-second
// window the deque holds tens of thousands of entries; eviction
// loops that shift one-at-a-time fall off V8's hidden-offset
// optimization and turn quadratic.
//
// The bench targets the worst case: a steady-state deque sized at
// ~rate × window_seconds. Once full, every ingest evicts one
// entry — the shift loop fires `entries.length` times eventually
// across the run, with the deque large the whole time.

{
  // Steady-state deque ≈ N (tight 1ms timestamps, window covers
  // entire run). Eviction never kicks in; just append-only growth.
  // Post-v0.15.2 the head-index pointer leaves this case unchanged
  // — the cliff was specific to large-deque + per-ingest-eviction.
  const N = 200_000;
  const trig = Trigger.every('100ms');
  results.push(
    benchmark(
      `non-partitioned 5m rolling, all-events-in-window — ${N} events`,
      () => {
        const live = new LiveSeries({ name: 'cpu', schema });
        const r = live.rolling(
          '5m',
          { events_per_sec: { from: 'cpu', using: 'count' } },
          { trigger: trig },
        );
        void r;
        for (let i = 0; i < N; i++) {
          live.push([i, i % 100, 'host']);
        }
      },
      3,
    ),
  );

  // Worst-case shift pattern: large steady-state deque AND
  // continuous eviction. Window narrower than total span; first
  // half fills, second half evicts one-per-event.
  // Configured so deque holds ~50k entries through the eviction
  // phase (window=50s, span=100s, 1k events/s).
  const FILL = 50_000;
  const EVICT = 50_000;
  results.push(
    benchmark(
      `non-partitioned firehose, deque ~${FILL} entries with continuous eviction`,
      () => {
        const live = new LiveSeries({ name: 'cpu', schema });
        const r = live.rolling(
          '50s',
          { count: { from: 'cpu', using: 'count' } },
          { trigger: trig },
        );
        void r;
        // Fill phase: timestamps 0..FILL-1 (1ms apart) — deque
        // grows to FILL entries, none evicted (50s window > 50s span).
        for (let i = 0; i < FILL; i++) {
          live.push([i, i % 100, 'host']);
        }
        // Evict phase: timestamps FILL..FILL+EVICT-1 — every event
        // evicts the entry one window-ago. Deque stays ~FILL.
        for (let i = 0; i < EVICT; i++) {
          live.push([FILL + i, i % 100, 'host']);
        }
      },
      3,
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
