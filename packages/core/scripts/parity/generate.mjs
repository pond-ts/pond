// Writes test/fixtures/parity.json and the parity-export*.arrow files from the
// compiled package.
// Run after `npm run build --workspace=pond-ts`:
//   node packages/core/scripts/parity/generate.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pond from '../../dist/index.js';
import { buildFixture } from './cases.mjs';
import {
  EXPORT_FILE,
  TYPED_EXPORTS,
  buildArrowExport,
  buildTypedArrowExport,
} from './export.mjs';

const out = fileURLToPath(
  new URL('../../test/fixtures/parity.json', import.meta.url),
);
const fixture = buildFixture(pond);
writeFileSync(out, JSON.stringify(fixture) + '\n');
console.log(`wrote ${fixture.cases.length} cases to ${out}`);

const arrowOut = fileURLToPath(
  new URL(`../../test/fixtures/${EXPORT_FILE}`, import.meta.url),
);
writeFileSync(arrowOut, buildArrowExport(pond));
console.log(`wrote ${arrowOut}`);

for (const [file, input] of TYPED_EXPORTS) {
  const typedOut = fileURLToPath(
    new URL(`../../test/fixtures/${file}`, import.meta.url),
  );
  writeFileSync(typedOut, buildTypedArrowExport(input(pond)));
  console.log(`wrote ${typedOut}`);
}
