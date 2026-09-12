// @ts-check
/**
 * llms.txt / llms-full.txt / llms-<area>.txt generation (docs plan §10;
 * adoption plan [PND-LLMSTXT]).
 *
 * Agents are first-class readers of this site (the project itself is built
 * by them), so the build emits:
 *
 * - `llms.txt` — the llmstxt.org index: site name, summary blockquote, a
 *   short orientation paragraph, then one `##` section per docs area with a
 *   `- [Title](url): description` line per page. Titles and descriptions
 *   come from the docs plugin's loaded metadata (Docusaurus already extracts
 *   an excerpt per page), so an agent can pick the right page before it
 *   fetches anything. An `## Optional` section carries the agent-facing
 *   files that live in the repo rather than on the site (API.md, the agent
 *   guide, the CHANGELOG).
 * - `llms-<area>.txt` — every page of one docs area concatenated (core,
 *   charts, financial, …). Each stays small enough for a single fetch.
 * - `llms-full.txt` — every docs page concatenated, for tools that want the
 *   whole corpus in one request.
 *
 * Dependency-free by design: a local plugin beats an unvetted package for
 * ~150 lines of fs walking and string shaping. The shaping lives in pure
 * functions (`renderIndex`, `areaOf`, …) so it can be exercised without a
 * site build — see `website/scripts/check-llms-txt.mjs`.
 */
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/pond-ts/pond/blob/main';

/**
 * Docs areas, in the order they appear in llms.txt. `match` is tested
 * against the doc's site-relative source path (`docs/pond-ts/…`). Order
 * matters: first match wins, so the on-ramp pages are claimed before the
 * catch-all.
 */
const AREAS = [
  {
    key: 'start',
    title: 'Start here',
    blurb: 'The platform walkthrough and the getting-started build.',
    match: (/** @type {string} */ p) =>
      /^docs\/(introduction|getting-started)\.mdx?$/.test(p),
  },
  {
    key: 'pond-ts',
    title: 'pond-ts (core)',
    blurb:
      'TimeSeries / LiveSeries / ValueSeries: concepts, construction, every batch and live transform.',
    match: (/** @type {string} */ p) => p.startsWith('docs/pond-ts/'),
  },
  {
    key: 'react',
    title: '@pond-ts/react',
    blurb: 'React hooks for owning and subscribing to pond series.',
    match: (/** @type {string} */ p) => p.startsWith('docs/react/'),
  },
  {
    key: 'learn-charts',
    title: 'Learn charts',
    blurb:
      'Nine short chapters from first chart to live charts and non-time axes.',
    match: (/** @type {string} */ p) => p.startsWith('docs/learn-charts/'),
  },
  {
    key: 'charts',
    title: '@pond-ts/charts',
    blurb:
      'Canvas-rendered React charts that read pond series directly: layers, axes, cursors, selection, annotations, theming.',
    match: (/** @type {string} */ p) => p.startsWith('docs/charts/'),
  },
  {
    key: 'financial',
    title: '@pond-ts/financial',
    blurb: 'Technical studies, OHLCV bars, trading calendars.',
    match: (/** @type {string} */ p) => p.startsWith('docs/financial/'),
  },
  {
    key: 'fit',
    title: '@pond-ts/fit',
    blurb: 'Fitness / activity domain: quantities, geo, power, zones.',
    match: (/** @type {string} */ p) => p.startsWith('docs/fit/'),
  },
  {
    key: 'process',
    title: '@pond-ts/process',
    blurb:
      'Computations as data: processing graphs, op registry, caching, provenance. Experimental.',
    match: (/** @type {string} */ p) => p.startsWith('docs/process/'),
  },
  {
    key: 'guides',
    title: 'How-to guides and recipes',
    blurb:
      'End-to-end walkthroughs grounded in working code, plus short recipes.',
    match: (/** @type {string} */ p) =>
      p.startsWith('docs/how-to-guides/') || p.startsWith('docs/recipes/'),
  },
  {
    key: 'reference',
    title: 'Reference',
    blurb: 'Benchmarks and the in-site API reference.',
    match: (/** @type {string} */ p) =>
      p.startsWith('docs/reference/') || p.startsWith('docs/api/'),
  },
  {
    key: 'other',
    title: 'Other pages',
    blurb: '',
    match: () => true,
  },
];

/**
 * @typedef {{ title: string, description: string, permalink: string, source: string }} DocEntry
 *   `source` is site-relative (`docs/pond-ts/creating.mdx`).
 */

