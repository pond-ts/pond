#!/usr/bin/env node
/**
 * Derive the Gallery's ESnet traffic-volume fixture from the raw export.
 *
 *     node website/scripts/fixtures/esnet-volume.mjs \
 *       > website/src/examples/lib/esnet-volume-samples.ts
 *
 * Run by hand, never by the build (see `src/examples/lib/README.md`). The raw
 * export — `packages/charts/test-data/network/volume.json` — stays where it
 * is: `packages/charts/package.json` ships only `dist`, so it never reaches
 * npm.
 *
 * What this does to it, and why:
 *
 * - **Keeps the three `_in` series only** (`total_in`, `lhcone_in`,
 *   `oscars_in`). The export also carries `total_out` / `lhcone_out` /
 *   `oscars_out`; the chart draws inbound, and the summary table's arithmetic
 *   (normal = total − lhcone − oscars) is what pins it to the `_in` side.
 *   Dropping them halves the fixture.
 * - **Rounds to 6 significant figures.** The export carries byte counts to
 *   full double precision (18 digits, past `Number.MAX_SAFE_INTEGER`, so the
 *   last digits were already noise). Six figures is two more than a chart can
 *   draw and one more than the summary table prints — `197.82 PB` and
 *   `8.41%` reproduce exactly — and it is most of the file size.
 * - **Drops the index column.** The 439 `YYYY-MM` strings are a perfect
 *   monthly grid with no holes (asserted below), so a start month and a count
 *   carry the same information.
 * - **Keeps the leading `null`s.** They are the staggered starts — LHCONE
 *   traffic did not exist before 2015 — and filling them with zero would be a
 *   lie the log axis could not even draw.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.resolve(
  HERE,
  '../../../packages/charts/test-data/network/volume.json',
);

/** Significant figures kept per value. */
const SIGFIGS = 6;

/** When the raw export was supplied — fixed, not `new Date()`, so re-running
 *  this script on unchanged input reproduces the committed file byte for
 *  byte. Bump it by hand when the export is re-pulled. */
const RETRIEVED = '2026-08-04';

const raw = JSON.parse(readFileSync(RAW, 'utf8'));
const table = raw.data.trafficVolume.traffic;
const columns = table.columns;
const points = table.points;

const at = (row, name) => row[columns.indexOf(name)];

// --- the monthly grid must be complete, or a start + count would lie -------
let previous = null;
for (const row of points) {
  const [year, month] = at(row, 'index').split('-').map(Number);
  const ordinal = year * 12 + (month - 1);
  if (previous !== null && ordinal !== previous + 1) {
    throw new Error(`gap in the monthly grid before ${at(row, 'index')}`);
  }
  previous = ordinal;
}

const KEEP = ['total_in', 'lhcone_in', 'oscars_in'];

/** 6 significant figures, printed in exponential form — `1.9782e17` is nine
 *  characters where the expanded integer is eighteen. */
function round(value) {
  if (value === null || value === undefined) return 'null';
  return Number(value.toPrecision(SIGFIGS)).toExponential().replace('e+', 'e');
}

/** Hand-wrap a dense numeric array at ~76 columns — prettier would otherwise
 *  explode it to one value per line and triple the file. */
function wrap(values) {
  const lines = [];
  let line = ' ';
  for (const value of values) {
    const token = ` ${value},`;
    if (line.length + token.length > 76) {
      lines.push(line);
      line = ' ';
    }
    line += token;
  }
  if (line.trim() !== '') lines.push(line);
  return lines.join('\n');
}

const firstIndex = at(points[0], 'index');
const lastIndex = at(points[points.length - 1], 'index');

/** First month each series carries a number, for the header's own record. */
const starts = Object.fromEntries(
  KEEP.map((name) => [
    name,
    at(
      points.find((row) => at(row, name) !== null),
      'index',
    ),
  ]),
);

const out = [];
out.push(`/**
 * **Real measured data** — ESnet's monthly traffic-volume history, ${firstIndex}
 * to ${lastIndex}: ${points.length} months of bytes carried by the US Department of
 * Energy's Energy Sciences Network, the science network that connects the
 * national laboratories to each other and to CERN.
 *
 * Source: ESnet (https://www.es.net/), whose own "Volume History" page is the
 * chart this fixture exists to reproduce. Retrieved ${RETRIEVED}, as the same
 * series their own dashboards draw.
 *
 * **Three inbound series, deliberately staggered.** Everything before a
 * series' first month is \`null\` — not zero, and not interpolated, because the
 * traffic genuinely did not exist yet:
 *
${KEEP.map((name) => ` * - \`${name}\` from **${starts[name]}**`).join('\n')}
 *
 * That is a real leading-gap case, and it is why the chart's LHCONE and OSCARS
 * lines simply begin partway across the plot.
 *
 * **What was dropped.** The export also carries \`total_out\`, \`lhcone_out\` and
 * \`oscars_out\`. The chart draws the inbound side — and the summary table's
 * arithmetic (normal = total − lhcone − oscars) is what pins it there — so the
 * outbound trio is not kept. Values are rounded to ${SIGFIGS} significant figures:
 * the export carries full double precision, which past 2^53 was already noise,
 * and ${SIGFIGS} figures reproduces every printed number exactly.
 *
 * **The quirk that matters.** ${(at(points[points.length - 1], 'total_in') / at(points[0], 'total_in')).toExponential(2).replace('e+', ' × 10^')} growth over ${((points.length - 1) / 12).toFixed(1)} years — a
 * factor of ten every few years — which is exactly why the y axis is
 * logarithmic. On a linear axis the first two decades are a flat line on the
 * floor.
 *
 * Generated once by \`website/scripts/fixtures/esnet-volume.mjs\` from
 * \`packages/charts/test-data/network/volume.json\`, then committed.
 */

/** The first month of the grid, \`YYYY-MM\`. */
export const VOLUME_START_MONTH = '${firstIndex}';

/** Months in the record — a complete grid, so month \`i\` is \`VOLUME_START_MONTH\`
 *  plus \`i\` calendar months with no holes to skip. */
export const VOLUME_MONTHS = ${points.length};
`);

for (const name of KEEP) {
  const values = points.map((row) => round(at(row, name)));
  const complete = starts[name] === firstIndex;
  const gap = complete
    ? `no gap — it runs the whole record`
    : `\`null\` until **${starts[name]}**, when the series starts`;
  out.push(`
/** \`${name}\` in **bytes**, one per month from \`${firstIndex}\`: ${gap}. */
// prettier-ignore
export const ${name.toUpperCase()}: readonly ${complete ? 'number' : '(number | null)'}[] = [
${wrap(values)}
];
`);
}

process.stdout.write(out.join(''));
