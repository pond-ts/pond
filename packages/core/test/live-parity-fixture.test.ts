/**
 * The committed live parity fixture (`fixtures/live-parity.json`) must match
 * what pond-ts's live layer emits today. pond-rs checks its live layer
 * against that file ([PND-RUST-R3] in `docs/plans/PND_RUST_PLAN.md`), so a
 * stale fixture would silently move the target. If this fails after an
 * intended behaviour change, rebuild and regenerate: `npm run build
 * --workspace=pond-ts && node packages/core/scripts/parity/generate.mjs`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pond from '../src/index.js';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import { buildLiveFixture } from '../scripts/parity/live.mjs';

describe('live parity fixture', () => {
  it('matches pond-ts output', async () => {
    const committed = JSON.parse(
      readFileSync(
        new URL('./fixtures/live-parity.json', import.meta.url),
        'utf8',
      ),
    );
    const fresh = JSON.parse(JSON.stringify(await buildLiveFixture(pond)));
    expect(fresh).toEqual(committed);
  });
});
