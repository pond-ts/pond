#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/energy-samples.ts` — the Gallery's Energy
 * track (grid mix, renewables-vs-demand, negative prices).
 *
 * Run by hand, never by the build (see `src/examples/lib/README.md`):
 *
 *     node website/scripts/fixtures/energy.mjs > website/src/examples/lib/energy-samples.ts
 *
 * Two public endpoints of **energy-charts.info** (Fraunhofer ISE):
 *
 *   - `/public_power`  — 15-minute generation by production type, plus load,
 *                        for the DE bidding zone. Source: ENTSO-E / SMARD.
 *                        Returns **no** `license_info` field; Energy-Charts
 *                        publishes under CC BY 4.0 site-wide.
 *   - `/price`         — hourly DE-LU day-ahead auction price (EUR/MWh).
 *                        Self-reports `license_info` (CC BY 4.0,
 *                        Bundesnetzagentur | SMARD.de), echoed into the header.
 *
 * The window is Easter weekend 2025 (Sat 19 – Mon 21 April, all three days
 * public-holiday-quiet in Germany): Easter Sunday was the lowest-average-demand
 * day of the whole year, which is when wind+solar overtake total load and the
 * day-ahead price goes negative. One weekend answers all three cards.
 *
 * Fifteen production types are folded into **eight bands** so the stack sums to
 * total domestic generation rather than to an arbitrary top-N (see BANDS).
 */

const START = '2025-04-19';
const END = '2025-04-21';
const POWER_URL = `https://api.energy-charts.info/public_power?country=de&start=${START}&end=${END}`;
const PRICE_URL = `https://api.energy-charts.info/price?bzn=DE-LU&start=${START}&end=${END}`;

/**
 * Eight bands, bottom-of-stack first, each summing one or more of the API's
 * production types. Every generation type appears exactly once, so the eight
 * bands add up to total generation — no silent remainder.
 *
 * `other` is the residual: waste, pumped-storage discharge, coal-derived gas
 * (Kuppelgas), oil, geothermal and the API's own `Others`. Pumped storage is
 * discharge only; its pumping load is a separate (negative) series and is not
 * generation, so it is left out.
 */
// prettier-ignore
const BANDS = [
  ['other', 'Other', ['Waste', 'Hydro pumped storage', 'Fossil coal-derived gas', 'Fossil oil', 'Geothermal', 'Others']],
  ['lignite', 'Lignite', ['Fossil brown coal / lignite']],
  ['hardCoal', 'Hard coal', ['Fossil hard coal']],
  ['gas', 'Gas', ['Fossil gas']],
  ['biomass', 'Biomass', ['Biomass']],
  ['hydro', 'Hydro', ['Hydro Run-of-River', 'Hydro water reservoir']],
  ['wind', 'Wind', ['Wind onshore', 'Wind offshore']],
  ['solar', 'Solar', ['Solar']],
];

const GW = (mw) => Math.round(mw / 10) / 100; // MW → GW, 2 dp (10 MW resolution)

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Dense array literal, hand-wrapped at ~76 columns (README size budget). */
function dense(values) {
  const out = [];
  let line = ' ';
  for (const v of values) {
    const s = ` ${v},`;
    if (line.length + s.length > 76) {
      out.push(line);
      line = ' ';
    }
    line += s;
  }
  if (line.trim()) out.push(line);
  return out.join('\n');
}

function emit(name, doc, values) {
  return `\n/** ${doc} */\n// prettier-ignore\nexport const ${name}: readonly number[] = [\n${dense(values)}\n];\n`;
}

const power = await getJson(POWER_URL);
const price = await getJson(PRICE_URL);

const byType = new Map(power.production_types.map((p) => [p.name, p.data]));
for (const [, , types] of BANDS) {
  for (const t of types) {
    if (!byType.has(t)) throw new Error(`missing production type: ${t}`);
  }
}
const n = power.unix_seconds.length;
const stepS = power.unix_seconds[1] - power.unix_seconds[0];
for (let i = 1; i < n; i += 1) {
  if (power.unix_seconds[i] - power.unix_seconds[i - 1] !== stepS) {
    throw new Error(`irregular cadence at index ${i}`);
  }
}

const bands = BANDS.map(([key, label, types]) => {
  const values = [];
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (const t of types) {
      const v = byType.get(t)[i];
      if (v === null || v === undefined)
        throw new Error(`null in ${t} at ${i}`);
      sum += v;
    }
    values.push(GW(sum));
  }
  return { key, label, values };
});
const load = byType.get('Load').map(GW);

