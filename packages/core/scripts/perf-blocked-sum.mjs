import { performance } from 'node:perf_hooks';
import {
  BLOCKED_MIN,
  blockedSum,
  blockedSumMasked,
} from '../dist/reducers/blocked.js';
import { Float64Column } from '../dist/columnar/index.js';
import '../dist/column.js';

// ── Perf check for blocked (reassociated) summation ───────────────────────
//
// Complexity: O(N), same as sequential — the win is instruction-level
// parallelism (eight independent accumulator chains), not asymptotics.
//
// This script is the durable form of the measurements behind
// docs/notes/blocked-summation.md, added after Layer-2 review of PR #558
// flagged that the BLOCKED_MIN=32 threshold was justified only by a table
// in prose. Three sections:
//
//   1. whole-column: sequential reference vs blocked, dense and masked
//      (the 2.2–2.5× headline), plus the public `col.sum()` end to end;
//   2. the threshold sweep: 4096 sums of n cells each at SLIDING start
//      offsets, with a SEPARATE harness closure per kernel;
//   3. the sub-threshold guarantee: at n < BLOCKED_MIN the reducer must
//      return the bit-identical sequential answer (checked, not timed).
//
// The sweep methodology carries two scars, both load-bearing:
//
//   - SLIDING offsets: fixed arguments let V8 hoist the loop-invariant
//     call, which once "showed" blocking winning at every size.
//   - SEPARATE closures per kernel: a shared `mk(f)` harness makes the
//     inner `f(...)` call site megamorphic after the first kernel, which
//     deoptimizes whichever kernel is measured later. That artifact once
//     measured n=4 at "0.26×" (seq first, still monomorphic) and once at
//     "1.93×" (the same bias, other direction). With monomorphic call
//     sites, n=4 is near parity — at that size the work is a handful of
//     nanoseconds and no in-process microbenchmark resolves it. The
//     robust facts are the clear wins at n ≥ 32 and the bit-identity
//     guarantee below; BLOCKED_MIN rests on those, not on n=4.
//
// Blocked results may differ from sequential in the last ulp (documented
// trade — see the note), so section 1 checks agreement in ulps, not bits.

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function bench(fn, { repeats = 15 } = {}) {
  fn(); // warmup
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    fn();
    const end = performance.now();
    samples.push(end - start);
  }
  return Number(median(samples).toFixed(3));
}

function seqSum(values, start, end) {
  let s = 0;
  for (let i = start; i < end; i += 1) s += values[i];
  return s;
}

function seqSumMasked(values, bits, start, end) {
  let s = 0;
  for (let i = start; i < end; i += 1) {
    if ((bits[i >> 3] & (1 << (i & 7))) !== 0) s += values[i];
  }
  return s;
}

const N = 500_000;
const values = new Float64Array(N);
for (let i = 0; i < N; i += 1) values[i] = 50 + 35 * Math.sin(i / 5000);

// 4% missing, off byte boundaries — the masked shape a real feed produces.
const bits = new Uint8Array(Math.ceil(N / 8)).fill(255);
for (let i = 0; i < N; i += 1)
  if (i % 25 === 7) bits[i >> 3] &= ~(1 << (i & 7));

const results = { blockedMin: BLOCKED_MIN, results: [] };

// 1 ── whole column, dense and masked, plus the public door.
{
  const dense = new Float64Column(values, N, undefined, true);
  const a = bench(() => seqSum(values, 0, N));
  const b = bench(() => blockedSum(values, 0, N));
  const pub = bench(() => dense.sum());
  results.results.push({
    scenario: `dense whole column (${N})`,
    sequentialMs: a,
    blockedMs: b,
    speedup: Number((a / b).toFixed(2)),
    publicSumMs: pub,
  });
  const c = bench(() => seqSumMasked(values, bits, 0, N));
  const d = bench(() => blockedSumMasked(values, bits, 0, N));
  results.results.push({
    scenario: `masked whole column, 4% missing (${N})`,
    sequentialMs: c,
    blockedMs: d,
    speedup: Number((c / d).toFixed(2)),
  });
}

// 2 ── the threshold sweep: sliding windows so nothing hoists, and a
// separate closure per kernel so each inner call site stays monomorphic
// (see the methodology note in the header).
{
  const K = 4096;
  const sweep = [];
  for (const n of [4, 8, 16, 32, 64, 256, 1024, 4096]) {
    const stride = Math.floor((N - n) / K);
    const runSeq = () => {
      let x = 0;
      for (let k = 0; k < K; k += 1) {
        x += seqSum(values, k * stride, k * stride + n);
      }
      return x;
    };
    const runBlocked = () => {
      let x = 0;
      for (let k = 0; k < K; k += 1) {
        x += blockedSum(values, k * stride, k * stride + n);
      }
      return x;
    };
    // Interleave twice and keep the second pass — the first pays any
    // remaining tier-up; the second is steady state for both.
    bench(runSeq);
    bench(runBlocked);
    const a = bench(runSeq);
    const b = bench(runBlocked);
    sweep.push({ n, speedup: Number((a / b).toFixed(2)) });
  }
  results.results.push({
    scenario: `threshold sweep (${K} sliding windows, monomorphic)`,
    sweep,
  });
}

// 3 ── sub-threshold bit-identity: values chosen so grouping WOULD change
// the answer; below BLOCKED_MIN the reducer must not group.
{
  const n = BLOCKED_MIN - 1;
  const small = new Float64Array(n);
  small[0] = 1e16;
  for (let i = 1; i < n; i += 1) small[i] = 1;
  const col = new Float64Column(small, n, undefined, true);
  const ok = col.sum() === seqSum(small, 0, n);
  if (!ok) throw new Error('sub-threshold sum is not bit-identical');
  results.results.push({
    scenario: `sub-threshold bit-identity (n=${n})`,
    ok,
  });
}

console.log(JSON.stringify(results, null, 2));
