// pushSeries at 1M ticks a second (16,000 rows every 16 ms), per second of
// data (guide section 8): with a 5 s maxAge (the guide's 1M run), with
// maxEvents holding the same 5M rows, and with no retention. With retention
// the first five seconds fill the window and the rest drop as many rows as
// they add. maxAge finds the rows to drop by checking them one at a time;
// maxEvents only counts.
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
    const perSecond = [];
    let acc = 0;
    for (let k = 1; k <= 62 * 10; k++) {
      acc += push(16_000);
      if (k % 62 === 0) {
        perSecond.push(acc.toFixed(0));
        acc = 0;
      }
    }
    console.log(
      `${label} run ${run}, ms per second of data: ` +
        `${perSecond.join(' ')} (${live.length.toLocaleString('en-US')} rows held)`,
    );
  }
}
