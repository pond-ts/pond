// Writes test/fixtures/study-parity.json from the compiled packages.
// Run after building pond-ts and @pond-ts/financial:
//   npm run build --workspace=pond-ts
//   npm run build --workspace=@pond-ts/financial
//   node packages/financial/scripts/parity/generate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pond from 'pond-ts';
import * as financial from '../../dist/index.js';
import { buildFixture } from './cases.mjs';

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
