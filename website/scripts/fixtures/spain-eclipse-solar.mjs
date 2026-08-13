#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/spain-eclipse-solar-samples.ts` — the
 * generation-side companion to the eclipse-demand card: Spain's solar output
 * on eclipse day (12 August 2026) against the previous day's, aligned by
 * clock time.
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
 * Only the API's single `Solar` channel is kept, for both days. The two days
 * are fetched separately and aligned **by index**: both are one civil day
 * (CEST) of 96 quarter-hours, and the script validates that every pair of
 * timestamps is exactly 24 h apart before emitting — the "previous day at the
 * same clock time" framing is only honest if that holds.
 */

const POWER_URL = (day) =>
  `https://api.energy-charts.info/public_power?country=es&start=${day}&end=${day}`;

const ECLIPSE_DAY = '2026-08-12';
const DAY_BEFORE = '2026-08-11';
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

const before = await getSolar(DAY_BEFORE);
const eclipse = await getSolar(ECLIPSE_DAY);

for (let i = 0; i < 96; i += 1)
  if (eclipse.ts[i] - before.ts[i] !== DAY_S)
    throw new Error(`days misaligned at index ${i}`);

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

const startMs = eclipse.ts[0] * 1000;

process.stdout.write(`/**
 * **Real measured data.** Spain's solar generation on the day of the
 * **12 August 2026 total solar eclipse**, and the same civil day's worth from
 * the day before — 96 quarter-hours each (midnight to midnight CEST), the
 * API's native 15-minute cadence. The pair exists for the evening: on the
 * 11th solar rode an ordinary sunset ramp; on the 12th the Moon took a
 * second, faster sunset out of the middle of the first one.
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
 * **What was kept.** The API's single \`Solar\` channel, for both days,
 * converted MW → **GW** at 2 dp (10 MW resolution): \`SOLAR_ECLIPSE_DAY_GW\`
 * (the 12th) and \`SOLAR_DAY_BEFORE_GW\` (the 11th). ENTSO-E reports Spanish
 * solar as one category, so PV and solar-thermal are not separable here.
 * Everything else — the fourteen other production types, load, the derived
 * shares — belongs to other cards' questions and was dropped.
 *
 * **Quirks.** The two arrays share one index: sample *i* of each is the same
 * clock time (CEST) one day apart, validated to exactly 24 h by the
 * generator. Drawing them on one axis means the day-before curve is plotted
 * 24 h forward of when it happened — the same-clock-time overlay is the whole
 * device, and every page that draws it must say so. Both days are complete
 * (no gaps, no nulls), and neither ever reads zero: Spanish solar idles near
 * **0.6 GW overnight**, because ENTSO-E's single Solar category includes
 * concentrated solar plants discharging thermal storage after dark.
 *
 * Generated once by \`website/scripts/fixtures/spain-eclipse-solar.mjs\`, then
 * committed — the docs site fetches nothing.
 */

/** First sample: ${new Date(startMs).toISOString()} (00:00 CEST, 12 Aug). */
export const ECLIPSE_SOLAR_START_MS = ${startMs};

/** Cadence of both columns: the API's native 15 minutes. */
export const ECLIPSE_SOLAR_STEP_MS = ${STEP_S * 1000};

/** Solar generation on eclipse day (12 August 2026), GW. */
// prettier-ignore
export const SOLAR_ECLIPSE_DAY_GW: readonly number[] = [
${wrap(eclipse.solar.map(GW))}
];

/** Solar generation the day before (11 August 2026), GW — indexed to the
 *  same clock time as \`SOLAR_ECLIPSE_DAY_GW\`. */
// prettier-ignore
export const SOLAR_DAY_BEFORE_GW: readonly number[] = [
${wrap(before.solar.map(GW))}
];
`);
