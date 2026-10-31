/**
 * The committed calendar parity fixture (`fixtures/calendar-parity.json`)
 * must match what the trading calendar produces today: pond-rs checks its
 * calendar against that file. If this fails after an intended change,
 * rebuild and regenerate: `npm run build --workspace=pond-ts && npm run
 * build --workspace=@pond-ts/financial && node
 * packages/financial/scripts/parity/generate.mjs`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pond from 'pond-ts';
import * as financial from '../src/index.js';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import { buildCalendarFixture } from '../scripts/parity/calendar.mjs';

describe('calendar parity fixture', () => {
  it('matches what the calendar produces', () => {
    const committed = JSON.parse(
      readFileSync(
        new URL('./fixtures/calendar-parity.json', import.meta.url),
        'utf8',
      ),
    );
    const fresh = JSON.parse(
      JSON.stringify(buildCalendarFixture(pond, financial)),
    );
    expect(fresh).toEqual(committed);
  });
});
