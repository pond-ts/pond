/**
 * Is the interval-keyed columnar gap addressable?
 *
 * §6.4 measured `rows→series` at 50–67% of `aggregate`'s post-kernel
 * time, and attributed it to pond-ts having no columnar construction
 * door for interval keys — so even a substrate that computes the whole
 * answer in typed arrays has to emit frozen rows and let `TimeSeries`
 * re-columnarise them.
 *
 * "No door" is a claim about the current API, not about feasibility.
 * This script checks feasibility by **building the door** out of parts
 * that already exist, and measuring it:
 *
 *   IntervalKeyColumn(begin, end, labels, B)      ← already exists
 *     → ColumnarStore.fromTrustedStore(...)       ← already exists
 *     → SeriesStore.fromTrustedStore(store)       ← already exists
 *     → new TimeSeries({ …, [TRUSTED_SENTINEL] }) ← module-private
 *
 * Only the last hop is out of reach from outside `time-series.ts` — the
 * sentinel is a module-private Symbol. That is not an obstacle for the
 * real change, because **`aggregateInternal` already lives inside
 * `time-series.ts`** and can call the private `#fromTrustedStore`
 * directly. So this measures the whole path up to the store, and the
 * missing hop is an object literal plus a constructor call.
 *
 * Two facts make the key column nearly free to build:
 *
 *   - `Sequence` labels every bucket with `value: start` — the numeric
 *     bucket start. So `labelKind` is `'number'` and the label column
 *     holds exactly the same values as `begin`, which means it can
 *     **alias the same `Float64Array`** rather than allocate.
 *   - `end[b] === begin[b+1]` for a fixed-step sequence, so `end` is a
 *     shifted view of the same edge array the binning already needs.
 *
 * Run: node bench/interval-columnar.mjs
 */

import {
  Sequence,
  TimeRange,
  TimeSeries,
} from '../../../packages/core/dist/index.js';
import {
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
} from '../../../packages/core/dist/columnar/index.js';
import { SeriesStore } from '../../../packages/core/dist/live/series-store.js';
import '../../../packages/core/dist/column.js';
import { bench } from './suite.mjs';

const QUICK = process.argv.includes('--quick');
const budgetMs = QUICK ? 60 : 140;
const STEP_MS = 1_000;

/* ── the door, built from existing parts ──────────────────────────── */

/**
 * Assembles an interval-keyed `SeriesStore` from flat typed arrays —
 * the columnar door `fromColumns` doesn't offer yet.
 *
 * `labels` aliases `begin`: a `Float64Column` is a view object over a
 * buffer, so the numeric label column costs one object, not one array.
 * `IntervalKeyColumn`'s constructor then validates — and that validation
 * is the actual cost of this path, not the assembly (see the results).
 */
function intervalStoreFromColumns(schema, begin, end, valueColumns) {
  const B = begin.length;
  const labels = new Float64Column(begin, B, undefined, true);
  const keys = new IntervalKeyColumn(begin, end, labels, B);
  const columns = new Map();
  for (let k = 1; k < schema.length; k += 1) {
    const name = schema[k].name;
    columns.set(name, valueColumns[k - 1]);
  }
  const store = ColumnarStore.fromTrustedStore(schema, keys, columns);
  return SeriesStore.fromTrustedStore(store);
}

/** The current path, for comparison — frozen rows + validating intake. */
function rowsFromColumns(buckets, outCols) {
  const B = buckets.length;
  const c = outCols.length;
  const rows = new Array(B);
  for (let b = 0; b < B; b += 1) {
    const row = new Array(c + 1);
    row[0] = buckets[b];
    for (let k = 0; k < c; k += 1) {
      const v = outCols[k][b];
      row[k + 1] = Number.isNaN(v) ? undefined : v;
    }
    rows[b] = Object.freeze(row);
  }
  return rows;
}

/* ── workload ─────────────────────────────────────────────────────── */

