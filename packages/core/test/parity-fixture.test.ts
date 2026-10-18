/**
 * The committed core parity fixture (`fixtures/parity.json`) must match what
 * pond-ts produces today. pond-rs checks itself against that file (see
 * `docs/rfcs/pond-rs.md` §6), so a stale fixture would silently move the
 * target. If this fails after an intended behaviour change, rebuild and
 * regenerate: `npm run build --workspace=pond-ts && node
 * packages/core/scripts/parity/generate.mjs`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pond from '../src/index.js';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import { buildFixture } from '../scripts/parity/cases.mjs';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import * as parityExport from '../scripts/parity/export.mjs';

const { EXPORT_FILE, TYPED_EXPORTS, buildArrowExport, buildTypedArrowExport } =
  parityExport;

describe('core parity fixture', () => {
  it('matches pond-ts output', () => {
    const committed = JSON.parse(
      readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8'),
    );
    const fresh = JSON.parse(JSON.stringify(buildFixture(pond)));
    expect(fresh).toEqual(committed);
  });

  it.each([
    [EXPORT_FILE, buildArrowExport],
    ...TYPED_EXPORTS.map(([file, input]: [string, (p: unknown) => unknown]) => [
      file,
      (p: unknown) => buildTypedArrowExport(input(p)),
    ]),
  ])('matches the pond-ts Arrow export pond-rs reads (%s)', (file, build) => {
    const committed = readFileSync(
      new URL(`./fixtures/${file}`, import.meta.url),
    );
    const fresh = Buffer.from(build(pond));
    expect(fresh.equals(committed)).toBe(true);
  });
});
