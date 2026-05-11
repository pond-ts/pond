import { performance } from 'node:perf_hooks';
import { LiveSeries, Trigger } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'mem', kind: 'number' },
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

function memoryMb() {
  const memory = process.memoryUsage();
  return (memory.heapUsed + memory.arrayBuffers) / 1024 / 1024;
}

function benchmark(label, fn, repeats = 5) {
  for (let run = 0; run < 2; run += 1) fn();
  tryGc();
  const wall = [];
  const memory = [];
  for (let run = 0; run < repeats; run += 1) {
    tryGc();
    const memoryBefore = memoryMb();
    const start = performance.now();
    fn();
    const end = performance.now();
    memory.push(memoryMb() - memoryBefore);
    wall.push(end - start);
  }
  return {
    label,
    medianMs: Number(median(wall).toFixed(2)),
    minMs: Number(Math.min(...wall).toFixed(2)),
    maxMs: Number(Math.max(...wall).toFixed(2)),
    medianMemoryMb: Number(median(memory).toFixed(2)),
  };
}

function pushRows(live, count, start = 0) {
  for (let i = 0; i < count; i += 1) {
    const t = start + i;
    live.push([t, i % 100, (i * 3) % 100, `host-${i % 10}`]);
  }
}

const trigger = Trigger.every('100ms');
const results = [];

{
  const count = 200_000;
  results.push(
    benchmark(`numeric fast path, append-only window — ${count} events`, () => {
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        retention: { maxEvents: 1 },
      });
      live.rolling(
        '5m',
        {
          cpuAvg: { from: 'cpu', using: 'avg' },
          cpuMax: { from: 'cpu', using: 'max' },
          memSum: { from: 'mem', using: 'sum' },
        },
        { trigger },
      );
      pushRows(live, count);
    }),
  );
}

{
  const fill = 100_000;
  const evict = 100_000;
  results.push(
    benchmark(
      `numeric fast path, continuous eviction — ${fill} live + ${evict} evicting events`,
      () => {
        const live = new LiveSeries({
          name: 'metrics',
          schema,
          retention: { maxEvents: 1 },
        });
        live.rolling(
          '100s',
          {
            cpuAvg: { from: 'cpu', using: 'avg' },
            cpuMax: { from: 'cpu', using: 'max' },
            memSum: { from: 'mem', using: 'sum' },
          },
          { trigger },
        );
        pushRows(live, fill);
        pushRows(live, evict, fill);
      },
    ),
  );
}

{
  const count = 200_000;
  results.push(
    benchmark(
      `generic fallback, string reducer anchor — ${count} events`,
      () => {
        const live = new LiveSeries({
          name: 'metrics',
          schema,
          retention: { maxEvents: 1 },
        });
        live.rolling(
          '5m',
          {
            cpuAvg: { from: 'cpu', using: 'avg' },
            hostLast: { from: 'host', using: 'last' },
          },
          { trigger },
        );
        pushRows(live, count);
      },
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
