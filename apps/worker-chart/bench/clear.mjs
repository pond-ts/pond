// Resetting the series on reconnect (guide section 11): live.clear() against
// making a new LiveSeries, at the guide's three window sizes.
//
//   node bench/clear.mjs
import { feed } from './common.mjs';

for (const [rate, seconds] of [
  [10_000, 60],
  [100_000, 30],
  [1_000_000, 5],
]) {
  const { live, push } = feed({ retention: { maxAge: seconds * 1000 } });
  const perPush = Math.round(rate * 0.016);
  for (let k = 0; k < Math.round(seconds / 0.016) + 10; k++) push(perPush);
  const rows = live.length;
  const a = performance.now();
  live.clear();
  const clearMs = performance.now() - a;
  const b = performance.now();
  feed({ retention: { maxAge: seconds * 1000 } });
  const freshMs = performance.now() - b;
  console.log(
    `${rate.toLocaleString('en-US')} ticks/s, ${seconds} s window ` +
      `(${rows.toLocaleString('en-US')} rows): clear() ${clearMs.toFixed(0)} ms, ` +
      `new LiveSeries ${freshMs.toFixed(2)} ms`,
  );
}
