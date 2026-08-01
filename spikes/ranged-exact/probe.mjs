// [PND-PROCKERN] — can a ranged recompute be BIT-IDENTICAL to a full pass?
//
// It has to be, or [PND-PROCRANGE] is not an optimisation. An accumulator
// sweep carries rounding history from row 0, so restarting it mid-series
// lands a few ulps off on every cell — and the cell you get then depends on
// which ranges happened to be dirty, i.e. on the user's edit history. Two
// people with identical final data would see different numbers.
//
// The fix is the one [PND-SHIFTFRAME] arrived at from the other direction:
// rebuild the accumulator from the window periodically, and — the new part —
// pin the rebuild rows to ABSOLUTE index (`i % period === 0`) rather than to
// "every N rows since I started". Then a ranged sweep that reads back far
// enough to cover the last aligned rebuild reconstructs exactly the state the
// full sweep had, and every row after it evolves identically.
//
// Read-back is at most 2·period − 1 rows. Rebuild costs O(period) every
// `period` rows: one extra accumulation per row, at any period.

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** Today's kernel: accumulate from the chunk's own warm-up row. */
function drifting(v, period, start, end, mean, sd) {
  const warm = Math.max(0, start - period + 1);
  sweep(v, period, warm, start, end, mean, sd, false);
}

/** Aligned: rebuild state at every multiple of `period`, absolute. */
function aligned(v, period, start, end, mean, sd) {
  // The last aligned rebuild at or before `start`, and the window it needs.
  const anchor = Math.floor(start / period) * period;
  const from = Math.max(0, anchor - period + 1);
  sweep(v, period, from, start, end, mean, sd, true);
}

/**
 * Aligned AND shifted: the realign alone makes large-magnitude σ worse,
 * because rebuilding more often just re-does the same ill-conditioned
 * arithmetic. The accumulators have to see `x - anchor`, the same fix
 * [PND-SHIFTFRAME] made for `zScore` — and the rebuild row is the natural
 * place to take the anchor, so the two changes compose into one.
 */
function shifted(v, period, start, end, mean, sd) {
  const anchor0 = Math.floor(start / period) * period;
  const from = Math.max(0, anchor0 - period + 1);
  let ws = from, we = from;
  let anchor = 0, sum = 0, cnt = 0, wN = 0, wMean = 0, wM2 = 0;
  for (let i = from; i < end; i += 1) {
    const lo = Math.max(from, i - period + 1);
    while (we <= i) {
      const x = v[we];
      if (Number.isFinite(x)) {
        const y = x - anchor;
        sum += y; cnt += 1;
        wN += 1; const d = y - wMean; wMean += d / wN; wM2 += d * (y - wMean);
      }
      we += 1;
    }
    while (ws < lo) {
      const x = v[ws];
      if (Number.isFinite(x)) {
        const y = x - anchor;
        sum -= y; cnt -= 1;
        if (wN <= 1) { wN = 0; wMean = 0; wM2 = 0; }
        else {
          const mw = wMean; wN -= 1;
          if (wN === 1) { wMean = mw * 2 - y; wM2 = 0; }
          else { wMean = mw - (y - mw) / wN; wM2 -= (y - wMean) * (y - mw); if (wM2 < 0) wM2 = 0; }
        }
      }
      ws += 1;
    }
    if (i % period === 0) {
      // Anchor on a row of the window, chosen by absolute index so a ranged
      // sweep picks the same one the full sweep did.
      anchor = Number.isFinite(v[i]) ? v[i] : 0;
      sum = 0; cnt = 0; wN = 0; wMean = 0; wM2 = 0;
      for (let k = ws; k < we; k += 1) {
        const x = v[k];
        if (!Number.isFinite(x)) continue;
        const y = x - anchor;
        sum += y; cnt += 1;
        wN += 1; const d = y - wMean; wMean += d / wN; wM2 += d * (y - wMean);
      }
    }
    if (i < start) continue;
    if (we - ws < period || cnt === 0 || wN === 0) { mean[i] = NaN; sd[i] = NaN; continue; }
    mean[i] = anchor + sum / cnt;
    sd[i] = Math.sqrt(wM2 / wN > 0 ? wM2 / wN : 0);
  }
}

function sweep(v, period, from, start, end, mean, sd, realign) {
  let ws = from, we = from;
  let sum = 0, cnt = 0, wN = 0, wMean = 0, wM2 = 0;
  for (let i = from; i < end; i += 1) {
    const lo = Math.max(from, i - period + 1);
    while (we <= i) {
      const x = v[we];
      if (Number.isFinite(x)) {
        sum += x; cnt += 1;
        wN += 1; const d = x - wMean; wMean += d / wN; wM2 += d * (x - wMean);
      }
      we += 1;
    }
    while (ws < lo) {
      const x = v[ws];
      if (Number.isFinite(x)) {
        sum -= x; cnt -= 1;
        if (wN <= 1) { wN = 0; wMean = 0; wM2 = 0; }
        else {
          const mw = wMean; wN -= 1;
          if (wN === 1) { wMean = mw * 2 - x; wM2 = 0; }
          else { wMean = mw - (x - mw) / wN; wM2 -= (x - wMean) * (x - mw); if (wM2 < 0) wM2 = 0; }
        }
      }
      ws += 1;
    }
    // The realign: absolute-indexed, so a ranged sweep hits the same rows.
    if (realign && i % period === 0) {
      sum = 0; cnt = 0; wN = 0; wMean = 0; wM2 = 0;
      for (let k = ws; k < we; k += 1) {
        const x = v[k];
        if (!Number.isFinite(x)) continue;
        sum += x; cnt += 1;
        wN += 1; const d = x - wMean; wMean += d / wN; wM2 += d * (x - wMean);
      }
    }
    if (i < start) continue;
    if (we - ws < period || cnt === 0 || wN === 0) { mean[i] = NaN; sd[i] = NaN; continue; }
    mean[i] = sum / cnt;
    sd[i] = Math.sqrt(wM2 / wN > 0 ? wM2 / wN : 0);
  }
}

