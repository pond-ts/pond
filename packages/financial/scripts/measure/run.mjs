/**
 * TypeScript vs Rust on the same process requests — [PND-RUST-R5] step 7.
 *
 * For each workload and size, runs `one.mjs` (TypeScript, in node) and
 * `crates/pond-process/examples/measure.rs` (Rust, release build), each in
 * its own process, checks the facts they answer are identical, and prints
 * a table. `cold` is a fresh host (every node computed), median of the
 * runs; `warm` is the same request again on that host (served from cache).
 *
 * Build first: pond-ts, @pond-ts/process and @pond-ts/financial
 * (`npm run build --workspace=…`), then
 *   cargo build --release --example measure -p pond-process
 *   node packages/financial/scripts/measure/run.mjs [out.json]
 *
 * SIZES=market:2520,telemetry:1000000 picks the cases.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUESTS } from './workloads.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../../../..');
const rust = join(root, 'target/release/examples/measure');
const one = join(here, 'one.mjs');

const SIZES = (
  process.env.SIZES ??
  'market:2520,market:1000000,telemetry:1000000,telemetry:10000000'
)
  .split(',')
  .map((s) => {
    const [workload, rows] = s.split(':');
    return { workload, rows: Number(rows) };
  });
const runsFor = (rows) => (rows <= 10_000 ? 7 : rows <= 1_000_000 ? 5 : 3);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const dir = mkdtempSync(join(tmpdir(), 'pond-measure-'));
const results = [];
for (const { workload, rows } of SIZES) {
  const runs = runsFor(rows);
  const requestFile = join(dir, `${workload}.json`);
  writeFileSync(requestFile, JSON.stringify(REQUESTS[workload]));
  const ts = JSON.parse(
    execFileSync(
      process.execPath,
      ['--max-old-space-size=12000', one, workload, String(rows), String(runs)],
      { maxBuffer: 1 << 28 },
    ),
  );
  const rs = JSON.parse(
    execFileSync(rust, [workload, String(rows), String(runs), requestFile], {
      maxBuffer: 1 << 28,
    }),
  );
  const same =
    JSON.stringify(ts.facts) === JSON.stringify(rs.facts) &&
    ts.skipped.length === 0 &&
    rs.skipped.length === 0;
  const row = {
    workload,
    rows,
    runs,
    facts: ts.facts.length,
    same,
    ts: {
      coldMs: median(ts.coldMs),
      warmMs: ts.warmMs,
      loadMs: ts.loadMs,
      peakRssMb: ts.peakRssMb,
    },
    rs: {
      coldMs: median(rs.coldMs),
      warmMs: rs.warmMs,
      loadMs: rs.loadMs,
      peakRssMb: rs.peakRssMb,
    },
  };
  row.speedup = row.ts.coldMs / row.rs.coldMs;
  results.push(row);
  if (!same) {
    console.error(`${workload} ${rows}: the facts differ`);
    writeFileSync(
      join(dir, `${workload}-${rows}-ts.json`),
      JSON.stringify(ts.facts, null, 1),
    );
    writeFileSync(
      join(dir, `${workload}-${rows}-rs.json`),
      JSON.stringify(rs.facts, null, 1),
    );
    console.error(`  both written under ${dir}`);
  }
  const f = (x) => x.toFixed(x < 10 ? 2 : 0);
  console.log(
    `${workload.padEnd(9)} ${String(rows).padStart(10)} rows | ` +
      `cold TS ${f(row.ts.coldMs)} ms, Rust ${f(row.rs.coldMs)} ms (${row.speedup.toFixed(1)}×) | ` +
      `warm TS ${f(row.ts.warmMs)} ms, Rust ${f(row.rs.warmMs)} ms | ` +
      `peak TS ${f(row.ts.peakRssMb)} MB, Rust ${f(row.rs.peakRssMb)} MB | ` +
      `facts ${same ? 'identical' : 'DIFFER'}`,
  );
}
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
