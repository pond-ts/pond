/**
 * The committed study parity fixture (`fixtures/study-parity.json`) must
 * match what the studies produce today. pond-rs checks its studies against
 * that file bit for bit, so a stale fixture would silently move the target.
 * If this fails after an intended behaviour change, rebuild and regenerate:
 * `npm run build --workspace=pond-ts && npm run build
 * --workspace=@pond-ts/financial && node
 * packages/financial/scripts/parity/generate.mjs`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pond from 'pond-ts';
import * as financial from '../src/index.js';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import { buildFixture } from '../scripts/parity/cases.mjs';

const read = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));

describe('study parity fixture', () => {
  it('matches what the studies produce', () => {
    const committed = read('./fixtures/study-parity.json');
    const oracle = read('./fixtures/study-oracle.json');
    const fresh = JSON.parse(
      JSON.stringify(buildFixture(pond, financial, oracle)),
    );
    expect(fresh).toEqual(committed);
  });
});