/** Exact rolling mean/sd for one row, summed over within-window differences. */
function exact(v, i, p) {
  let s = 0, c = 0;
  for (let k = i - p + 1; k <= i; k += 1) { const y = (v[k] - v[i]) - c, t = s + y; c = (t - s) - y; s = t; }
  const m = s / p;
  let q = 0;
  for (let k = i - p + 1; k <= i; k += 1) { const d = (v[k] - v[i]) - m; q += d * d; }
  return { mean: v[i] + m, sd: Math.sqrt(q / p) };
}

const N = 200_000, P = 20;
const series = {
  'random walk ≈100': () => { let px = 100; return Float64Array.from({ length: N }, () => px = Math.max(1, px + Math.sin(px * 7919) * 0.4)); },
  '1e9 + sin': () => Float64Array.from({ length: N }, (_, i) => 1e9 + Math.sin(i / 13) * 5),
  '1e15 + ((i%7)−3)': () => Float64Array.from({ length: N }, (_, i) => 1e15 + ((i % 7) - 3)),
};

console.log(`${N.toLocaleString()} rows · period ${P}\n`);
console.log('1. IS A RANGED RECOMPUTE BIT-IDENTICAL TO A FULL PASS?');
console.log(`   ${'─'.repeat(64)}`);
console.log(`   ${'input'.padEnd(22)} ${'today'.padStart(16)} ${'aligned'.padStart(16)} ${'+shifted'.padStart(12)}`);
for (const [name, gen] of Object.entries(series)) {
  const v = gen();
  const row = [];
  for (const impl of [drifting, aligned, shifted]) {
    const fm = new Float64Array(N), fs = new Float64Array(N);
    impl(v, P, 0, N, fm, fs);
    let differing = 0, total = 0;
    for (const [lo, hi] of [[10_000, 10_500], [25_000, 26_000], [137_003, 140_000]]) {
      const m = new Float64Array(N), s = new Float64Array(N);
      impl(v, P, lo, hi, m, s);
      for (let i = lo; i < hi; i += 1) {
        total += 2;
        if (!Object.is(m[i], fm[i])) differing += 1;
        if (!Object.is(s[i], fs[i])) differing += 1;
      }
    }
    row.push(differing === 0 ? 'identical' : `${differing}/${total} differ`);
  }
  console.log(`   ${name.padEnd(22)} ${row[0].padStart(16)} ${row[1].padStart(16)} ${row[2].padStart(12)}`);
}

console.log('\n2. WHAT DOES THE REALIGN COST IN ACCURACY? (worst rel. vs exact)');
console.log(`   ${'─'.repeat(64)}`);
console.log(`   ${'input'.padEnd(22)} ${'today'.padStart(16)} ${'aligned'.padStart(16)} ${'+shifted'.padStart(12)}`);
for (const [name, gen] of Object.entries(series)) {
  const v = gen();
  const row = [];
  for (const impl of [drifting, aligned, shifted]) {
    const m = new Float64Array(N), s = new Float64Array(N);
    impl(v, P, 0, N, m, s);
    let worst = 0;
    for (let i = P - 1; i < N; i += 1) {
      const e = exact(v, i, P);
      if (e.sd === 0) continue;
      worst = Math.max(worst, Math.abs(s[i] - e.sd) / e.sd);
    }
    row.push(worst.toExponential(1));
  }
  console.log(`   ${name.padEnd(22)} ${row[0].padStart(16)} ${row[1].padStart(16)} ${row[2].padStart(12)}`);
}

console.log('\n3. WHAT DOES IT COST IN TIME? (full pass, ms)');
console.log(`   ${'─'.repeat(64)}`);
const v = series['random walk ≈100']();
for (const [label, impl] of [['today', drifting], ['aligned', aligned], ['aligned + shifted', shifted]]) {
  const m = new Float64Array(N), s = new Float64Array(N);
  for (let k = 0; k < 3; k += 1) impl(v, P, 0, N, m, s);
  const t = [];
  for (let k = 0; k < 7; k += 1) { const a = performance.now(); impl(v, P, 0, N, m, s); t.push(performance.now() - a); }
  console.log(`   ${label.padEnd(22)} ${median(t).toFixed(1).padStart(16)} ms`);
}
