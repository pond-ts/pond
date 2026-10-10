// Perf check — TimeSeries.offsetTime (constant key shift).
//
// Complexity: O(N) — one Float64Array for a time key (two for a ranged key);
// value columns pass through by reference, so cost is independent of column
// count C. The comparison row rebuilds the same shifted series through the
// row API (toRows → new TimeSeries), the route a consumer had before this
// method: O(N · C) plus per-row allocation.
//
//   npm run build --workspace=pond-ts
//   node scripts/perf-offset-time.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(fn, repeats = 7) {
  for (let i = 0; i < 2; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(3));
}

function makeSeries(n, cols, kind = 'time') {
  const schema = [{ name: kind, kind }];
  for (let c = 0; c < cols; c += 1) {
    schema.push({ name: `c${c}`, kind: 'number', required: false });
  }
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i * 60_000;
    const row = [kind === 'time' ? t : [t, t + 60_000]];
    for (let c = 0; c < cols; c += 1) {
      row.push((i + c) % 89 === 0 ? undefined : i + c);
    }
    rows[i] = row;
  }
  return new TimeSeries({ name: 's', schema, rows });
}

const scenarios = [
  { label: '100k rows × 3 cols (time)', n: 100_000, cols: 3 },
  { label: '1M rows × 3 cols (time)', n: 1_000_000, cols: 3 },
  { label: '97k rows × 118 cols (time)', n: 96_779, cols: 118 },
  {
    label: '100k rows × 3 cols (timeRange)',
    n: 100_000,
    cols: 3,
    kind: 'timeRange',
  },
];

const out = [];
for (const s of scenarios) {
  const series = makeSeries(s.n, s.cols, s.kind);
  const offsetMs = bench(() => series.offsetTime('1m').keyColumn().begin[0]);
  let rebuildMs = null;
  if (s.n <= 100_000) {
    rebuildMs = bench(() => {
      const rows = series.toRows().map((r) => {
        const k = r[0];
        const moved =
          s.kind === 'timeRange'
            ? [k.begin() + 60_000, k.end() + 60_000]
            : k.timestampMs() + 60_000;
        return [moved, ...r.slice(1)];
      });
      return new TimeSeries({ name: 's', schema: series.schema, rows });
    }, 3);
  }
  out.push({
    scenario: s.label,
    offsetTimeMs: offsetMs,
    rowRebuildMs: rebuildMs,
  });
}
console.log(JSON.stringify(out, null, 2));
