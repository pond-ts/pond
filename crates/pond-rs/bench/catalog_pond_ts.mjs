// @pond-ts/financial side of examples/perf_catalog.rs: every catalog study
// at its defaults (the catalog's examples where an option has none) on the
// same 1M bars, timed (median of 7) and hashed (every bit of every number
// column, a gap as one fixed value), one JSON line per study.
//
//     npm run build --workspace=pond-ts
//     npm run build --workspace=@pond-ts/financial
//     node crates/pond-rs/bench/catalog_pond_ts.mjs [study name prefix]
import { TimeSeries } from '../../../packages/core/dist/index.js';
import { TradingCalendar } from '../../../packages/financial/dist/index.js';
import { STUDIES } from '../../../packages/financial/dist/catalog/index.js';

const ROWS = 1_000_000;
const price = (i) => 100 + ((i * 7919) % 10_007) / 800;
const spread = (i) => ((i * 31) % 97) / 100 + 0.1;
const bars = new TimeSeries({
  name: 'bars',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'open', kind: 'number' },
    { name: 'high', kind: 'number' },
    { name: 'low', kind: 'number' },
    { name: 'close', kind: 'number' },
    { name: 'volume', kind: 'number' },
    { name: 'bench', kind: 'number' },
  ],
  rows: Array.from({ length: ROWS }, (_, i) => [
    i * 60_000,
    price(i + 1),
    price(i) + spread(i),
    price(i) - spread(i),
    price(i),
    1000 + ((i * 7919) % 997),
    50 + ((i * 104_729) % 10_009) / 400,
  ]),
});
const calendar = TradingCalendar.fromRules(
  { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
  { from: '1969-12-31', to: '1971-12-31' },
);

/** Defaults, plus the catalog's example for each option that has none. */
export function benchOptions(d) {
  const o = {};
  for (const input of d.inputs)
    if (input.default === undefined) o[input.role] = 'bench';
  for (const [name, p] of Object.entries(d.params)) {
    if (p.default === undefined && !p.optional) o[name] = p.example;
  }
  if (d.anchor === 'session') o.sessions = calendar;
  if (d.anchor === 'time') o.anchor = 500_000 * 60_000;
  return o;
}

function hash(result) {
  const f64 = new Float64Array(1);
  const u64 = new BigUint64Array(f64.buffer);
  const mask = (1n << 64n) - 1n;
  const GAP = 0x7ff8dead00000000n;
  let h = 0xcbf29ce484222325n;
  for (const def of result.schema) {
    if (def.kind !== 'number') continue;
    const col = result.column(def.name);
    for (let i = 0; i < result.length; i += 1) {
      const v = col.at(i);
      if (v === undefined) h ^= GAP;
      else {
        f64[0] = v;
        h ^= u64[0];
      }
      h = (h * 0x100000001b3n) & mask;
    }
  }
  return h.toString(16);
}

const only = process.argv[2];
for (const d of STUDIES) {
  if (only && !d.name.startsWith(only)) continue;
  const options = benchOptions(d);
  let result = d.run(bars, options);
  const times = [];
  for (let k = 0; k < 7; k += 1) {
    const t = performance.now();
    result = d.run(bars, options);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({ study: d.name, ms: times[3], hash: hash(result) }),
  );
}