/** @param {string} source */
function areaOf(source) {
  const hit = AREAS.find((a) => a.match(source));
  return /** @type {(typeof AREAS)[number]} */ (hit);
}

/**
 * Collapse a Docusaurus excerpt to one line that fits an index entry.
 * @param {string | undefined} text
 */
function oneLine(text) {
  if (!text) return '';
  const flat = text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ') // MDX comments
    .replace(/<[^>]+>/g, ' ') // JSX tags
    .replace(/\s+/g, ' ')
    .replace(/[*_`]/g, '')
    .trim();
  if (flat.length <= 220) return flat;
  const cut = flat.slice(0, 220);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/**
 * First prose paragraph of a docs source file: after the front matter and the
 * H1, skipping imports, MDX comments, JSX blocks and admonition fences.
 * Docusaurus' own excerpt is the first *line* only, which truncates
 * mid-sentence; a whole paragraph reads as a real description.
 * @param {string} body  file contents
 */
function firstParagraph(body) {
  let text = body.replace(/^---[\s\S]*?\n---\n/, '');
  text = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const lines = text.split('\n');
  /** @type {string[]} */
  const para = [];
  let sawHeading = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (para.length === 0) {
      if (line === '') continue;
      if (line.startsWith('#')) {
        sawHeading = true;
        continue;
      }
      if (
        line.startsWith('import ') ||
        line.startsWith('export ') ||
        line.startsWith('<') ||
        line.startsWith(':::') ||
        line.startsWith('```') ||
        line.startsWith('|') ||
        line.startsWith('-') ||
        line.startsWith('>')
      ) {
        continue;
      }
      if (!sawHeading && /^[A-Za-z]/.test(line) === false) continue;
      para.push(line);
    } else {
      if (line === '' || line.startsWith('<') || line.startsWith('```')) break;
      para.push(line);
    }
  }
  return para.join(' ');
}

/**
 * Render the llms.txt index from doc metadata.
 * @param {{ siteUrl: string, title: string, tagline: string }} site
 * @param {DocEntry[]} docs
 * @param {string[]} areaFiles  file names of the per-area dumps that exist
 */
function renderIndex(site, docs, areaFiles) {
  const base = site.siteUrl.replace(/\/$/, '');
  const byArea = new Map();
  for (const d of docs) {
    const a = areaOf(d.source);
    if (!byArea.has(a.key)) byArea.set(a.key, []);
    byArea.get(a.key).push(d);
  }

  const out = [
    `# ${site.title}`,
    '',
    `> ${site.tagline}. Six npm packages that release together: \`pond-ts\` (core batch + streaming series), \`@pond-ts/react\`, \`@pond-ts/charts\`, \`@pond-ts/financial\`, \`@pond-ts/fit\`, \`@pond-ts/process\`.`,
    '',
    'For a coding agent: the shortest route to working code is the agent guide',
    `(\`AGENTS.md\`, also shipped inside every npm tarball) and the export map (\`API.md\`,`,
    'also in every tarball) under Optional below. Each docs area also has a single-file',
    `dump, \`${base}/llms-<area>.txt\`, listed at the end of its section. Schemas are`,
    'declared `as const`; every operator returns a new series; `aggregate` downsamples,',
    '`align` regrids, `rolling` slides.',
    '',
  ];

  for (const a of AREAS) {
    const entries = byArea.get(a.key);
    if (!entries || entries.length === 0) continue;
    out.push(`## ${a.title}`, '');
    if (a.blurb) out.push(a.blurb, '');
    entries.sort((x, y) => x.permalink.localeCompare(y.permalink));
    for (const d of entries) {
      const desc = oneLine(d.description);
      out.push(
        `- [${oneLine(d.title) || d.permalink}](${base}${d.permalink})${desc ? `: ${desc}` : ''}`,
      );
    }
    const dump = `llms-${a.key}.txt`;
    if (areaFiles.includes(dump)) {
      out.push(`- [Full text of this section](${base}/${dump})`);
    }
    out.push('');
  }

  out.push(
    '## Optional',
    '',
    `- [AGENTS.md — using pond from a coding agent](${REPO}/docs/agents/USING_POND.md): which package for which task, the five idioms, the mistakes agents make.`,
    `- [API.md — export map](${REPO}/API.md): every public export across the six packages, one line each, with its source file.`,
    `- [CHANGELOG.md](${REPO}/CHANGELOG.md): what shipped in each release.`,
    `- [Claude Code plugin](${REPO}/plugins/pond-ts/): \`/plugin marketplace add pond-ts/pond\` then \`/plugin install pond-ts@pond-ts\`.`,
    `- [Full docs, one file](${base}/llms-full.txt): every page concatenated (large).`,
    '',
  );
  return out.join('\n');
}

