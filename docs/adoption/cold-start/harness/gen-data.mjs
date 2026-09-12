// Deterministic synthetic latency dataset: 10 hosts × 20,000 rows at ~10 s
// cadence over ~2.3 days, ISO-Z timestamps, with realistic texture:
// diurnal baseline, per-host offsets, heavy-tailed noise, three injected
// incidents (sustained shifts), 0.5% exact-duplicate rows, one 400-row
// out-of-order chunk, and 200 blank `ms` cells. Seeded PRNG so every arm
// sees byte-identical input.
import { mkdirSync, writeFileSync } from 'node:fs';
let seed = 20260912;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const hosts = Array.from(
  { length: 10 },
  (_, i) => `api-${String(i + 1).padStart(2, '0')}`,
);
const start = Date.parse('2026-09-01T00:00:00Z');
const rows = [];
const incidents = [
  { host: 'api-03', from: 6 * 3600e3, to: 6.75 * 3600e3, add: 180 },
  { host: 'api-07', from: 30 * 3600e3, to: 30.5 * 3600e3, add: 400 },
  { host: 'api-01', from: 48 * 3600e3, to: 49 * 3600e3, add: 90 },
];
for (const [hi, host] of hosts.entries()) {
  let t = start + Math.floor(rnd() * 5000);
  for (let i = 0; i < 20000; i++) {
    t += 8000 + Math.floor(rnd() * 4000); // 8–12 s
    const hour = ((t - start) / 3600e3) % 24;
    const diurnal = 40 + 25 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
    let ms =
      diurnal + hi * 3 + (rnd() < 0.03 ? 150 * rnd() : 0) + (rnd() - 0.5) * 12;
    for (const inc of incidents)
      if (inc.host === host && t - start >= inc.from && t - start < inc.to)
        ms += inc.add;
    ms = Math.max(1, Math.round(ms * 10) / 10);
    rows.push([
      host,
      new Date(t).toISOString(),
      i % 100 === 37 && rnd() < 0.1 ? '' : String(ms),
    ]);
  }
}
// sort by time (interleave hosts), then perturb
rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
// 0.5% duplicates
const dupCount = Math.floor(rows.length * 0.005);
for (let k = 0; k < dupCount; k++) {
  const i = Math.floor(rnd() * rows.length);
  rows.splice(i, 0, [...rows[i]]);
}
// one out-of-order chunk: move 400 rows from the middle to near the end
const mid = Math.floor(rows.length / 2);
const chunk = rows.splice(mid, 400);
rows.splice(rows.length - 1000, 0, ...chunk);
const csv = ['host,ts,ms', ...rows.map((r) => r.join(','))].join('\n') + '\n';
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/latency.csv', import.meta.url), csv);
console.log('rows', rows.length, 'bytes', csv.length);
