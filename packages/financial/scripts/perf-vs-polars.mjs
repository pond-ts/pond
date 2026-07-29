// Runs the agent-query benchmark against **polars** and prints the
// comparison.
//
// `perf-vs-oracle.mjs` compares against pandas — the tool a practitioner
// would otherwise reach for. This asks the harder question: **how fast is
// this work when the kernels are Rust?**
//
// That makes polars the most relevant external number this project has.
// The Rust/WASM spike (`spikes/columnar-wasm/`) asked whether porting the
// substrate to Rust would pay; polars is that port, done by someone else,
// measured on the same workload. Where polars is far ahead, a Rust core
// has headroom to chase. Where it is level or behind, the remaining gap
// is not about the language.
//
// Needs a Python with polars:
//
//     /tmp/pondvenv/bin/pip install polars
//     PYTHON=/tmp/pondvenv/bin/python node packages/financial/scripts/perf-vs-polars.mjs
//
// Like the pandas comparison, this is a local tool — CI needs no Python.
//
// ── Reading it fairly ────────────────────────────────────────────────
//
// **Threads.** polars is multi-threaded by default and this machine gives
// it 10. pond-ts is single-threaded, and so is Node. Both polars columns
// are reported: `st` (POLARS_MAX_THREADS=1) is the per-core comparison and
// the one to read against pond-ts; `mt` is what polars actually delivers
// to a user who does not think about it, and is a fair thing to want.
//
// **Immutability.** `df.with_columns(...)` returns a new frame but shares
// the untouched columns; every pond-ts operation builds a new series with
// a schema. On the strategy stack pond-ts constructs six series.
//
// **Missing values.** polars tracks nulls in a validity bitmap, same as
// pond-ts — so unlike the pandas comparison, that cost is symmetric here.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON ?? '/tmp/pondvenv/bin/python';
const SCRIPT = resolve(HERE, 'oracle/perf-compare-polars.py');
const TS = resolve(HERE, 'perf-agent-queries.mjs');

function runJson(cmd, args, env) {
  return JSON.parse(
    execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    }),
  );
}

console.error('running pond-ts…');
const pond = runJson(process.execPath, [TS]);
console.error('running polars (single-threaded)…');
const st = runJson(PYTHON, [SCRIPT], { POLARS_MAX_THREADS: '1' });
console.error('running polars (all threads)…');
const mt = runJson(PYTHON, [SCRIPT]);

const pad = (x, w) => String(x).padStart(w);
console.log('═'.repeat(96));
console.log(
  `pond-ts vs polars ${mt.polars} · ${pond.bars.toLocaleString()} 1-minute OHLCV bars`,
);
console.log('═'.repeat(96));
console.log(
  `node ${process.version} single-threaded · polars st=1 thread, mt=${mt.threads} threads\n`,
);
console.log(
  `  ${pad('query', 42)} ${pad('pond-ts', 10)} ${pad('polars st', 10)} ${pad('polars mt', 10)} ${pad('vs st', 7)} ${pad('vs mt', 7)}`,
);
console.log(`  ${'─'.repeat(92)}`);

let group = '';
const rows = [];
for (let i = 0; i < pond.results.length; i += 1) {
  const r = pond.results[i];
  if (r.group !== group) {
    group = r.group;
    console.log(`  ${group}`);
  }
  const p = r.medianMs;
  const s = st.results[i].medianMs;
  const m = mt.results[i].medianMs;
  rows.push({ label: r.label, group, pond: p, st: s, mt: m });
  // < 1.00x means pond-ts is faster.
  console.log(
    `  ${pad(r.label, 42)} ${pad(p.toFixed(2) + 'ms', 10)} ${pad(s.toFixed(2) + 'ms', 10)} ` +
      `${pad(m.toFixed(2) + 'ms', 10)} ${pad((p / s).toFixed(2) + '×', 7)} ${pad((p / m).toFixed(2) + '×', 7)}`,
  );
}

const best = rows.reduce((a, b) => (a.pond / a.st < b.pond / b.st ? a : b));
const worst = rows.reduce((a, b) => (a.pond / a.st > b.pond / b.st ? a : b));
console.log();
console.log(
  `  best per-core:  ${best.label} at ${(best.pond / best.st).toFixed(2)}×`,
);
console.log(
  `  worst per-core: ${worst.label} at ${(worst.pond / worst.st).toFixed(2)}×`,
);
console.log('\n  (< 1.00× means pond-ts is faster)');