/**
 * The grid carries a **deliberate gap** — a contiguous stretch of
 * missing samples — so some buckets come out empty. That is the only
 * place the two construction paths can disagree: an empty bucket
 * reduces to `undefined` on the row path and to `NaN` in a
 * `Float64Array`, and which one the columnar door should carry is the
 * single real design decision the change forces. A test on a gapless
 * grid would never exercise it and would report a false all-clear.
 */
function makeSeries(n, c) {
  const schema = Object.freeze([
    { name: 'time', kind: 'time' },
    ...Array.from({ length: c }, (_, i) => ({ name: `v${i}`, kind: 'number' })),
  ]);
  const gapStart = Math.floor(n * 0.4);
  const gapEnd = gapStart + Math.floor(n * 0.05);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    if (i >= gapStart && i < gapEnd) continue;
    rows.push([
      i * STEP_MS,
      ...Array.from({ length: c }, (_, k) => 50 + 35 * Math.sin(i / 5000 + k)),
    ]);
  }
  return {
    series: new TimeSeries({ name: 'metrics', schema, rows }),
    schema,
    span: (n - 1) * STEP_MS,
  };
}

console.log('═'.repeat(92));
console.log('Is the interval-keyed columnar gap addressable?');
console.log('═'.repeat(92));
console.log(
  `node ${process.version} · ${process.platform}/${process.arch} · n = 1M on a 1 s grid`,
);
console.log();

const N = QUICK ? 200_000 : 1_000_000;
const SHAPES = QUICK
  ? [{ bucketMs: 60_000, c: 4 }]
  : [
      { bucketMs: 10_000, c: 1 },
      { bucketMs: 10_000, c: 4 },
      { bucketMs: 60_000, c: 1 },
      { bucketMs: 60_000, c: 4 },
      { bucketMs: 600_000, c: 4 },
    ];

const results = [];
const problems = [];
let sentinelDivergences = 0;

for (const { bucketMs, c } of SHAPES) {
  const { series } = makeSeries(N, c);
  const range = new TimeRange({ start: 0, end: (N - 1) * STEP_MS });
  const sequence = Sequence.every(bucketMs);
  const mapping = Object.fromEntries(
    Array.from({ length: c }, (_, i) => [`v${i}`, i % 2 ? 'sum' : 'avg']),
  );
  const schemaOut = Object.freeze([
    { name: 'interval', kind: 'interval' },
    ...Object.keys(mapping).map((name) => ({
      name,
      kind: 'number',
      required: false,
    })),
  ]);

  const buckets = sequence.bounded(range, { sample: 'begin' }).intervals();
  const B = buckets.length;

  // The reference answer, from pond-ts itself.
  const reference = series.aggregate(sequence, mapping, { range });

  // Flat inputs the columnar door wants. In the real change these come
  // straight out of the reduce — `begin` is the edge array the bucketing
  // already built, and each value column is the reducer's output buffer.
  const begin = new Float64Array(B);
  const end = new Float64Array(B);
  for (let b = 0; b < B; b += 1) {
    begin[b] = buckets[b].begin();
    end[b] = buckets[b].end();
  }
  const outCols = Array.from({ length: c }, (_, k) => {
    const a = new Float64Array(B);
    for (let b = 0; b < B; b += 1) {
      const v = reference.column(`v${k}`).at(b);
      a[b] = v === undefined ? NaN : v;
    }
    return a;
  });
  const valueColumns = outCols.map(
    (a) => new Float64Column(a, B, undefined, false),
  );

  /* ── correctness: does the door produce the same thing? ─────────── */
  const store = intervalStoreFromColumns(schemaOut, begin, end, valueColumns);
  if (store.length !== reference.length) {
    problems.push(
      `bucket=${bucketMs} c=${c}: length ${store.length} vs ${reference.length}`,
    );
  } else {
    for (let i = 0; i < B; i += 1) {
      const ev = store.eventAt(i);
      const key = ev.key();
      if (
        key.begin() !== buckets[i].begin() ||
        key.end() !== buckets[i].end()
      ) {
        problems.push(`bucket=${bucketMs} c=${c}: row ${i} key mismatch`);
        break;
      }
      for (let k = 0; k < c; k += 1) {
        const got = ev.data()[`v${k}`];
        const want = reference.column(`v${k}`).at(i);
        // An empty bucket is `undefined` on the row path and `NaN` in a
        // `Float64Array`. Count those separately rather than waving them
        // through — the count is the size of the design decision.
        if (Number.isNaN(got) && want === undefined) {
          sentinelDivergences += 1;
          continue;
        }
        const same =
          Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want));
        if (!same) {
          problems.push(
            `bucket=${bucketMs} c=${c}: row ${i} v${k} = ${got}, want ${want}`,
          );
          break;
        }
      }
      if (problems.length) break;
    }
  }

  /* ── cost ───────────────────────────────────────────────────────── */
  const tRows = bench(
    () =>
      new TimeSeries({
        name: 'metrics',
        schema: schemaOut,
        rows: rowsFromColumns(buckets, outCols),
      }).length,
    { budgetMs },
  ).medianMs;

  const tColumnar = bench(
    () => intervalStoreFromColumns(schemaOut, begin, end, valueColumns).length,
    { budgetMs },
  ).medianMs;

  // How much of the columnar path is `IntervalKeyColumn`'s validation?
  // Its constructor makes four O(B) passes (finite begin, finite end,
  // begin<=end, and a per-row `labels.read(i)` label check).
  const labels = new Float64Column(begin, B, undefined, true);
  const tKeyColumn = bench(
    () => new IntervalKeyColumn(begin, end, labels, B).length,
    { budgetMs },
  ).medianMs;

  results.push({
    bucketMs,
    c,
    B,
    tRows,
    tColumnar,
    tKeyColumn,
    speedup: tRows / tColumnar,
    validationShare: tKeyColumn / tColumnar,
  });
}