// Every generation type must land in exactly one band.
const NON_GENERATION = new Set([
  'Load',
  'Residual load',
  'Renewable share of load',
  'Renewable share of generation',
  'Cross border electricity trading',
  'Hydro pumped storage consumption',
]);
const assigned = new Set(BANDS.flatMap(([, , types]) => types));
for (const name of byType.keys()) {
  if (!NON_GENERATION.has(name) && !assigned.has(name)) {
    throw new Error(`unassigned generation type: ${name}`);
  }
}

const priceStepS = price.unix_seconds[1] - price.unix_seconds[0];

const header = `/**
 * **Real measured data.** The German power system over Easter weekend 2025 —
 * Saturday 19 to Monday 21 April. Easter Sunday the 20th had the **lowest
 * average demand of any day in 2025** (39.59 GW; checked against the whole
 * year from the same endpoint), and that quiet Sunday met a 38.48 GW solar
 * peak: for 1 h 45 m wind and solar together out-produced the entire country's
 * load, and the day-ahead price went negative for eight hours of the weekend,
 * bottoming at −52.42 EUR/MWh.
 *
 * **Source and licence.** energy-charts.info (Fraunhofer ISE) —
 * https://api.energy-charts.info. Generation and load from its
 * \`/public_power\` endpoint (upstream: ENTSO-E / SMARD); the day-ahead price
 * from \`/price\`. Retrieved ${new Date().toISOString().slice(0, 10)}, for ${START} – ${END}.
 *
 * The \`/price\` response self-reports its licence in a \`license_info\` field:
 * "${price.license_info ?? '(absent)'}". \`/public_power\` carries **no** such
 * field — Energy-Charts publishes under CC BY 4.0 site-wide, but that endpoint
 * does not restate it per response, so the attribution here (Fraunhofer ISE /
 * energy-charts.info, upstream ENTSO-E) is what CC BY asks for rather than
 * something the payload proves.
 *
 * **What was kept.** Generation at the API's native **15-minute** cadence
 * (${n} rows, ${stepS} s apart, starting ${new Date(power.unix_seconds[0] * 1000).toISOString()}),
 * converted MW → **GW** and rounded to 2 dp (10 MW). Its fifteen production
 * types are folded into **eight bands**, listed here bottom-of-stack first, so
 * the bands sum to total domestic generation rather than to an arbitrary
 * top-eight:
 *
${BANDS.map(([key, label, types]) => ` *   - \`${key}\` (${label}) — ${types.join(', ')}`).join('\n')}
 *
 * Load is the same series' \`Load\` channel. The price is hourly
 * (${price.price.length} rows, ${priceStepS} s apart) because the day-ahead auction
 * clears hourly — a different cadence on purpose, not a downsample.
 *
 * **What was dropped.** Cross-border trade, pumped-storage *consumption*,
 * residual load and the two renewable-share channels: all derived or
 * non-generation series that would double-count inside a generation stack.
 * Pumped-storage *discharge* is kept, inside \`other\`.
 *
 * **Quirks that survived on purpose.** Solar goes to a true 0.00 every night
 * (not a floor); \`hardCoal\` and \`gas\` collapse to near-nothing at the Sunday
 * midday peak — that is the merit order being pushed off the system, and it is
 * the whole story of the three charts. Nuclear is absent because Germany's last
 * reactors shut down in April 2023, so there is no nuclear band to draw.
 *
 * Generated once by \`website/scripts/fixtures/energy.mjs\`, then committed —
 * the docs site fetches nothing.
 */
export const GRID_START_MS = ${power.unix_seconds[0] * 1000};

/** Cadence of the generation / load samples: 15 minutes. */
export const GRID_STEP_MS = ${stepS * 1000};

/** Cadence of the day-ahead price samples: the hourly auction. */
export const PRICE_STEP_MS = ${priceStepS * 1000};

/** First hour of the day-ahead price series (same weekend, hourly). */
export const PRICE_START_MS = ${price.unix_seconds[0] * 1000};
`;

const body =
  bands
    .map(({ key, label, values }) =>
      emit(
        `${key.replace(/([A-Z])/g, '_$1').toUpperCase()}_GW`,
        `${label} generation, GW.`,
        values,
      ),
    )
    .join('') +
  emit('LOAD_GW', 'Total load (demand), GW.', load) +
  emit(
    'PRICE_EUR_MWH',
    'DE-LU day-ahead auction price, EUR/MWh — negative when there is more must-run generation than demand.',
    price.price,
  );

process.stdout.write(header + body);
