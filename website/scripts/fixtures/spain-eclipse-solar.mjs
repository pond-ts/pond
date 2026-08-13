#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/spain-eclipse-solar-samples.ts` — the
 * generation-side companion to the eclipse-demand card: Spain's solar output
 * on eclipse day (12 August 2026) plus the **three days before it**, aligned
 * by clock time, so the example can build a baseline out of the ordinary
 * days and show eclipse day as the anomaly.
 *
 * Run by hand, never by the build (see `src/examples/lib/README.md`):
 *
 *     node website/scripts/fixtures/spain-eclipse-solar.mjs > website/src/examples/lib/spain-eclipse-solar-samples.ts
 *
 * One public endpoint of **energy-charts.info** (Fraunhofer ISE) — the same
 * source and conventions as `energy.mjs` next door:
 *
 *   - `/public_power?country=es` — 15-minute generation by production type
 *     for the ES bidding zone. Source: ENTSO-E. Returns **no** `license_info`
 *     field; Energy-Charts publishes under CC BY 4.0 site-wide.
 *
 * Only the API's single `Solar` channel is kept, for all four days. Each day
 * is fetched separately and the days are aligned **by index**: each is one
 * civil day (CEST) of 96 quarter-hours, and the script validates that every
 * pair of consecutive days is exactly 24 h apart at every index before
 * emitting — the "same clock time" framing is only honest if that holds.
 */

const POWER_URL = (day) =>
  `https://api.energy-charts.info/public_power?country=es&start=${day}&end=${day}`;

/** Oldest first; the last entry is eclipse day. */
const DAYS = ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12'];
const STEP_S = 900;
const DAY_S = 86_400;

const GW = (mw) => (Math.round(mw / 10) / 100).toFixed(2).replace(/\.?0+$/, '');

async function getSolar(day) {
  const res = await fetch(POWER_URL(day));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${day}`);
  const json = await res.json();
  const solar = json.production_types.find((p) => p.name === 'Solar');
  if (!solar) throw new Error(`no Solar channel for ${day}`);
  const ts = json.unix_seconds;
  if (ts.length !== 96)
    throw new Error(`${day}: expected 96 quarter-hours, got ${ts.length}`);
  for (let i = 1; i < ts.length; i += 1)
    if (ts[i] - ts[i - 1] !== STEP_S)
      throw new Error(`${day}: cadence break at index ${i}`);
  solar.data.forEach((v, i) => {
    if (typeof v !== 'number')
      throw new Error(`${day}: null Solar sample at index ${i}`);
  });
  return { ts, solar: solar.data };
}

const fetched = [];
for (const day of DAYS) fetched.push(await getSolar(day));

for (let d = 1; d < fetched.length; d += 1)
  for (let i = 0; i < 96; i += 1)
    if (fetched[d].ts[i] - fetched[d - 1].ts[i] !== DAY_S)
      throw new Error(`days ${DAYS[d - 1]} / ${DAYS[d]} misaligned at ${i}`);

/** Dense ~80-column wrap, matching the house `// prettier-ignore` style. */
function wrap(values) {
  const lines = [];
  let line = ' ';
  for (const v of values) {
    if (line.length + v.length + 2 > 80) {
      lines.push(line + ',');
      line = ' ';
    }
    line += (line === ' ' ? ' ' : ', ') + v;
  }
  lines.push(line + ',');
  return lines.join('\n');
}

const eclipse = fetched[fetched.length - 1];
const startMs = eclipse.ts[0] * 1000;

const dayConst = (day) => `SOLAR_AUG${day.slice(8)}_GW`;

process.stdout.write(`/**
 * **Real measured data.** Spain's solar generation on the day of the
 * **12 August 2026 total solar eclipse**, plus the three days before it —
 * 96 quarter-hours each (midnight to midnight CEST), the API's native
 * 15-minute cadence. Four civil days, one shared index: sample *i* of every
 * array is the same clock time. The three ordinary days exist to be a
 * baseline; on the 12th the Moon took a second, faster sunset out of the
 * middle of the real one.
 *
 * **Source and licence.** energy-charts.info (Fraunhofer ISE) —
 * https://api.energy-charts.info, \`/public_power?country=es\` (upstream:
 * ENTSO-E). Retrieved 2026-08-13, the morning after the eclipse. The endpoint
 * does not restate a licence per response; Energy-Charts publishes under
 * **CC BY 4.0** site-wide, so the attribution here (Fraunhofer ISE /
 * energy-charts.info, upstream ENTSO-E) is what CC BY asks for. Same source
 * family as \`energy-samples.ts\`, which documents the licence situation in
 * more detail.
 *
 * **What was kept.** The API's single \`Solar\` channel, for the four days,
 * converted MW → **GW** at 2 dp (10 MW resolution): \`SOLAR_ECLIPSE_DAY_GW\`
 * (the 12th) and \`SOLAR_AUG09_GW\` / \`SOLAR_AUG10_GW\` / \`SOLAR_AUG11_GW\`
 * (the ordinary days). ENTSO-E reports Spanish solar as one category, so PV
 * and solar-thermal are not separable here. Everything else — the fourteen
 * other production types, load, the derived shares — belongs to other cards'
 * questions and was dropped.
 *
 * **Quirks.** Drawing the ordinary days on eclipse day's axis means each is
 * plotted one, two or three days forward of when it happened — the
 * same-clock-time overlay is the whole device, and every page that draws it
 * must say so. All four days are complete (no gaps, no nulls; alignment
 * validated to exactly 24 h between consecutive days at every index), and
 * none ever reads zero: each enters the night around **0.5–0.65 GW** and
 * drains to **0.12–0.22 GW** before dawn, because ENTSO-E's single Solar
 * category includes concentrated solar plants discharging thermal storage
 * after dark.
 *
 * Generated once by \`website/scripts/fixtures/spain-eclipse-solar.mjs\`, then
 * committed — the docs site fetches nothing.
 */

/** First sample: ${new Date(startMs).toISOString()} (00:00 CEST, 12 Aug). */
export const ECLIPSE_SOLAR_START_MS = ${startMs};

/** Cadence of every column: the API's native 15 minutes. */
export const ECLIPSE_SOLAR_STEP_MS = ${STEP_S * 1000};

/** Solar generation on eclipse day (12 August 2026), GW. */
// prettier-ignore
export const SOLAR_ECLIPSE_DAY_GW: readonly number[] = [
${wrap(eclipse.solar.map(GW))}
];
${DAYS.slice(0, -1)
  .map(
    (day, d) => `
/** Solar generation on ${day} — indexed to the same clock time as
 *  \`SOLAR_ECLIPSE_DAY_GW\`, ${DAYS.length - 1 - d} day${DAYS.length - 1 - d > 1 ? 's' : ''} earlier. GW. */
// prettier-ignore
export const ${dayConst(day)}: readonly number[] = [
${wrap(fetched[d].solar.map(GW))}
];`,
  )
  .join('\n')}
`);
