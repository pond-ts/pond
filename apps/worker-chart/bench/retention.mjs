// Feeding a LiveSeries at 1M ticks a second (16,000 rows every 16 ms), per
// second of data (guide section 8): the ms spent building each batch's
// TimeSeries (fromColumns) and in pushSeries, with a 5 s maxAge (the guide's
// 1M run), with maxEvents holding the same 5M rows, and with no retention.
// With retention the first five seconds fill the window and the rest drop
// as many rows as they add. maxAge finds the rows to drop by checking them
// one at a time; maxEvents only counts.
//
//   node bench/retention.mjs
import { feed } from './common.mjs';

const cases = [
  ['maxAge 5 s   ', { maxAge: 5_000 }],
  ['maxEvents 5M ', { maxEvents: 5_000_000 }],
  ['no retention ', undefined],
];
for (const [label, retention] of cases) {
  for (let run = 1; run <= 3; run++) {
    const { live, push } = feed(retention ? { retention } : {});
    const build = [];
    const pushed = [];
    let b = 0;
    let p = 0;
    for (let k = 1; k <= 62 * 10; k++) {
      const ms = push(16_000);
      b += ms.build;
      p += ms.push;
      if (k % 62 === 0) {
        build.push(b.toFixed(0).padStart(3));
        pushed.push(p.toFixed(0).padStart(3));
        b = p = 0;
      }
    }
    console.log(
      `${label} run ${run} (${live.length.toLocaleString('en-US')} rows held), ms per second of data:\n` +
        `  fromColumns ${build.join(' ')}\n` +
        `  pushSeries  ${pushed.join(' ')}`,
    );
  }
}