if (problems.length) {
  console.error('✗ the columnar door does not reproduce pond-ts output:');
  for (const p of problems.slice(0, 8)) console.error(`    ${p}`);
  process.exit(1);
}
console.log('✓ the columnar door produces a store with identical keys');
console.log(
  `  ${sentinelDivergences.toLocaleString()} value cells differ, all of them the empty-bucket sentinel:\n` +
    '  NaN in the columnar store vs undefined on the row path. That is the one\n' +
    '  design decision the change forces — see the report.\n',
);

const pad = (x, w) => String(x).padStart(w);
console.log(
  `  ${pad('bucket', 8)} ${pad('C', 2)} ${pad('buckets', 8)}  ${pad('rows→series', 12)}  ` +
    `${pad('columnar', 10)}  ${pad('speedup', 8)}  ${pad('of which key validation', 23)}`,
);
console.log(`  ${'─'.repeat(88)}`);
for (const r of results) {
  console.log(
    `  ${pad(r.bucketMs / 1000 + 's', 8)} ${pad(r.c, 2)} ${pad(r.B.toLocaleString(), 8)}  ` +
      `${pad(r.tRows.toFixed(2) + 'ms', 12)}  ${pad(r.tColumnar.toFixed(2) + 'ms', 10)}  ` +
      `${pad(r.speedup.toFixed(1) + '×', 8)}  ` +
      `${pad((r.validationShare * 100).toFixed(0) + '%', 23)}`,
  );
}
console.log();
console.log(
  '  rows→series = the current path: frozen `[interval, …]` rows through the\n' +
    '                validating row intake.\n' +
    '  columnar    = IntervalKeyColumn + ColumnarStore.fromTrustedStore +\n' +
    '                SeriesStore.fromTrustedStore, all existing API. The remaining\n' +
    '                hop to `TimeSeries` is module-private, and `aggregateInternal`\n' +
    '                already lives in that module.\n' +
    '  key validation = `IntervalKeyColumn`s constructor: four O(B) passes (finite\n' +
    '                begin, finite end, begin<=end, per-row label read). This is\n' +
    '                nearly all of the columnar path — see the report.',
);
console.log();
