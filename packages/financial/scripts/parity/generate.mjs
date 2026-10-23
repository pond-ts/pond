// Writes test/fixtures/study-parity.json and calendar-parity.json from the
// compiled packages.
// Run after building pond-ts and @pond-ts/financial:
//   npm run build --workspace=pond-ts
//   npm run build --workspace=@pond-ts/financial
//   node packages/financial/scripts/parity/generate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pond from 'pond-ts';
import * as financial from '../../dist/index.js';
import { buildFixture } from './cases.mjs';
import { buildCalendarFixture } from './calendar.mjs';

const oracle = JSON.parse(
  readFileSync(
    new URL('../../test/fixtures/study-oracle.json', import.meta.url),
    'utf8',
  ),
);
const out = fileURLToPath(
  new URL('../../test/fixtures/study-parity.json', import.meta.url),
);
const fixture = buildFixture(pond, financial, oracle);
writeFileSync(out, JSON.stringify(fixture) + '\n');
console.log(`wrote ${fixture.cases.length} cases to ${out}`);

const calendarOut = fileURLToPath(
  new URL('../../test/fixtures/calendar-parity.json', import.meta.url),
);
const calendar = buildCalendarFixture(pond, financial);
writeFileSync(calendarOut, JSON.stringify(calendar) + '\n');
console.log(`wrote ${calendar.cases.length} cases to ${calendarOut}`);
