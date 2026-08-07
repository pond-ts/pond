// Generate `src/examples/lib/measles-samples.ts` — US measles cases by state and
// year, 1921–2001, plus the decennial populations the page divides by.
//
// Runs by hand; its output is committed. Two inputs, neither of them small, so
// download them first (both are freely redistributable, see the licences below):
//
//   1. Project Tycho, "Counts of Measles reported in UNITED STATES OF AMERICA:
//      1888-2002" — https://zenodo.org/records/11452259
//      Take `US.14189004.zip`, unzip it, and pass the 103 MB CSV as argv[1].
//      Licence: CC BY 4.0.
//
//   2. Decennial state populations, from the Wikipedia article
//      "List of U.S. states and territories by historical population":
//        curl -o wiki-pop.txt 'https://en.wikipedia.org/w/index.php?title=\
//          List_of_U.S._states_and_territories_by_historical_population&action=raw'
//      Pass that as argv[2]. Licence: CC BY-SA 4.0.
//
//   node scripts/fixtures/measles.mjs /path/US.14189004.csv /path/wiki-pop.txt
//
// ── The four cleaning rules, each of which changes the picture ──────────────
//
// 1. STATE-LEVEL ONLY. 238,827 of the CSV's 436,932 rows are *city* rows nested
//    inside their state's rows. Summing naively double-counts every state with a
//    reporting city.
//
// 2. NON-CUMULATIVE ONLY. A further 84,414 rows restate a running total.
//
// 3. AN ABSENT WEEK IS A ZERO, NOT A HOLE. Only 836 of the 113,691 surviving
//    rows carry an explicit zero, so a week with no cases is simply missing from
//    the file. Median weeks reported per state-year therefore falls 49 → 2
//    between the 1930s and the 1990s *while median cases falls 3,726 → 4*: the
//    count measures how much measles there was, not how much surveillance there
//    was. (A "a year must be ≥40 weeks complete" rule was tried first and is
//    wrong — it reads the disease's own disappearance as missing data and
//    deletes the whole post-1990 record, which is the half that carries the
//    finding.) So a state is under surveillance from its first reported year to
//    its last; silent weeks inside that span are zeros; years outside it are no
//    data. That is what puts Alaska's and Hawaii's pre-statehood gaps on the
//    chart without special-casing them.
//
//    Cost, stated: in the pre-vaccine era a silent week may be a lost report
//    rather than a zero, so those years can undercount. Texas 1964 reports 37 of
//    52 weeks — at worst ~30%, comfortably inside one band of a log ramp.
//
// 4. FIFTY STATES. Territories are dropped, which also removes a Virgin Islands
//    1975 figure (53,009 cases from 8 weeks, against a population near 60,000)
//    that cannot be right.
//
// Populations are decennial *census counts*, not annual estimates, and the page
// interpolates between them geometrically. Decennial is sufficient because the
// chart bands on a **log** scale — each of eight bands spans a factor of ~3.7,
// and a few percent of mid-decade interpolation error cannot move a cell across
// one. (The Census Bureau's own intercensal files were tried first: nine
// heterogeneous fixed-width text files whose parser produced two
// wrong-but-plausible numbers before it was abandoned.)

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [csvPath, wikiPath] = process.argv.slice(2);
if (!csvPath || !wikiPath) {
  console.error('usage: measles.mjs <tycho.csv> <wiki-pop.txt>');
  process.exit(1);
}

const STATES =
  `Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware
Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine
Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska
Nevada New~Hampshire New~Jersey New~Mexico New~York North~Carolina North~Dakota Ohio
Oklahoma Oregon Pennsylvania Rhode~Island South~Carolina South~Dakota Tennessee Texas
Utah Vermont Virginia Washington West~Virginia Wisconsin Wyoming`
    .split(/\s+/)
    .map((s) => s.replace(/~/g, ' '));
const BY_UPPER = new Map(STATES.map((s) => [s.toUpperCase(), s]));

