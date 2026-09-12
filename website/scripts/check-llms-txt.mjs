// Exercises the pure shaping functions of plugins/llms-txt.js without a
// site build: area routing, index rendering, and the metadata fallback.
// Run: node scripts/check-llms-txt.mjs  (exits non-zero on a failed check)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  renderIndex,
  collectDocs,
  areaOf,
  firstParagraph,
  oneLine,
} = require('../plugins/llms-txt.js');

// Area routing — first match wins, on-ramp pages before the catch-all.
assert.equal(areaOf('docs/introduction.mdx').key, 'start');
assert.equal(areaOf('docs/getting-started.mdx').key, 'start');
assert.equal(areaOf('docs/pond-ts/transforms/rolling.mdx').key, 'pond-ts');
assert.equal(
  areaOf('docs/learn-charts/01-your-first-chart.mdx').key,
  'learn-charts',
);
assert.equal(areaOf('docs/charts/cheat-sheet.mdx').key, 'charts');
assert.equal(areaOf('docs/recipes/cpu-metrics.mdx').key, 'guides');
assert.equal(areaOf('docs/api/core/index.mdx').key, 'reference');
assert.equal(areaOf('docs/somewhere-new.mdx').key, 'other');

// Metadata path — the docs plugin's loaded content is the source of truth.
const plugins = [
  {
    name: 'docusaurus-plugin-content-docs',
    content: {
      loadedVersions: [
        {
          docs: [
            {
              id: 'pond-ts/transforms/rolling',
              title: 'Rolling Windows',
              description:
                'Sliding-window computations over ordered events. For each event in\nthe source, look at a window of nearby events and compute a **reducer**.',
              permalink: '/docs/pond-ts/transforms/rolling',
              source: '@site/docs/pond-ts/transforms/rolling.mdx',
            },
            {
              id: 'introduction',
              title: 'pond-ts',
              description: 'Typed time-series primitives for TypeScript.',
              permalink: '/docs/',
              source: '@site/docs/introduction.mdx',
            },
          ],
        },
      ],
    },
  },
];
const docs = collectDocs(plugins, ['/docs/', '/docs/x'], '/');
assert.equal(docs.length, 2);
assert.equal(docs[0].source, 'docs/pond-ts/transforms/rolling.mdx');

const index = renderIndex(
  {
    siteUrl: 'https://pond-ts.org',
    title: 'Pond',
    tagline: 'Typed time series',
  },
  docs,
  ['llms-pond-ts.txt', 'llms-start.txt'],
);
assert.match(index, /^# Pond\n/);
assert.match(index, /^## Start here$/m);
assert.match(index, /^## pond-ts \(core\)$/m);
assert.match(
  index,
  /- \[Rolling Windows\]\(https:\/\/pond-ts\.org\/docs\/pond-ts\/transforms\/rolling\): Sliding-window computations over ordered events\. For each event in the source, look at a window of nearby events and compute a reducer\./,
  'description is collapsed to one line with markdown emphasis stripped',
);
assert.match(index, /\(https:\/\/pond-ts\.org\/llms-pond-ts\.txt\)/);
assert.doesNotMatch(
  index,
  /llms-charts\.txt/,
  'no link to a dump that was not written',
);
assert.match(index, /^## Optional$/m);
assert.match(index, /docs\/agents\/USING_POND\.md/);
assert.match(index, /API\.md/);

// Fallback path — no docs plugin content → bare route list, build still succeeds.
const fallback = collectDocs(
  [],
  ['/docs/', '/docs/b', '/blog/x', '/docs/a'],
  '/',
);
assert.deepEqual(
  fallback.map((d) => d.permalink),
  ['/docs/', '/docs/a', '/docs/b'],
);
const fallbackIndex = renderIndex(
  { siteUrl: 'https://pond-ts.org', title: 'Pond', tagline: 't' },
  fallback,
  [],
);
assert.match(fallbackIndex, /^## Other pages$/m);

// Description shaping — MDX comments and JSX never leak; long text cuts at a word.
assert.equal(
  oneLine('{/* TODO: rewrite */}\n\nTyped **time-series** primitives.'),
  'Typed time-series primitives.',
);
assert.equal(oneLine('<Hero />\nA line.'), 'A line.');
assert.match(oneLine('word '.repeat(80)), /…$/);
const src = `---
title: Rolling
---

import X from '@site/x';

{/* editorial note */}

# Rolling Windows

Sliding-window computations over ordered events. For each event in
the source, look at a window of nearby events.

Second paragraph is not included.
`;
assert.equal(
  firstParagraph(src),
  'Sliding-window computations over ordered events. For each event in the source, look at a window of nearby events.',
);
assert.equal(firstParagraph('---\na: b\n---\n\n<Only />\n'), '');

console.log('llms-txt shaping: all checks passed');
