// Perf check for the `TimeZone` primitive ([PND-TZCAL]).
//
// Complexity: `startOf` / `next` / `parts` are O(1) after the offset segment
// containing the instant is cached (a hit on the last segment is two
// comparisons; a miss is a binary search over the segments seen so far);
// discovering a new segment costs one Temporal `toZonedDateTimeISO` plus two
// `getTimeZoneTransition` calls, at most once per transition in the queried
// history. The old path (`toPlainDateStart` → Temporal PlainDate arithmetic
// → `startOfDay()`) paid Temporal on every call. The "cold" rows below run a
// fresh zone against instants spread across a year so every DST segment is
// discovered inside the timed region; "warm" repeats the same instants.
//
// Usage: npm run build --workspace=pond-ts && node scripts/perf-timezone.mjs
import { performance } from 'node:perf_hooks';
import { Temporal } from '@js-temporal/polyfill';
import { Sequence, TimeRange, TimeSeries, TimeZone } from '../dist/index.js';

const ZONES = ['UTC', 'America/New_York', 'Australia/Lord_Howe'];
const N = 100_000;
const FROM = Date.UTC(2025, 0, 1);
const SPAN = 365 * 86_400_000;

function instants(n) {
  // Deterministic spread across the year, not sorted, so the last-segment
  // cache is hit at a realistic (not 100%) rate.
  const out = new Array(n);
  let x = 123_456_789;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    out[i] = FROM + Math.floor((x / 2_147_483_648) * SPAN);
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function time(fn, repeats = 5) {
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(2));
}

/** The pre-[PND-TZCAL] calendar step, reproduced: Temporal on every call. */
function temporalStartOfDay(ms, zone) {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(zone)
    .toPlainDate()
    .toZonedDateTime({ timeZone: zone })
    .startOfDay().epochMilliseconds;
}

const ts = instants(N);
const results = [];

for (const zone of ZONES) {
  // Temporal-per-call baseline (fewer instants — it is slow).
  const baseN = 10_000;
  const baselineMs = time(() => {
    let acc = 0;
    for (let i = 0; i < baseN; i += 1) acc += temporalStartOfDay(ts[i], zone);
    if (acc === 0) throw new Error('unreachable');
  }, 3);

  // Cold: a zone object that has never seen these instants. TimeZone interns
  // by id, so the only way to get a cold cache is a fresh module state —
  // approximate it by timing the first pass separately from the rest.
  const tz = TimeZone.of(zone);
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < N; i += 1) acc += tz.startOf('day', ts[i]);
  const firstPassMs = Number((performance.now() - t0).toFixed(2));

  const warmMs = time(() => {
    let a = 0;
    for (let i = 0; i < N; i += 1) a += tz.startOf('day', ts[i]);
    if (a === 0) throw new Error('unreachable');
  });
  const partsMs = time(() => {
    let a = 0;
    for (let i = 0; i < N; i += 1) a += tz.parts(ts[i]).hour;
    if (a < 0) throw new Error('unreachable');
  });
  const nextMonthMs = time(() => {
    let a = 0;
    for (let i = 0; i < N; i += 1) a += tz.next('month', ts[i]);
    if (a === 0) throw new Error('unreachable');
  });

  results.push({
    zone,
    'temporal startOfDay ×10k (old path) ms': baselineMs,
    'TimeZone.startOf(day) ×100k first pass ms': firstPassMs,
    'TimeZone.startOf(day) ×100k warm ms': warmMs,
    'TimeZone.parts ×100k ms': partsMs,
    'TimeZone.next(month) ×100k ms': nextMonthMs,
    'per-call warm ns': Math.round((warmMs / N) * 1e6),
  });
  if (acc === 0) throw new Error('unreachable');
}

// End-to-end: a year of hourly data aggregated to zone-local days — the
// calendar scenario `perf-aggregate.mjs` does not cover.
const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
]);
const hourly = new TimeSeries({
  name: 'hourly',
  schema,
  rows: Array.from({ length: 24 * 365 * 3 }, (_, i) => [
    FROM + i * 3_600_000,
    i % 100,
  ]),
});
const range = new TimeRange({ start: FROM, end: FROM + 3 * SPAN });
const aggregate = {};
for (const zone of ZONES) {
  const seq = Sequence.calendar('day', { timeZone: zone });
  hourly.aggregate(seq, { value: 'avg' }, { range });
  aggregate[`aggregate 3y hourly → calendar day ${zone} ms`] = time(() => {
    const out = hourly.aggregate(seq, { value: 'avg' }, { range });
    if (out.length === 0) throw new Error('empty');
  });
}
const monthly = Sequence.calendar('month', { timeZone: 'America/New_York' });
aggregate['aggregate 3y hourly → calendar month America/New_York ms'] = time(
  () => {
    const out = hourly.aggregate(monthly, { value: 'avg' }, { range });
    if (out.length === 0) throw new Error('empty');
  },
);

console.log(JSON.stringify({ N, results, aggregate }, null, 2));
