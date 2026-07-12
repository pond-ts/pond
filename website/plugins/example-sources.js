// @ts-check
const fs = require('fs');
const path = require('path');

/**
 * Single-source live examples (docs plan §9.2): "the code you read is the
 * chart you touch." Each file under `src/examples/*.tsx` is a real,
 * statically-imported React component — MDX pages mount it directly — and
 * this plugin makes that same file's source text available at runtime so
 * `<ChartExample>` can display it as the code block. One file, two uses; no
 * hand-copied snippet can drift from what's actually rendered.
 *
 * `lib/` (shared helpers like the server-metrics generator) is excluded —
 * only the example components themselves are display sources.
 *
 * @param {import('@docusaurus/types').LoadContext} context
 * @returns {import('@docusaurus/types').Plugin}
 */
module.exports = function exampleSourcesPlugin(context) {
  const examplesDir = path.join(context.siteDir, 'src', 'examples');

  return {
    name: 'example-sources',

    async loadContent() {
      if (!fs.existsSync(examplesDir)) return {};
      /** @type {Record<string, string>} */
      const sources = {};
      for (const entry of fs.readdirSync(examplesDir, {
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !/\.tsx$/.test(entry.name)) continue;
        const name = entry.name.replace(/\.tsx$/, '');
        sources[name] = fs.readFileSync(
          path.join(examplesDir, entry.name),
          'utf8',
        );
      }
      return sources;
    },

    async contentLoaded({ content, actions }) {
      actions.setGlobalData(content);
    },

    getPathsToWatch() {
      return [path.join(examplesDir, '*.tsx')];
    },
  };
};
