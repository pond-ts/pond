/**
 * M3 — what it actually costs to get a node's column onto a chart.
 *
 * The demo plan framed this as a fork: assembled `TimeSeries` versus
 * per-column arrays into a layer. That framing was wrong. `@pond-ts/charts`
 * already traverses columnar — the key axis is a zero-copy `subarray` over
 * the key buffer, and values land in a `Float64Array` with no per-row
 * object anywhere on the render path.
 *
 * What is left is two **core** gaps, both already filed, that together put
 * two full O(N) passes and one boxing pass between a node value and a
 * stroked line:
 *
 * 1. `appendColumn` must box a **gapped** column, because core's
 *    `withColumn` takes values rather than a column and rejects a
 *    non-finite cell. Core appends columns directly internally
 *    (`withColumnAppended`) but does not expose it. Every rolling study
 *    has a warm-up, so the boxing path is the common one, not the edge.
 * 2. charts' `readNumericColumn` walks `col.read(i)` per row instead of
 *    the bulk `toFloat64Array()`, because the bulk readers are mounted on
 *    the prototype by a side-effect import and get tree-shaken out of
 *    browser bundles (charts F-1 / PND_CORE_PLAN).
 *
 * This script puts numbers on both. Run it after
 * `npm run build --workspace=pond-ts --workspace=@pond-ts/process`:
 *
 *     node packages/process/scripts/demo-m3-render-path.mjs
 */

import { TimeSeries } from 'pond-ts';
import { appendColumn, packColumn } from '@pond-ts/process';

const ROWS = Number(process.argv[2] ?? 150_000);
const REPEATS = 7;
const WARMUP = 20; // an sma(20)'s worth of leading gap

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
];

function bars(n) {
  const rows = new Array(n);
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    px += Math.sin(i / 97) * 0.05;
    rows[i] = [Date.UTC(2025, 0, 1) + i * 300_000, px];
  }
  return TimeSeries.fromJSON({ name: 'bars', schema, rows });
}

/** Median of `REPEATS` timings, in ms to 3dp. */
function timeIt(label, fn) {
  const runs = [];
  for (let r = 0; r < REPEATS; r += 1) {
    const t0 = performance.now();
    fn();
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)];
  return { label, ms: Math.round(median * 1000) / 1000 };
}

const series = bars(ROWS);

// Two node values of the same length: one gapless (a scale), one with the
// warm-up gap every rolling study has.
const gapless = packColumn(
  Float64Array.from({ length: ROWS }, (_, i) => i * 0.5),
);
const gapped = packColumn(
  Array.from({ length: ROWS }, (_, i) => (i < WARMUP ? undefined : i * 0.5)),
);

console.log(`rows: ${ROWS.toLocaleString()}   warm-up gap: ${WARMUP} cells`);
console.log(
  `gapless validity: ${gapless.validity === undefined ? 'absent (fast path)' : 'present'}`,
);
console.log(
  `gapped  validity: ${gapped.validity === undefined ? 'absent' : 'present (boxing path)'}\n`,
);

// ── 1. assembly ──────────────────────────────────────────────
console.log('appendColumn — putting a node value back onto a series');
for (const { label, ms } of [
  timeIt('gapless (toFloat64Array round trip)', () =>
    appendColumn(series, 'out', gapless),
  ),
  timeIt('gapped  (boxed fallback)', () => appendColumn(series, 'out', gapped)),
]) {
  console.log(`  ${label.padEnd(38)} ${ms.toFixed(3)} ms`);
}

// ── 2. the read charts performs ──────────────────────────────
// `readNumericColumn`'s loop, reproduced exactly (charts/src/data.ts).
function readPerElement(col, length) {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const v = col.read(i);
    out[i] = v === undefined ? NaN : v;
  }
  return out;
}

const hasBulk = typeof gapped.toFloat64Array === 'function';
console.log('\nvalue materialization — what a chart layer does per column');
console.log(
  `  bulk toFloat64Array available here: ${hasBulk ? 'yes (Node)' : 'no'}`,
);
for (const { label, ms } of [
  timeIt('per-element read(i)  [what ships]', () =>
    readPerElement(gapped, ROWS),
  ),
  ...(hasBulk
    ? [
        timeIt('bulk toFloat64Array  [blocked]', () =>
          gapped.toFloat64Array(),
        ),
      ]
    : []),
]) {
  console.log(`  ${label.padEnd(38)} ${ms.toFixed(3)} ms`);
}

console.log(
  '\nNote: the bulk reader is reachable here because this is Node. In a\n' +
    'Vite/Rollup browser bundle it is tree-shaken away (charts F-1), which\n' +
    'is why the shipping path is the per-element one.',
);
