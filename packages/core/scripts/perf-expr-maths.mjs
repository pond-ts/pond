import { performance } from 'node:perf_hooks';
import { TimeSeries, col, lit, when } from '../dist/index.js';

// Perf check for maths in expressions (`sqrt`, `sin`, `cos`, `asin`,
// `atan2`, `pow`). Each op is one pass over its input columns, O(N), and
// writes one typed column; it reuses a temporary column it made itself, so
// a chain of k ops costs O(k·N) with about one new array per op. Compared
// against the same formula as a plain loop over the arrays (the floor).
//
// Covers: haversine distance between rows (the GPS track case, 12 maths
// ops) at 1 h, 10 h and 1M rows; the same with gaps; and one `sqrt` alone
// (the per-op floor).

const DEG = Math.PI / 180;
const R = 6_371_008.8;

function makeSeries(length, { gaps = false } = {}) {
  const time = new Float64Array(length);
  const lat = new Float64Array(length);
  const lng = new Float64Array(length);
  const lat0 = new Float64Array(length);
  const lng0 = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    time[i] = i * 1000;
    lat[i] = gaps && i % 17 === 0 ? NaN : 37.8 + Math.sin(i / 200) * 0.01;
    lng[i] = -122.4 + i * 0.00001;
  }
  lat0[0] = NaN;
  lng0[0] = NaN;
  for (let i = 1; i < length; i++) {
    lat0[i] = lat[i - 1];
    lng0[i] = lng[i - 1];
  }
  const series = TimeSeries.fromColumns({
    name: 'track',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'lat', kind: 'number', required: false },
      { name: 'lng', kind: 'number', required: false },
      { name: 'lat0', kind: 'number', required: false },
      { name: 'lng0', kind: 'number', required: false },
    ],
    columns: { time, lat, lng, lat0, lng0 },
  });
  return { series, lat, lng, lat0, lng0 };
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

// Haversine as an expression, the way fit writes it.
const dLat = col('lat').sub(col('lat0')).mul(DEG);
const dLng = col('lng').sub(col('lng0')).mul(DEG);
const a = dLat
  .div(2)
  .sin()
  .pow(2)
  .add(
    col('lat0')
      .mul(DEG)
      .cos()
      .mul(col('lat').mul(DEG).cos())
      .mul(dLng.div(2).sin().pow(2)),
  );
const root = a.sqrt();
const haversine = lit(2 * R).mul(when(root.gt(1), 1, root).asin());

function loop({ lat, lng, lat0, lng0 }) {
  const n = lat.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const la1 = lat0[i];
    const la2 = lat[i];
    const dLa = (la2 - la1) * DEG;
    const dLo = (lng[i] - lng0[i]) * DEG;
    const h =
      Math.sin(dLa / 2) ** 2 +
      Math.cos(la1 * DEG) * Math.cos(la2 * DEG) * Math.sin(dLo / 2) ** 2;
    out[i] = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return out;
}

const results = [];
for (const [label, length, gaps] of [
  ['1 h at 1 Hz', 3_600, false],
  ['10 h at 1 Hz', 36_000, false],
  ['10 h, every 17th lat a gap', 36_000, true],
  ['1M rows', 1_000_000, false],
]) {
  const data = makeSeries(length, { gaps });
  const got = data.series.withColumn('d', haversine).column('d');
  const want = loop(data);
  let same = 0;
  for (let i = 0; i < length; i++) {
    const g = got.toFloat64Array()[i];
    if (Object.is(g, want[i]) || (g !== g && want[i] !== want[i])) same += 1;
  }
  results.push({
    scenario: label,
    rows: length,
    sameBits: `${same}/${length}`,
    loop: benchmark('loop', () => loop(data)),
    haversine: benchmark('withColumn haversine', () =>
      data.series.withColumn('d', haversine),
    ),
    sqrt: benchmark('withColumn sqrt', () =>
      data.series.withColumn('r', col('lat').sqrt()),
    ),
  });
}

console.log(JSON.stringify(results, null, 2));
