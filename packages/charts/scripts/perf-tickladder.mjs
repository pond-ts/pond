// Perf check for the tick ladder's calendar seam ([PND-TZAXIS]).
//
// The ladder runs per pan/zoom frame: `buildTicks` walks every session open
// in the domain (one per calendar day on a continuous axis) and asks the
// calendar for each one's day / month / year; `flatFormat` then formats each
// tick. Before the seam every calendar question was a `Date` local-accessor
// call; now it goes through a `TickCalendar` — `localTickCalendar` (the same
// `Date` calls, the default) or `zonedTickCalendar(TimeZone)` (core's
// transition-cached zone arithmetic). This measures both against the
// pre-seam cost, which the local path IS, so "local" doubles as the baseline.
//
// Complexity is unchanged: O(opens) per `buildTicks`, O(ticks) per format.
// The question is the constant — whether a zoned frame is distinguishable
// from a local one once the zone's transition cache is warm, and what the
// first (cold) frame costs.
//
// Run: node scripts/perf-tickladder.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import {
  identityProvider,
  scaleTradingTime,
} from '../dist/tradingTimeScale.js';

const DAY = 86_400_000;
const WIDTH = 1200;
const COUNT = 12;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Median ms of `fn` over `repeats`, each on a FRESH scale (no memo hits). */
function time(makeScale, repeats = 7) {
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    const s = makeScale();
    const t0 = performance.now();
    const ticks = s.ticks(COUNT);
    const flat = s.flatFormat(COUNT);
    let acc = 0;
    for (const t of ticks) acc += flat(t).length;
    s.gridLevels(4);
    s.bands(COUNT);
    if (acc === 0) throw new Error('unreachable');
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(3));
}

const start = Date.UTC(2020, 0, 1);
const results = [];
for (const days of [30, 365, 3650]) {
  const domain = [start, start + days * DAY];
  const row = { domainDays: days };
  const make = (timeZone) => () =>
    scaleTradingTime(identityProvider({ timeZone }), { timeZone })
      .domain(domain)
      .range([0, WIDTH]);
  row['local (pre-seam path) ms'] = time(make(undefined));
  // Cold: the zone's transition cache has not seen this domain. TimeZone
  // interns by id, so use a zone nothing else in this process touched.
  const cold = make('America/Denver');
  const s = cold();
  const t0 = performance.now();
  s.ticks(COUNT);
  s.flatFormat(COUNT);
  s.gridLevels(4);
  s.bands(COUNT);
  row['zoned cold first frame ms'] = Number(
    (performance.now() - t0).toFixed(3),
  );
  row['zoned warm (America/Denver) ms'] = time(cold);
  row['zoned warm (UTC) ms'] = time(make('UTC'));
  row['zoned warm (Australia/Lord_Howe) ms'] = time(
    make('Australia/Lord_Howe'),
  );
  results.push(row);
}
console.log(JSON.stringify(results, null, 2));
