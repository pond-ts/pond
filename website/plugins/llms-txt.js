// @ts-check
/**
 * llms.txt / llms-full.txt generation (docs plan §10).
 *
 * Agents are first-class readers of this site (the project itself is built
 * by them), so the build emits:
 *
 * - `llms.txt` — the llmstxt.org-style index: site name, one line per docs
 *   route (accurate final URLs, straight from the router).
 * - `llms-full.txt` — every docs page's markdown source concatenated, with
 *   a path header per page, for single-fetch ingestion.
 *
 * Dependency-free by design: a local plugin beats an unvetted package for
 * ~60 lines of fs walking.
 */
const fs = require('fs');
const path = require('path');

/** Recursively collect .md/.mdx files under a directory. */
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

/** @returns {import('@docusaurus/types').Plugin} */
module.exports = function llmsTxtPlugin() {
  return {
    name: 'llms-txt',
    async postBuild({ siteConfig, routesPaths, outDir, siteDir }) {
      const site = `${siteConfig.url}${siteConfig.baseUrl}`.replace(/\/$/, '');

      // llms.txt — the index, from the real router output.
      const docRoutes = routesPaths
        .filter((r) => r.startsWith(`${siteConfig.baseUrl}docs`))
        .sort();
      const index = [
        `# ${siteConfig.title}`,
        '',
        `> ${siteConfig.tagline}`,
        '',
        '## Docs',
        '',
        ...docRoutes.map((r) => `- ${siteConfig.url}${r}`),
        '',
        '## Full content',
        '',
        `- ${site}/llms-full.txt`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(outDir, 'llms.txt'), index);

      // llms-full.txt — concatenated markdown sources.
      const docsDir = path.join(siteDir, 'docs');
      const parts = walk(docsDir).map((file) => {
        const rel = path.relative(docsDir, file);
        const body = fs.readFileSync(file, 'utf8');
        return `\n\n---\n<!-- source: docs/${rel} -->\n\n${body}`;
      });
      fs.writeFileSync(
        path.join(outDir, 'llms-full.txt'),
        `# ${siteConfig.title} — full docs content\n${parts.join('')}\n`,
      );
    },
  };
};
