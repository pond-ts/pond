// Runs the agent-query benchmark against the **pandas** oracle and prints
// the comparison.
//
// `scripts/oracle/generate.py` establishes that our studies agree with
// pandas bar-for-bar. This asks the other question: how fast is pandas at
// the same work? "As fast as possible" needs a reference point that isn't
// our own previous commit, and pandas is the right one — `rolling().mean()`
// and `rolling().std()` are Cython over contiguous numpy buffers using the
// same O(1)-per-bar incremental algorithms, and it is what a practitioner
// would otherwise reach for.
//
// Needs a Python with pandas. The oracle README already documents the venv:
//
//     python3 -m venv .venv && .venv/bin/pip install pandas
//     PYTHON=.venv/bin/python node packages/financial/scripts/perf-vs-oracle.mjs
//
// Like `generate.py`, this is a local tool — CI needs no Python.
//
// ── Reading it fairly ────────────────────────────────────────────────
//
// The two sides do not do identical work, and the differences run in
// pond-ts's favour on the input and against it on the output:
//
//   - pandas tracks missing values as NaN *inline* in the same float64
//     buffer. pond-ts keeps a separate validity bitmap and tests a bit per
//     cell. That bit test is a real per-row cost pandas never pays.
//   - `df["x"] = ...` mutates in place. Every pond-ts operation returns a
//     new immutable series with a schema, so the strategy stack builds six
//     series where pandas mutates one frame.
//
// Neither is a flaw in the benchmark — each side is written the way its
// users would write it — but they are why "within 2x" is the honest
// reading rather than "2x slower at the same thing".

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON ?? '/tmp/pondvenv/bin/python';

function runPandas() {
  try {
    const out = execFileSync(
      PYTHON,
      [resolve(HERE, 'oracle/perf-compare.py')],
      { encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env } },
    );
    return JSON.parse(out);
  } catch (error) {
    console.error(
      `Could not run the pandas reference with '${PYTHON}'.\n` +
        'Set PYTHON to an interpreter that has pandas installed:\n' +
        '  python3 -m venv .venv && .venv/bin/pip install pandas\n' +
        '  PYTHON=.venv/bin/python node packages/financial/scripts/perf-vs-oracle.mjs\n',
    );
    throw error;
  }
}

function runTypeScript() {
  const out = execFileSync(
    process.execPath,
    [resolve(HERE, 'perf-agent-queries.mjs')],
    { encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env } },
  );
  return JSON.parse(out);
}

const pandas = runPandas();
const ts = runTypeScript();
const byLabel = new Map(pandas.results.map((r) => [r.label, r]));

const pad = (x, w) => String(x).padStart(w);
console.log('═'.repeat(88));
console.log('pond-ts vs the pandas oracle');
console.log('═'.repeat(88));
console.log(
  `node ${process.version} · pandas ${pandas.pandas} · numpy ${pandas.numpy} · ` +
    `${ts.bars.toLocaleString()} 1-minute bars`,
);
console.log();
console.log(
  `  ${pad('query', 42)} ${pad('pond-ts', 10)} ${pad('pandas', 10)} ${pad('ratio', 8)}`,
);
console.log(`  ${'─'.repeat(74)}`);

let group = '';
const ratios = [];
for (const r of ts.results) {
  const p = byLabel.get(r.label);
  if (p === undefined) continue;
  if (r.group !== group) {
    group = r.group;
    console.log(`  ${group}`);
  }
  const ratio = r.medianMs / p.medianMs;
  ratios.push({ label: r.label, ratio });
  console.log(
    `  ${pad(r.label, 42)} ${pad(r.medianMs.toFixed(2) + 'ms', 10)} ` +
      `${pad(p.medianMs.toFixed(2) + 'ms', 10)} ${pad(ratio.toFixed(2) + '×', 8)}`,
  );
}

console.log();
const sorted = [...ratios].sort((a, b) => a.ratio - b.ratio);
console.log(
  `  best:  ${sorted[0].label} at ${sorted[0].ratio.toFixed(2)}×\n` +
    `  worst: ${sorted[sorted.length - 1].label} at ${sorted[sorted.length - 1].ratio.toFixed(2)}×`,
);
console.log(
  '\n  ratio = pond-ts / pandas. Below 1.00 means pond-ts is faster.\n' +
    '  pandas tracks missing values as inline NaN and mutates frames in place;\n' +
    '  pond-ts tests a validity bit per cell and returns new immutable series.\n' +
    '  Each side is written the way its users would write it.',
);
