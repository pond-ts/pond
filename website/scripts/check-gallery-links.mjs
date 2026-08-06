// Fail the docs build if a gallery card links to a Storybook story that does
// not exist.
//
// Five cards had rotted this way — `charts-areachart--baseline`,
// `charts-areachart--stacked`, `charts-linechart--gaps` and
// `indicators-y-axis--live` all pointed at IDs with no story behind them. The
// links render fine and only break when someone clicks, so nothing surfaced it
// until a reader reported the gallery. Renaming or removing a story is exactly
// the kind of ordinary change that breaks these, and it happens in a different
// package from the links.
//
// Runs in `prebuild`, so the `docs-build` CI job catches it on the PR.
//
//   node website/scripts/check-gallery-links.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const GALLERY = join(repo, 'website', 'docs', 'charts', 'gallery.mdx');
const STORIES = join(repo, 'packages', 'charts', 'src');

/**
 * Storybook's ID derivation, which is asymmetric and easy to get wrong: a
 * **title** is only lowercased with non-alphanumerics collapsed (so
 * `Charts/BarChart` → `charts-barchart`, NOT `charts-bar-chart`), while an
 * **export name** is additionally split on camelCase humps (`PowerDistribution`
 * → `power-distribution`). Splitting the title too reports ~2/3 of a healthy
 * gallery as broken.
 */
const titleId = (s) =>
  s
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
const nameId = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');

const ids = new Set();
for (const file of readdirSync(STORIES).filter((f) =>
  f.endsWith('.stories.tsx'),
)) {
  const src = readFileSync(join(STORIES, file), 'utf8');
  const title = src.match(/title:\s*['"]([^'"]+)['"]/)?.[1];
  if (!title) continue;
  for (const [, name] of src.matchAll(/^export const (\w+)/gm)) {
    if (name !== 'default') ids.add(`${titleId(title)}--${nameId(name)}`);
  }
}

if (ids.size === 0) {
  console.error(
    'check-gallery-links: found no stories — the derivation or the path is wrong,\n' +
      `  looked in ${STORIES}\n` +
      '  (failing loudly rather than reporting every link healthy)',
  );
  process.exit(1);
}

const gallery = readFileSync(GALLERY, 'utf8');
const refs = [
  ...gallery.matchAll(
    /storybookHref="pathname:\/\/\/storybook\/\?path=\/story\/([^"]+)"/g,
  ),
].map((m) => m[1]);

const broken = [...new Set(refs.filter((r) => !ids.has(r)))].sort();

if (broken.length > 0) {
  console.error(
    `check-gallery-links: ${broken.length} gallery card(s) link to a story that does not exist:\n` +
      broken.map((b) => `  - ${b}`).join('\n') +
      '\n\nFix the `storybookHref` in website/docs/charts/gallery.mdx, or drop it\n' +
      '(it is optional) when the card shows a composition no single story covers.',
  );
  process.exit(1);
}

console.log(
  `check-gallery-links: ${refs.length} gallery link(s) OK against ${ids.size} stories`,
);
