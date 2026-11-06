import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

// Perf check for `cumulative` `increase` / `decrease` ([PND-SCANDATA]).
// One pass over the column, O(N), no allocation per row: the fold keeps a
// reference value and one running total, and writes a typed output column.
// Compared against the same rule as a `scan` step (a callback per row,
// which is what it replaces) and as a plain loop over the array (fit's
// `elevationGainLoss`, the floor).
//
// Covers: a 1 h and a 10 h ride at 1 Hz, a 1M-row column, gaps in the
// values, and no threshold (every rise counts).

function makeSeries(length, { gaps = false } = {}) {
  const time = new Float64Array(length);
  const ele = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    time[i] = i * 1000;
    ele[i] =
      gaps && i % 17 === 0 ? NaN : 500 + 40 * Math.sin(i / 300) + (i % 7) * 0.3;
  }
  const series = TimeSeries.fromColumns({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'ele', kind: 'number', required: false },
    ],
    columns: { time, ele },
  });
  return { series, ele };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, fn, repeats = 15) {
  fn(); // warm-up
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

const THRESHOLD = 3;
const spec = { ele: { using: 'increase', threshold: THRESHOLD } };

// The same rule as a `scan` step: carry { ref, gain }.
const step = (acc, e) => {
  if (acc.ref === null) return [{ ref: e, gain: 0 }, 0];
  const d = e - acc.ref;
  if (d >= THRESHOLD) return [{ ref: e, gain: acc.gain + d }, acc.gain + d];
  if (d <= -THRESHOLD) return [{ ref: e, gain: acc.gain }, acc.gain];
  return [acc, acc.gain];
};

// The plain loop, writing a column like the operator does.
function loop(ele) {
  const out = new Float64Array(ele.length);
  let ref = NaN;
  let gain = 0;
  for (let i = 0; i < ele.length; i++) {
    const e = ele[i];
    if (e === e) {
      if (ref !== ref) ref = e;
      else {
        const d = e - ref;
        if (d >= THRESHOLD) {
          gain += d;
          ref = e;
        } else if (d <= -THRESHOLD) ref = e;
      }
    }
    out[i] = ref === ref ? gain : NaN;
  }
  return out;
}

const results = [];
for (const [label, n, opts] of [
  ['3.6k (1 h)', 3_600, {}],
  ['36k (10 h)', 36_000, {}],
  ['1M', 1_000_000, {}],
  ['36k, gaps', 36_000, { gaps: true }],
]) {
  const { series, ele } = makeSeries(n, opts);
  results.push(
    benchmark(`${label} · loop`, () => loop(ele)),
    benchmark(`${label} · cumulative increase, threshold 3`, () =>
      series.cumulative(spec),
    ),
    benchmark(`${label} · scan step`, () =>
      series.scan('ele', step, { ref: null, gain: 0 }),
    ),
  );
}
{
  const { series } = makeSeries(36_000);
  results.push(
    benchmark('36k · cumulative increase, no threshold', () =>
      series.cumulative({ ele: 'increase' }),
    ),
    benchmark('36k · cumulative sum (for scale)', () =>
      series.cumulative({ ele: 'sum' }),
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
