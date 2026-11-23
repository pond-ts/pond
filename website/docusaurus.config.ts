import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { pondCodeTheme } from './src/prism-pond-theme';

const config: Config = {
  title: 'Pond',
  tagline:
    'Time series analysis with the same answers in TypeScript, Rust and Python',
  favicon: 'img/pond-favicon.svg',
  future: {
    v4: true,
  },
  url: 'https://pond-ts.org',
  baseUrl: '/',
  organizationName: 'pond-ts',
  projectName: 'pond',
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/pond-ts/pond/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themes: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        // Index docs + the standalone pages; typedoc sub-sites keep their
        // own scoped search.
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: '/docs',
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // Standing rule (docs plan §4): re-homed pages keep or redirect
        // their slugs. Entries accumulate as pages move.
        redirects: [
          // The API reference moved in-site (docs/api/); /api bookmarks live on.
          { from: '/api', to: '/docs/api/' },
          // Core-IA restructure: "Start here" became a platform on-ramp; the
          // core mental-model pages (Concepts, Creating series) moved into
          // pond-ts (core), and Getting started went top-level.
          {
            from: '/docs/start-here/getting-started',
            to: '/docs/getting-started',
          },
          { from: '/docs/start-here/creating', to: '/docs/series/creating' },
          { from: '/docs/start-here/concepts', to: '/docs/concepts/' },
          {
            from: '/docs/start-here/concepts/temporal-keys',
            to: '/docs/concepts/temporal-keys',
          },
          {
            from: '/docs/start-here/concepts/sequences',
            to: '/docs/concepts/sequences',
          },
          {
            from: '/docs/start-here/concepts/series',
            to: '/docs/concepts/series',
          },
          {
            from: '/docs/start-here/concepts/temporal-relations',
            to: '/docs/concepts/temporal-relations',
          },
          {
            from: '/docs/start-here/concepts/windowing',
            to: '/docs/concepts/windowing',
          },
          {
            from: '/docs/start-here/concepts/triggers',
            to: '/docs/concepts/triggers',
          },
          {
            from: '/docs/start-here/concepts/partitioning',
            to: '/docs/concepts/partitioning',
          },
          {
            from: '/docs/start-here/concepts/late-data',
            to: '/docs/concepts/late-data',
          },
          {
            from: '/docs/start-here/concepts/value-axis',
            to: '/docs/concepts/value-axis',
          },
          // Docs for every language (2026-11): the shared pages left the
          // TypeScript package's folder, and each language got its own.
          { from: '/docs/financial', to: '/docs/finance/' },
          { from: '/docs/pond-rs', to: '/docs/rust/' },
          { from: '/docs/pond-rs/arrow', to: '/docs/rust/arrow' },
          {
            from: '/docs/pond-rs/coming-from-pond-ts',
            to: '/docs/rust/coming-from-pond-ts',
          },
          {
            from: '/docs/pond-rs/finance-studies',
            to: '/docs/rust/finance-studies',
          },
          {
            from: '/docs/pond-rs/getting-started',
            to: '/docs/rust/getting-started',
          },
          { from: '/docs/pond-rs/javascript', to: '/docs/javascript/' },
          { from: '/docs/pond-rs/live', to: '/docs/rust/live' },
          { from: '/docs/pond-rs/operations', to: '/docs/rust/operations' },
          { from: '/docs/pond-rs/partitions', to: '/docs/rust/partitions' },
          { from: '/docs/pond-rs/performance', to: '/docs/rust/performance' },
          { from: '/docs/pond-rs/python', to: '/docs/python/' },
          {
            from: '/docs/pond-rs/series-and-columns',
            to: '/docs/rust/series-and-columns',
          },
          { from: '/docs/pond-ts', to: '/docs/typescript/' },
          { from: '/docs/pond-ts/advanced/arrays', to: '/docs/series/arrays' },
          {
            from: '/docs/pond-ts/advanced/charting',
            to: '/docs/series/other-chart-libraries',
          },
          {
            from: '/docs/pond-ts/advanced/columns',
            to: '/docs/series/columns',
          },
          { from: '/docs/pond-ts/concepts', to: '/docs/concepts/' },
          {
            from: '/docs/pond-ts/concepts/late-data',
            to: '/docs/concepts/late-data',
          },
          {
            from: '/docs/pond-ts/concepts/partitioning',
            to: '/docs/concepts/partitioning',
          },
          {
            from: '/docs/pond-ts/concepts/sequences',
            to: '/docs/concepts/sequences',
          },
          {
            from: '/docs/pond-ts/concepts/series',
            to: '/docs/concepts/series',
          },
          {
            from: '/docs/pond-ts/concepts/temporal-keys',
            to: '/docs/concepts/temporal-keys',
          },
          {
            from: '/docs/pond-ts/concepts/temporal-relations',
            to: '/docs/concepts/temporal-relations',
          },
          {
            from: '/docs/pond-ts/concepts/triggers',
            to: '/docs/concepts/triggers',
          },
          {
            from: '/docs/pond-ts/concepts/value-axis',
            to: '/docs/concepts/value-axis',
          },
          {
            from: '/docs/pond-ts/concepts/windowing',
            to: '/docs/concepts/windowing',
          },
          { from: '/docs/pond-ts/creating', to: '/docs/series/creating' },
          { from: '/docs/pond-ts/introduction', to: '/docs/typescript/' },
          {
            from: '/docs/pond-ts/live/live-series',
            to: '/docs/live/live-series',
          },
          {
            from: '/docs/pond-ts/live/live-transforms',
            to: '/docs/live/live-transforms',
          },
          {
            from: '/docs/pond-ts/live/triggering',
            to: '/docs/live/triggering',
          },
          {
            from: '/docs/pond-ts/mental-model',
            to: '/docs/concepts/mental-model',
          },
          {
            from: '/docs/pond-ts/transforms/aggregation',
            to: '/docs/series/aggregation',
          },
          {
            from: '/docs/pond-ts/transforms/alignment',
            to: '/docs/series/alignment',
          },
          {
            from: '/docs/pond-ts/transforms/anomaly-detection',
            to: '/docs/series/anomaly-detection',
          },
          {
            from: '/docs/pond-ts/transforms/cleaning',
            to: '/docs/series/cleaning',
          },
          {
            from: '/docs/pond-ts/transforms/expressions',
            to: '/docs/series/expressions',
          },
          {
            from: '/docs/pond-ts/transforms/queries',
            to: '/docs/series/queries',
          },
          {
            from: '/docs/pond-ts/transforms/reducer-reference',
            to: '/docs/series/reducer-reference',
          },
          {
            from: '/docs/pond-ts/transforms/reshape',
            to: '/docs/series/reshape',
          },
          {
            from: '/docs/pond-ts/transforms/rolling',
            to: '/docs/series/rolling',
          },
          {
            from: '/docs/pond-ts/transforms/sampling',
            to: '/docs/series/sampling',
          },
          {
            from: '/docs/pond-ts/transforms/smoothing',
            to: '/docs/series/smoothing',
          },
          {
            from: '/docs/pond-ts/transforms/transformations',
            to: '/docs/series/transformations',
          },
          {
            from: '/docs/pond-ts/value-series',
            to: '/docs/series/value-series',
          },
        ],
      },
    ],
    './plugins/llms-txt.js',
    './plugins/example-sources.js',
  ],
  themeConfig: {
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Pond',
      logo: {
        alt: 'Pond logo',
        src: 'img/pond-mark-light.svg',
        srcDark: 'img/pond-mark-dark.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'dropdown',
          label: 'API',
          position: 'left',
          items: [
            { label: 'TypeScript', to: '/docs/api/' },
            { label: 'Rust (docs.rs)', href: 'https://docs.rs/pond-rs' },
            { label: 'Python', to: '/docs/python/api/' },
          ],
        },
        {
          type: 'dropdown',
          label: 'Install',
          position: 'right',
          items: [
            {
              label: 'npm: pond-ts',
              href: 'https://www.npmjs.com/package/pond-ts',
            },
            {
              label: 'crates.io: pond-rs',
              href: 'https://crates.io/crates/pond-rs',
            },
            {
              label: 'PyPI: pond-timeseries',
              href: 'https://pypi.org/project/pond-timeseries/',
            },
          ],
        },
        {
          href: 'https://github.com/pond-ts/pond',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Getting Started',
              to: '/docs/getting-started',
            },
            {
              label: 'Choose your language',
              to: '/docs/languages',
            },
            {
              label: 'TypeScript',
              to: '/docs/typescript/',
            },
            {
              label: 'Rust',
              to: '/docs/rust/',
            },
            {
              label: 'Python',
              to: '/docs/python/',
            },
          ],
        },
        {
          title: 'Project',
          items: [
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/pond-ts',
            },
            {
              label: 'crates.io',
              href: 'https://crates.io/crates/pond-rs',
            },
            {
              label: 'PyPI',
              href: 'https://pypi.org/project/pond-timeseries/',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/pond-ts/pond',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Peter Murphy. Built with Docusaurus.`,
    },
    prism: {
      // Code blocks are always the brand's dark-teal "terminal chip" — one
      // ground regardless of site theme (brand spec §05: "CODE BLOCK bg
      // #0C1A1A ... teal keywords"), not a light/dark pair.
      theme: pondCodeTheme,
      darkTheme: pondCodeTheme,
      // Rust and TOML for the pond-rs pages (rust ships in the default set).
      additionalLanguages: ['toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
