// Hover lookups on a pushSeries-fed LiveSeries (guide section 7).
//
// 1. What one atOrBefore costs, by how many batches the series holds
//    (600,000 rows in each case, lookups spread across the window).
// 2. What lookups do to push cost: 10,000 ticks a second, one push every
//    16 ms, a 60 s window (maxAge), and 0, 1 or 2 lookups mid-window after
//    each push. The first minute fills the window; the second is measured.
//
//   node bench/lookups.mjs
import { feed, median, range } from './common.mjs';

const RUNS = 5;

console.log('1. atOrBefore, 600,000 rows (median of 400 lookups; 5 runs)');
for (const perBatch of [160, 1_600, 15_000, 600_000]) {
  const medians = [];
  for (let run = 0; run < RUNS; run++) {
    const { live, push, now } = feed();
    for (let k = 0; k < 600_000 / perBatch; k++) push(perBatch);
    const span = now();
    const times = [];
    for (let j = 0; j < 400; j++) {
      const q = span * (0.05 + 0.9 * Math.random());
      const a = performance.now();
      if (live.atOrBefore(q) === undefined) throw new Error('no tick');
      times.push(performance.now() - a);
    }
    medians.push(median(times) * 1000);
  }
  console.log(
    `  ${String(600_000 / perBatch).padStart(5)} batch(es) of ${perBatch}: ${range(medians)} µs`,
  );
}

console.log(
  '\n2. push cost with lookups, 10k ticks/s, 60 s window (medians; 5 runs)',
);
for (const lookups of [0, 1, 2]) {
  const pushMs = [];
  const lookUs = [];
  for (let run = 0; run < RUNS; run++) {
    const { live, push, now } = feed({ retention: { maxAge: 60_000 } });
    const pushes = Math.round(120 / 0.016);
    const pt = [];
    const lt = [];
    for (let k = 0; k < pushes; k++) {
      const ms = push(160);
      const measured = k > pushes / 2;
      if (measured) pt.push(ms);
      for (let j = 0; j < lookups; j++) {
        const a = performance.now();
        live.atOrBefore(now() - 30_000 + j);
        if (measured) lt.push(performance.now() - a);
      }
    }
    pushMs.push(median(pt));
    if (lookups) lookUs.push(median(lt) * 1000);
  }
  console.log(
    `  ${lookups} lookup(s) per push: push ${range(pushMs, 3)} ms` +
      (lookups ? `, lookup ${range(lookUs, 0)} µs` : ''),
  );
}
