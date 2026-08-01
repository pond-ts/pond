// [PND-PROCKERN] — the range-exact rolling kernel.
//
// Three things need measuring, and the first is not a speed number:
//
//   1. Is a ranged fill BIT-IDENTICAL to a full pass? [PND-PROCRANGE] is
//      only an optimisation if it is. Otherwise the value a caller sees
//      depends on which ranges were dirty — on edit history, not data.
//   2. What does the fill cost against recomputing the whole column? That
//      ratio is the ceiling on any incremental-recompute win.
//   3. Is the kernel still O(N), independent of `period`? The aligned
//      rebuild is O(period) every `period` rows, so it should be.
//
// Run: node packages/financial/scripts/perf-ranged-kernel.mjs

import { performance } from 'node:perf_hooks';
import { rollingMeanSdInto } from '../dist/kernels/ranged.js';

const N = Number(process.env.ROWS ?? 500_000);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
function bench(fn, reps = 7, warm = 3) {
  for (let i = 0; i < warm; i += 1) fn();
  const t = [];
  for (let i = 0; i < reps; i += 1) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

let px = 100;
const v = Float64Array.from(
  { length: N },
  () => (px = Math.max(1, px + Math.sin(px * 7919) * 0.4)),
);
const mean = new Float64Array(N),
  sd = new Float64Array(N);
const fullMean = new Float64Array(N),
  fullSd = new Float64Array(N);
rollingMeanSdInto(v, 20, 0, N, fullMean, fullSd);

console.log(`${N.toLocaleString()} rows · node ${process.versions.node}\n`);

console.log('  1. ranged fill vs full pass — exactness and cost');
console.log(`  ${'─'.repeat(64)}`);
const whole = bench(() => rollingMeanSdInto(v, 20, 0, N, mean, sd));
console.log(`    whole column          ${whole.toFixed(2).padStart(8)} ms`);
for (const width of [100, 1_000, 10_000, 100_000]) {
  const lo = 250_003; // deliberately not a multiple of the period
  const hi = Math.min(N, lo + width);
  const t = bench(() => rollingMeanSdInto(v, 20, lo, hi, mean, sd));
  let differing = 0;
  rollingMeanSdInto(v, 20, lo, hi, mean, sd);
  for (let i = lo; i < hi; i += 1) {
    if (!Object.is(mean[i], fullMean[i]) || !Object.is(sd[i], fullSd[i]))
      differing += 1;
  }
  console.log(
    `    ${String(width).padStart(7)} rows        ${t.toFixed(2).padStart(8)} ms   ` +
      `${(whole / t).toFixed(0).padStart(4)}× cheaper than a full pass   ` +
      `${differing === 0 ? '✅ bit-identical' : `❌ ${differing} cells differ`}`,
  );
}

console.log('\n  2. period sweep — the O(N)-independent-of-period claim');
console.log(`  ${'─'.repeat(64)}`);
for (const p of [2, 20, 252, 1024, 10_000]) {
  const t = bench(() => rollingMeanSdInto(v, p, 0, N, mean, sd));
  console.log(
    `    period ${String(p).padStart(6)}         ${t.toFixed(2).padStart(8)} ms   ${((t / N) * 1e6).toFixed(1)} ns/row`,
  );
}

console.log('\n  3. mean-only vs mean+σ — the skip that `sma` depends on');
console.log(`  ${'─'.repeat(64)}`);
const both = bench(() => rollingMeanSdInto(v, 20, 0, N, mean, sd));
const meanOnly = bench(() => rollingMeanSdInto(v, 20, 0, N, mean, undefined));
console.log(`    mean + σ              ${both.toFixed(2).padStart(8)} ms`);
console.log(
  `    mean only             ${meanOnly.toFixed(2).padStart(8)} ms   ${(both / meanOnly).toFixed(2)}× cheaper\n` +
    `      Skipping only the WRITE left \`sma\` 1.6× slower than the sweep this\n` +
    `      replaced. The Welford triple is the expensive half and is skipped\n` +
    `      outright.`,
);
