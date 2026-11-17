// Writes test/fixtures/parity.json from the compiled packages — the answers
// the Rust port (crates/pond-process) checks itself against.
// Run after building pond-ts and this package:
//   npm run build --workspace=pond-ts --workspace=@pond-ts/process
//   node packages/process/scripts/parity/generate.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pond from 'pond-ts';
import * as proc from '../../dist/index.js';
import { buildFixture } from './cases.mjs';

const out = fileURLToPath(
  new URL('../../test/fixtures/parity.json', import.meta.url),
);
const fixture = await buildFixture(pond, proc);
writeFileSync(out, JSON.stringify(fixture) + '\n');
console.log(
  `wrote ${fixture.ids.length} id cases and ${fixture.sessions.length} sessions to ${out}`,
);
