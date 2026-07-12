import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docsPalette } from '../src/docs-theme.fixture.js';

/**
 * The fixture↔website lockstep guard (docs plan §9.5 "One look").
 *
 * `docs-theme.fixture.ts` is the canonical source of the docs look;
 * `website/src/css/custom.css` mirrors its values as `--pond-*` custom
 * properties so the site chrome and the live chart embeds (via
 * `cssVarTheme`) render the same design. This test fails whenever one side
 * changes without the other, which is the entire point: change a colour in
 * the fixture and the website tokens must follow, and vice versa.
 */

/** token name in custom.css → key into a docsPalette ramp */
const TOKEN_TO_RAMP: Record<string, keyof typeof docsPalette.light> = {
  '--pond-ink': 'ink',
  '--pond-body': 'body',
  '--pond-muted': 'muted',
  '--pond-surface': 'surface',
  '--pond-surface-2': 'surface2',
  '--pond-viz-1': 'viz1',
  '--pond-viz-2': 'viz2',
  '--pond-viz-3': 'viz3',
  '--pond-viz-4': 'viz4',
  '--pond-viz-5': 'viz5',
  '--pond-viz-mark': 'vizMark',
  '--pond-viz-up': 'vizUp',
  '--pond-viz-down': 'vizDown',
  '--pond-viz-grid': 'grid',
  '--pond-viz-divider': 'divider',
};

/**
 * Brand UI-chrome tokens (brand/Pond Brand Spec.html §02) the site defines
 * for its own chrome — buttons, nav, footer, code-block ground — with no
 * chart-side counterpart in `docsTheme`. Listed explicitly, not wildcarded,
 * so a genuinely stray/typo'd `--pond-*` token still fails the check below.
 */
const SITE_ONLY_TOKENS = [
  '--pond-bg',
  '--pond-hairline',
  '--pond-accent',
  '--pond-accent-strong',
  '--pond-code-bg',
  '--pond-footer-bg',
];

const css = readFileSync(
  join(__dirname, '../../../website/src/css/custom.css'),
  'utf8',
);

/** Pull the `--pond-*` declarations out of one CSS block. */
function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--pond-[a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const rootBlock = css.slice(
  css.indexOf(':root'),
  css.indexOf("html[data-theme='dark']"),
);
const darkBlock = css.slice(css.indexOf("html[data-theme='dark']"));

describe('docsTheme fixture ↔ website --pond-* tokens', () => {
  const modes = [
    { name: 'light (:root)', block: rootBlock, ramp: docsPalette.light },
    {
      name: "dark ([data-theme='dark'])",
      block: darkBlock,
      ramp: docsPalette.dark,
    },
  ] as const;

  for (const { name, block, ramp } of modes) {
    it(`matches in ${name}`, () => {
      const tokens = tokensIn(block);
      for (const [token, key] of Object.entries(TOKEN_TO_RAMP)) {
        expect(tokens[token], `${token} missing from custom.css`).toBeDefined();
        expect(
          tokens[token]!.toLowerCase().replace(/\s+/g, ' '),
          `${token} diverged from docsPalette.${key}`,
        ).toBe(ramp[key].toLowerCase().replace(/\s+/g, ' '));
      }
    });
  }

  it('has no unmapped --pond-* tokens in the CSS', () => {
    const tokens = { ...tokensIn(rootBlock), ...tokensIn(darkBlock) };
    const unmapped = Object.keys(tokens).filter(
      (t) => !(t in TOKEN_TO_RAMP) && !SITE_ONLY_TOKENS.includes(t),
    );
    expect(
      unmapped,
      'add new chart-mirrored tokens to TOKEN_TO_RAMP + the fixture, or site-only tokens to SITE_ONLY_TOKENS',
    ).toEqual([]);
  });
});
