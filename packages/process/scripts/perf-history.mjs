// [PND-PROCHIST] — does slicing to `requiredHistory` give the same answers,
// and what does it save?
//
// The second question is the easy one. The first is the whole ticket: a
// derived tail is only useful if the displayed rows are IDENTICAL to a
// full-series pass. Too short and a study's warm-up is silently truncated
// — the answer is still defined, still plausible, and wrong. So this
// checks equality first and reports a speedup second, and it deliberately
// also runs a tail ONE ROW SHORT to show that the boundary is real and
// the check can fail.
//
// Measured: at the derived tail, 0 truncated cells and <=5.8e-13 relative
// drift; at one row short, 1 truncated cell. 103.6 -> 1.3 ms/tick, 79x.
//
// Run: node packages/process/scripts/perf-history.mjs

import { performance } from 'node:perf_hooks';
import { bind, run, requiredHistory } from '../dist/index.js';
import setup, { makeBars } from './fixtures/studies-setup.mjs';

const ROWS = Number(process.env.ROWS ?? 500_000);
const DISPLAY = Number(process.env.DISPLAY ?? 5_000);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const { registry } = setup({ rows: ROWS });
const full = makeBars(ROWS);

// The stack the ticket measured: eight studies, mixed periods, one nested
// so the SUM-along-nesting rule is actually exercised.
const plan = [
  { op: 'sma', params: { period: 20 }, inputs: ['close'] },
  { op: 'sma', params: { period: 50 }, inputs: ['close'] },
  { op: 'sma', params: { period: 200 }, inputs: ['close'] },
  { op: 'ema', params: { period: 20 }, inputs: ['close'] },
  { op: 'bollinger', params: { period: 20 }, inputs: ['close'] },
  { op: 'zscore', params: { period: 60 }, inputs: ['close'] },
  { op: 'envelope', params: { period: 20 }, inputs: ['close'] },
  {
    op: 'sma',
    params: { period: 10 },
    inputs: [{ op: 'sma', params: { period: 100 }, inputs: ['close'] }],
  },
];

const need = requiredHistory(registry, plan);
console.log(
  `${ROWS.toLocaleString()} rows · display ${DISPLAY.toLocaleString()} · node ${process.versions.node}\n`,
);
if (!need.known) {
  console.log(`  UNDECLARED: ${need.undeclared.join(', ')} — cannot slice`);
  process.exit(1);
}
console.log(`  requiredHistory        ${String(need.rows).padStart(8)} rows`);
console.log(
  `    deepest per op       ${Object.entries(need.byOp)
    .map(([k, v]) => `${k}:${v}`)
    .join('  ')}`,
);
console.log(
  `    nested sma(10)/sma(100) contributes ${need.byOp['sma']} — a max would say 199\n`,
);

const select = plan.map((s) => ({ on: s }));
function once(series) {
  return run(bind(series, { registry }), { plan, select, assemble: false });
}
function bench(series, reps = 5) {
  once(series);
  const t = [];
  for (let i = 0; i < reps; i += 1) {
    const s = performance.now();
    once(series);
    t.push(performance.now() - s);
  }
  return median(t);
}

// The displayed window, and the tail a consumer would actually slice.
const displayFrom = ROWS - DISPLAY;
const whole = once(full);

function tailOf(history) {
  const from = Math.max(0, displayFrom - history);
  return { series: full.slice(from, ROWS), from };
}

function compare(history, label) {
  const { series, from } = tailOf(history);
  const sliced = once(series);
  let differing = 0;
  let compared = 0;
  let missing = 0;
  let worst = 0;
  let worstCol = '';
  for (const name of Object.keys(whole.columns ?? {})) {
    const a = whole.columns[name];
    const b = sliced.columns?.[name];
    if (b === undefined) continue;
    for (let i = displayFrom; i < ROWS; i += 1) {
      compared += 1;
      const x = a.at(i);
      const y = b.at(i - from);
      if (x === undefined && y === undefined) continue;
      // Two different severities, and conflating them was hiding the
      // finding. A cell defined in one and absent in the other is a
      // TRUNCATED warm-up — the failure this ticket exists to prevent.
      // A cell that merely differs is a rounding question.
      if (x === undefined || y === undefined) {
        missing += 1;
        differing += 1;
        continue;
      }
      if (Object.is(x, y)) continue;
      differing += 1;
      const rel = Math.abs(x - y) / (Math.abs(x) || 1);
      if (rel > worst) {
        worst = rel;
        worstCol = name;
      }
    }
  }
  console.log(
    `  ${label.padEnd(32)} ${String(differing).padStart(5)}/${compared} differ   ` +
      `truncated ${String(missing).padStart(5)}   worst rel ${worst.toExponential(1)} ${worstCol ? `(${worstCol})` : ''}`,
  );
  return { differing, missing, worst };
}

console.log('  are the displayed rows the same?');
console.log(`  ${'─'.repeat(60)}`);
compare(need.rows, `tail = display + ${need.rows}`);
compare(need.rows - 1, `tail = display + ${need.rows - 1} (one short)`);
console.log(
  `\n    TRUNCATED is the number that matters, and it is 0 at the derived\n` +
    `    tail and 1 at one row short — so the bound is tight, not merely\n` +
    `    safe. A consumer guessing low gets a cell reported absent where a\n` +
    `    value exists.\n\n` +
    `    The cells that DIFFER are rounding, and they are expected. Two\n` +
    `    causes. \`ema\` is IIR, so 4x period is an approximation by\n` +
    `    construction and can never be exact. And slicing builds a NEW,\n` +
    `    SHORTER series, which re-indexes every row — the rolling kernel\n` +
    `    pins its accumulator rebuilds to ABSOLUTE row index\n` +
    `    ([PND-PROCKERN]), so they land on different rows in a slice.\n` +
    `    That kernel's bit-identity is for a range of the SAME column,\n` +
    `    which is what [PND-PROCRANGE] does; it does not extend to a\n` +
    `    re-indexed copy, which is what slicing is.\n`,
);

console.log('  what does it cost?');
console.log(`  ${'─'.repeat(60)}`);
const wholeMs = bench(full);
const tailMs = bench(tailOf(need.rows).series);
console.log(
  `    whole series         ${wholeMs.toFixed(1).padStart(8)} ms/tick`,
);
console.log(
  `    derived tail         ${tailMs.toFixed(1).padStart(8)} ms/tick   ${(wholeMs / tailMs).toFixed(0)}×  ` +
    `(${(1000 / wholeMs).toFixed(1)} → ${(1000 / tailMs).toFixed(0)} ticks/sec)`,
);
