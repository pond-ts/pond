#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/spain-eclipse-samples.ts` — the Gallery's
 * Energy track's eclipse-demand card.
 *
 * Run by hand, never by the build (see `src/examples/lib/README.md`):
 *
 *     node website/scripts/fixtures/spain-eclipse.mjs > website/src/examples/lib/spain-eclipse-samples.ts
 *
 * Input is the committed raw export at
 * `packages/charts/test-data/spain-eclipse-demand.csv` — Red Eléctrica's
 * "Seguimiento de la demanda de energía eléctrica" (demanda.ree.es), peninsular
 * demand at 5-minute cadence across the 12 August 2026 total solar eclipse,
 * retrieved 2026-08-13. The export is Latin-1, opens with a title line, and
 * every data row carries a trailing comma; this script owns decoding those
 * quirks so the fixture doesn't.
 *
 * What it does:
 *   - keeps `Real` (measured demand) and `Prevista` (REE's demand forecast);
 *     drops the two programme columns (`Programada`, `Programada total`) —
 *     market-operations series the card's measured-vs-forecast question never
 *     asks about
 *   - converts the export's naive local timestamps (CEST, UTC+2 — constant
 *     across the window, mid-August has no DST edge) to epoch ms
 *   - converts MW → GW at 2 dp (10 MW resolution)
 *   - validates the grid: strict 5-minute cadence, no gaps, no nulls —
 *     the fixture's start + step constants are only honest if that holds
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/charts/test-data/spain-eclipse-demand.csv',
);

/** The export's clock is Europe/Madrid local (CEST = UTC+2 for the whole
 *  window). */
const CEST_OFFSET_MS = 2 * 3_600_000;
const STEP_MS = 300_000;

const rows = [];
for (const line of readFileSync(CSV, 'latin1').split(/\r?\n/)) {
  const m = line.match(
    /^"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})","(\d+)","(\d+)","(\d+)","(\d+)",?\s*$/,
  );
  if (!m) continue; // title line, header line, blank tail
  const [, y, mo, d, h, mi, real, prevista] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi) - CEST_OFFSET_MS;
  rows.push([t, +real, +prevista]);
}

if (rows.length === 0) throw new Error('no data rows parsed');
for (let i = 1; i < rows.length; i += 1) {
  const gap = rows[i][0] - rows[i - 1][0];
  if (gap !== STEP_MS)
    throw new Error(
      `cadence break at row ${i}: ${new Date(rows[i][0]).toISOString()} is ${gap} ms after the previous row`,
    );
}

const GW = (mw) => (Math.round(mw / 10) / 100).toFixed(2).replace(/\.?0+$/, '');

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

const start = rows[0][0];
const demand = rows.map((r) => GW(r[1]));
const forecast = rows.map((r) => GW(r[2]));

process.stdout.write(`/**
 * **Real measured data.** Peninsular Spain's electricity demand, at the grid
 * operator's native **5-minute** cadence, across the evening of the
 * **12 August 2026 total solar eclipse** — ${rows.length} rows from
 * ${new Date(start).toISOString()} to ${new Date(rows[rows.length - 1][0]).toISOString()}
 * (21:00 CEST on the 11th to 03:00 CEST on the 13th). Two columns: what the
 * country actually drew, and what Red Eléctrica's demand model said it would.
 * They track within a few hundred MW for thirty hours — except the ninety
 * minutes the Moon was in front of the Sun.
 *
 * **Source and licence.** Red Eléctrica (REE), the Spanish TSO — the
 * "Seguimiento de la demanda de energía eléctrica" export at
 * https://demanda.ree.es, retrieved 2026-08-13, the morning after the
 * eclipse. Attribution: **Source: Red Eléctrica** — here and on every page
 * that draws it.
 *
 * **What was kept.** \`Real\` (measured demand) → \`DEMAND_GW\` and \`Prevista\`
 * (REE's own demand forecast) → \`FORECAST_GW\`, converted MW → **GW** at 2 dp
 * (10 MW resolution). The export's two programme columns (\`Programada\`,
 * \`Programada total\` — scheduled generation) were dropped: they answer a
 * market-operations question, not this card's measured-vs-forecast one.
 *
 * **Quirks.** The export's timestamps are naive local clock time (CEST,
 * UTC+2 across the whole window); the generator converts them to epoch ms.
 * The grid is perfect — no gaps, no nulls, ${rows.length} rows exactly 300 s
 * apart — so the two arrays index off one \`START\`/\`STEP\` pair.
 *
 * Generated once by \`website/scripts/fixtures/spain-eclipse.mjs\` from the
 * committed raw export at
 * \`packages/charts/test-data/spain-eclipse-demand.csv\`, then committed —
 * the docs site fetches nothing.
 */

/** First sample: ${new Date(start).toISOString()} (21:00 CEST, 11 Aug). */
export const ECLIPSE_START_MS = ${start};

/** Cadence of both columns: REE's native 5 minutes. */
export const ECLIPSE_STEP_MS = ${STEP_MS};

/** Measured peninsular demand, GW. */
// prettier-ignore
export const DEMAND_GW: readonly number[] = [
${wrap(demand)}
];

/** REE's demand forecast, GW. */
// prettier-ignore
export const FORECAST_GW: readonly number[] = [
${wrap(forecast)}
];
`);
