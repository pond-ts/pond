/**
 * The committed process fixture (`fixtures/process-parity.json`) must match
 * what `@pond-ts/financial/process` makes of the catalog today: the Rust
 * port (`crates/pond-process`) checks its own bridge against that file. If
 * this fails after an intended change, rebuild and regenerate: `npm run
 * build --workspace=pond-ts && npm run build --workspace=@pond-ts/process
 * && npm run build --workspace=@pond-ts/financial && node
 * packages/financial/scripts/parity/generate.mjs`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pond from 'pond-ts';
import * as proc from '@pond-ts/process';
import * as bridge from '../src/process/index.js';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import { buildProcessFixture } from '../scripts/parity/process.mjs';

describe('process parity fixture', () => {
  it('matches the bridge', () => {
    const committed = JSON.parse(
      readFileSync(
        new URL('./fixtures/process-parity.json', import.meta.url),
        'utf8',
      ),
    );
    expect(buildProcessFixture(pond, proc, bridge)).toEqual(committed);
  });
});
