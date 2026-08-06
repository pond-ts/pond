/**
 * `ValueSeries` ingest / export doors — the row (`fromJSON` / `toJSON` /
 * `toRows` / `toObjects`), columnar-JSON (`toColumns`) and Arrow (`toArrow`)
 * paths, against the columnar door as the baseline.
 *
 * Analytical cost, which is what these numbers are checking for surprises
 * against (N rows, C value columns):
 *
 * - `fromJSON` — O(N·C): one pass to transpose + kind-check every cell, then
 *   the shared ingest engine's O(N·C) pack. Allocates the transpose buffers
 *   (one `Float64Array(N)` for the axis, C `Array(N)`) on top of the packed
 *   columns. Strictly more work than `fromColumns` for the same data — the
 *   per-cell kind check IS the row door's product.
 * - `toRows` / `toObjects` / `toJSON` — O(N·C) with **N allocations** (one
 *   frozen tuple / object per row). The object forms also pay C property
 *   writes per row against C array writes.
 * - `toColumns` — O(N·C) with **C allocations**. The reason to prefer it for
 *   a large payload has nothing to do with the walk and everything to do with
 *   not minting N objects.
 * - `toArrow` — O(C): a buffer handoff, no per-row work at all. It should be
 *   ~three orders of magnitude faster than the row doors here, and if it ever
 *   isn't, something started copying.
 *
 * Run: `node scripts/perf-value-series-io.mjs` (after `npm run build`).
 */
import { performance } from 'node:perf_hooks';
import { ValueSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'strike', kind: 'value' },
  { name: 'iv', kind: 'number' },
  { name: 'delta', kind: 'number' },
  { name: 'gamma', kind: 'number' },
  { name: 'vega', kind: 'number' },
  { name: 'oi', kind: 'number' },
  { name: 'venue', kind: 'string' },
]);

// The gap scenarios need the columns declared optional: `fromJSON` is the
// strict door, so a `null` in a required column is an error, not a gap.
const sparseSchema = Object.freeze([
  schema[0],
  ...schema.slice(1).map((c) => ({ ...c, required: false })),
]);

const NUMERIC = ['iv', 'delta', 'gamma', 'vega', 'oi'];
const VENUES = ['cme', 'ice', 'eurex', 'osaka'];

/** Columnar payload: the shape `fromColumns` takes. */
function makeColumns(length, { sparse = false } = {}) {
  const strike = new Float64Array(length);
  for (let i = 0; i < length; i += 1) strike[i] = i * 0.5;
  const columns = { strike };
  for (const name of NUMERIC) {
    const col = new Array(length);
    for (let i = 0; i < length; i += 1) {
      col[i] = sparse && i % 10 === 0 ? null : (i % 100) / 7;
    }
    columns[name] = col;
  }
  const venue = new Array(length);
  for (let i = 0; i < length; i += 1) {
    venue[i] = sparse && i % 10 === 0 ? null : VENUES[i % VENUES.length];
  }
  columns.venue = venue;
  return columns;
}

/** Tuple rows: the shape `fromJSON` takes by default. */
function makeTupleRows(length, { sparse = false } = {}) {
  const columns = makeColumns(length, { sparse });
  const names = schema.map((c) => c.name);
  const rows = new Array(length);
  for (let i = 0; i < length; i += 1) {
    const row = new Array(names.length);
    for (let c = 0; c < names.length; c += 1) row[c] = columns[names[c]][i];
    rows[i] = row;
  }
  return rows;
}

/** Object rows: the other `fromJSON` shape (a JSON API's natural output). */
function makeObjectRows(length, { sparse = false } = {}) {
  const columns = makeColumns(length, { sparse });
  const names = schema.map((c) => c.name);
  const rows = new Array(length);
  for (let i = 0; i < length; i += 1) {
    const row = {};
    for (const name of names) row[name] = columns[name][i];
    rows[i] = row;
  }
  return rows;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function benchmark(scenario, length, fn, { repeats = 7 } = {}) {
  fn(); // warmup
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    if (result === undefined || result === null) {
      throw new Error(`no result for ${scenario}`);
    }
    samples.push(end - start);
  }
  return {
    scenario,
    length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const LENGTH = 100_000;
const FLOOR = 1_000;

const denseColumns = makeColumns(LENGTH);
const sparseColumns = makeColumns(LENGTH, { sparse: true });
const denseTuples = makeTupleRows(LENGTH);
const sparseTuples = makeTupleRows(LENGTH, { sparse: true });
const denseObjects = makeObjectRows(LENGTH);
const floorTuples = makeTupleRows(FLOOR);
// Descending axis: `sort: true` pays a full permutation.
const shuffledTuples = makeTupleRows(LENGTH).slice().reverse();

const dense = ValueSeries.fromColumns({
  name: 'chain',
  schema,
  columns: denseColumns,
});
const sparse = ValueSeries.fromColumns({
  name: 'chain',
  schema: sparseSchema,
  columns: sparseColumns,
});

const results = [
  // ── Ingest ────────────────────────────────────────────────────────────
  benchmark('fromColumns — baseline (100k x 7)', LENGTH, () =>
    ValueSeries.fromColumns({ name: 'b', schema, columns: denseColumns }),
  ),
  benchmark('fromJSON — tuple rows (100k x 7)', LENGTH, () =>
    ValueSeries.fromJSON({ name: 'b', schema, rows: denseTuples }),
  ),
  benchmark('fromJSON — tuple rows, ~10% gaps (100k x 7)', LENGTH, () =>
    ValueSeries.fromJSON({
      name: 'b',
      schema: sparseSchema,
      rows: sparseTuples,
    }),
  ),
  benchmark('fromJSON — object rows (100k x 7)', LENGTH, () =>
    ValueSeries.fromJSON({ name: 'b', schema, rows: denseObjects }),
  ),
  benchmark('fromJSON — sort: true, descending (100k x 7)', LENGTH, () =>
    ValueSeries.fromJSON({
      name: 'b',
      schema,
      rows: shuffledTuples,
      sort: true,
    }),
  ),
  benchmark('fromJSON — per-element floor (1k x 7)', FLOOR, () =>
    ValueSeries.fromJSON({ name: 'b', schema, rows: floorTuples }),
  ),

  // ── Export ────────────────────────────────────────────────────────────
  benchmark('toRows (100k x 7)', LENGTH, () => dense.toRows()),
  benchmark('toObjects (100k x 7)', LENGTH, () => dense.toObjects()),
  benchmark('toJSON — tuple rows (100k x 7)', LENGTH, () => dense.toJSON()),
  benchmark('toJSON — object rows (100k x 7)', LENGTH, () =>
    dense.toJSON({ rowFormat: 'object' }),
  ),
  benchmark('toColumns (100k x 7)', LENGTH, () => dense.toColumns()),
  benchmark('toColumns — ~10% gaps (100k x 7)', LENGTH, () =>
    sparse.toColumns(),
  ),
  benchmark('toArrow — buffer handoff (100k x 7)', LENGTH, () =>
    dense.toArrow(),
  ),
  benchmark('toArrow — ~10% gaps (100k x 7)', LENGTH, () => sparse.toArrow()),
  benchmark('toRows — per-element floor (1k x 7)', FLOOR, () =>
    dense.sliceByValue(0, FLOOR * 0.5).toRows(),
  ),
];

console.log(JSON.stringify(results, null, 2));