// ── 1. Cases ───────────────────────────────────────────────────────────────
const cases = new Map(); // "State|year" -> count
const rl = createInterface({ input: createReadStream(csvPath) });
let header = null;
for await (const line of rl) {
  if (header === null) {
    header = line.replace(/"/g, '').split(',');
    continue;
  }
  // Quoted CSV, but no field here contains a comma, so a plain split is safe
  // and ~5x faster than a parser over 437k rows.
  const f = line.replace(/"/g, '').split(',');
  const row = Object.fromEntries(header.map((h, i) => [h, f[i]]));
  if (row.PartOfCumulativeCountSeries !== '0' || row.CityName !== 'NA')
    continue;
  const state = BY_UPPER.get(row.Admin1Name);
  if (state === undefined) continue;
  const year = +row.PeriodStartDate.slice(0, 4);
  const key = `${state}|${year}`;
  cases.set(key, (cases.get(key) ?? 0) + +row.CountValue);
}

// ── 2. Decennial populations ───────────────────────────────────────────────
const wiki = readFileSync(wikiPath, 'utf8');
const pop = new Map(); // "State|censusYear" -> people
{
  let years = [];
  let state = null;
  let col = 0;
  for (const line of wiki.split('\n')) {
    const y = /^!\s*(1[89]\d{2}|20\d{2})/.exec(line);
    if (y) {
      if (state !== null) {
        years = [];
        state = null;
      }
      years.push(+y[1]);
      continue;
    }
    const r = /^\|\s*\{\{flag\|([^}|]+)/.exec(line);
    if (r) {
      state = r[1].trim();
      col = 0;
      continue;
    }
    if (state === null || years.length === 0) continue;
    const c = /^\|\s*(?:bgcolor="[^"]*"\s*\|)?\s*([\d,]*)\s*$/.exec(line);
    if (c) {
      const v = c[1].replace(/,/g, '');
      if (col < years.length && v && STATES.includes(state)) {
        pop.set(`${state}|${years[col]}`, +v);
      }
      col += 1;
    }
  }
}

// ── 3. Grid ────────────────────────────────────────────────────────────────
const years = [...new Set([...cases.keys()].map((k) => +k.split('|')[1]))].sort(
  (a, b) => a - b,
);
const counts = {};
for (const s of STATES) {
  const mine = years.filter((y) => cases.has(`${s}|${y}`));
  const lo = mine[0];
  const hi = mine[mine.length - 1];
  counts[s] = years.map((y) =>
    lo !== undefined && y >= lo && y <= hi
      ? (cases.get(`${s}|${y}`) ?? 0)
      : null,
  );
}

const censusYears = [
  ...new Set([...pop.keys()].map((k) => +k.split('|')[1])),
].sort((a, b) => a - b);
const populations = {};
for (const s of STATES) {
  populations[s] = censusYears.map((y) => pop.get(`${s}|${y}`) ?? null);
}

const filled = Object.values(counts)
  .flat()
  .filter((v) => v !== null).length;
const holes = Object.values(counts)
  .flat()
  .filter((v) => v === null).length;

// `join` renders null as an EMPTY STRING, which would emit `[,,,323]` — a sparse
// array, not a run of holes. Spell the nulls out.
const list = (a) => a.map((v) => (v === null ? 'null' : v)).join(',');

const out = `// GENERATED by scripts/fixtures/measles.mjs — do not edit by hand.
/**
 * **Real, measured, freely licensed.** Reported measles cases in the United
 * States by **state** and **year**, ${years[0]}–${years[years.length - 1]}, and
 * the decennial census populations to divide them by.
 *
 * Cases: **Project Tycho**, "Counts of Measles reported in UNITED STATES OF
 * AMERICA: 1888-2002" (https://zenodo.org/records/11452259), CC BY 4.0.
 * Populations: the Wikipedia article "List of U.S. states and territories by
 * historical population", CC BY-SA 4.0.
 *
 * ${filled.toLocaleString()} state-years carry a count; **${holes}** are \`null\`,
 * meaning *no data* rather than *no cases* — a state before it began reporting,
 * which is why Alaska and Hawaii are blank for most of the record. That
 * distinction is the reason the chart draws holes as hatching: on a pale ramp,
 * painting nothing would read as the bottom of the scale, and this record's late
 * years are full of genuine zeros.
 *
 * Counts are raw **cases**, not incidence — the page divides by an interpolated
 * population, so the arithmetic stays visible rather than baked in. See
 * \`scripts/fixtures/measles.mjs\` for the four cleaning rules, each of which
 * changes the picture: city rows nested inside state rows, cumulative-series
 * restatements, absent-week-means-zero, and territories.
 */
export const MEASLES_YEARS: readonly number[] = [${years.join(', ')}];

export const MEASLES_STATES: readonly string[] = [
${STATES.map((s) => `  '${s}',`).join('\n')}
];

/** Cases per state, one entry per {@link MEASLES_YEARS} slot. \`null\` is *no
 *  data* — outside that state's reporting span. */
export const MEASLES_CASES: Readonly<Record<string, readonly (number | null)[]>> = {
${STATES.map((s) => `  '${s}': [${list(counts[s])}],`).join('\n')}
};

/** Census years the populations below are anchored on. */
export const CENSUS_YEARS: readonly number[] = [${censusYears.join(', ')}];

/** Decennial resident population per state, one entry per {@link CENSUS_YEARS}. */
export const STATE_POPULATION: Readonly<Record<string, readonly (number | null)[]>> = {
${STATES.map((s) => `  '${s}': [${list(populations[s])}],`).join('\n')}
};
`;

const dest = new URL(
  '../../src/examples/lib/measles-samples.ts',
  import.meta.url,
);
writeFileSync(dest, out);
console.log(
  `years ${years[0]}-${years[years.length - 1]}  states ${STATES.length}  ` +
    `counts ${filled}  no-data ${holes}  ${(out.length / 1024).toFixed(1)} KB`,
);