/**
 * Recursively collect .md/.mdx files under a directory.
 * @param {string} dir
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.mdx?$/.test(entry.name)) out.push(p);
  }
  return out.sort();
}

/**
 * Pull `{ title, description, permalink, source }` per doc out of the docs
 * plugin's loaded content. Falls back to a bare route list if the shape we
 * expect is not there (a Docusaurus upgrade, say) — the index degrades to
 * what it was before rather than failing the build.
 * @param {any[]} plugins
 * @param {string[]} routesPaths
 * @param {string} baseUrl
 * @param {string} [siteDir]  when given, descriptions are read from the source files
 * @returns {DocEntry[]}
 */
function collectDocs(plugins, routesPaths, baseUrl, siteDir) {
  const docsPlugin = (plugins || []).find(
    (p) => p && p.name === 'docusaurus-plugin-content-docs',
  );
  const versions = docsPlugin?.content?.loadedVersions;
  if (Array.isArray(versions) && versions.length > 0) {
    /** @type {DocEntry[]} */
    const out = [];
    for (const v of versions) {
      for (const d of v.docs || []) {
        const source = String(d.source || '').replace(/^@site\//, '');
        let description = d.frontMatter?.description || '';
        if (!description && siteDir && source) {
          try {
            description = firstParagraph(
              fs.readFileSync(path.join(siteDir, source), 'utf8'),
            );
          } catch {
            description = '';
          }
        }
        out.push({
          title: d.title || d.id || d.permalink,
          description: description || d.description || '',
          permalink: d.permalink,
          source,
        });
      }
    }
    if (out.length > 0) return out;
  }
  return routesPaths
    .filter((r) => r.startsWith(`${baseUrl}docs`))
    .sort()
    .map((r) => ({ title: r, description: '', permalink: r, source: '' }));
}

/** @returns {import('@docusaurus/types').Plugin} */
module.exports = function llmsTxtPlugin() {
  return {
    name: 'llms-txt',
    async postBuild(props) {
      const { siteConfig, routesPaths, outDir, siteDir } = props;
      const plugins = /** @type {any} */ (props).plugins;
      const site = `${siteConfig.url}${siteConfig.baseUrl}`.replace(/\/$/, '');

      // Per-area and full dumps from the markdown sources.
      const docsDir = path.join(siteDir, 'docs');
      /** @type {Map<string, string[]>} */
      const byArea = new Map();
      /** @type {string[]} */
      const all = [];
      for (const file of walk(docsDir)) {
        const rel = path.relative(docsDir, file);
        if (rel.includes('/_')) continue; // templates
        const body = fs.readFileSync(file, 'utf8');
        const part = `\n\n---\n<!-- source: docs/${rel} -->\n\n${body}`;
        all.push(part);
        const a = areaOf(`docs/${rel}`);
        if (!byArea.has(a.key)) byArea.set(a.key, []);
        byArea.get(a.key)?.push(part);
      }
      /** @type {string[]} */
      const areaFiles = [];
      for (const a of AREAS) {
        const parts = byArea.get(a.key);
        if (!parts || parts.length === 0) continue;
        const name = `llms-${a.key}.txt`;
        fs.writeFileSync(
          path.join(outDir, name),
          `# ${siteConfig.title} — ${a.title}\n${parts.join('')}\n`,
        );
        areaFiles.push(name);
      }
      fs.writeFileSync(
        path.join(outDir, 'llms-full.txt'),
        `# ${siteConfig.title} — full docs content\n${all.join('')}\n`,
      );

      // The index, from the docs plugin's metadata (real permalinks, titles,
      // descriptions).
      const docs = collectDocs(
        plugins,
        routesPaths,
        siteConfig.baseUrl,
        siteDir,
      );
      fs.writeFileSync(
        path.join(outDir, 'llms.txt'),
        renderIndex(
          {
            siteUrl: site,
            title: siteConfig.title,
            tagline: siteConfig.tagline || '',
          },
          docs,
          areaFiles,
        ),
      );
    },
  };
};

module.exports.renderIndex = renderIndex;
module.exports.collectDocs = collectDocs;
module.exports.areaOf = areaOf;
module.exports.firstParagraph = firstParagraph;
module.exports.oneLine = oneLine;
module.exports.AREAS = AREAS;
