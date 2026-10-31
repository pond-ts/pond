/**
 * The committed catalog fixture (`fixtures/catalog-parity.json`) must match
 * the catalog today: pond-rs checks its own catalog against that file. If
 * this fails after an intended change, rebuild and regenerate: `npm run
 * build --workspace=pond-ts && npm run build --workspace=@pond-ts/financial
 * && node packages/financial/scripts/parity/generate.mjs`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as catalog from '../src/catalog/index.js';
// @ts-expect-error -- plain .mjs generator shared with the build-time script
import { buildCatalogFixture } from '../scripts/parity/catalog.mjs';
import { bars, columnValues } from './catalog-fixture.js';

describe('catalog parity fixture', () => {
  it('matches the catalog', () => {
    const committed = JSON.parse(
      readFileSync(
        new URL('./fixtures/catalog-parity.json', import.meta.url),
        'utf8',
      ),
    );
    const fresh = JSON.parse(JSON.stringify(buildCatalogFixture(catalog)));
    expect(fresh).toEqual(committed);
  });

  it('writes the bars the catalog test runs on', () => {
    const rows: number[][] = buildCatalogFixture(catalog).bars;
    const names = ['open', 'high', 'low', 'close', 'volume', 'sess'];
    names.forEach((name, i) => {
      expect(rows.map((r) => r[i + 1])).toEqual(columnValues(bars, name));
    });
  });
});
