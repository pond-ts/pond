/**
 * The committed process parity fixture (`fixtures/parity.json`) must match
 * what this package answers today. The Rust port checks itself against
 * that file (`crates/pond-process/tests/parity.rs`), so a stale fixture
 * would silently move its target. If this fails after an intended
 * behaviour change, rebuild and regenerate:
 *
 *     npm run build --workspace=pond-ts --workspace=@pond-ts/process
 *     node packages/process/scripts/parity/generate.mjs
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pond from 'pond-ts';
import * as proc from '../src/index.js';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import { buildFixture } from '../scripts/parity/cases.mjs';

describe('process parity fixture', () => {
  it('matches what @pond-ts/process answers', async () => {
    const committed = JSON.parse(
      readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8'),
    );
    const fresh = await buildFixture(pond, proc);
    expect(fresh).toEqual(committed);
  });
});
