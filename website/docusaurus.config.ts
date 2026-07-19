import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { pondCodeTheme } from './src/prism-pond-theme';

const config: Config = {
  title: 'Pond',
  tagline:
    'Time-series analytics and live visualization for TypeScript — one typed platform',
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
        redirects: [],
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
          to: '/api',
          label: 'API',
          position: 'left',
        },
        {
          href: 'https://www.npmjs.com/package/pond-ts',
          label: 'npm',
          position: 'right',
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
              to: '/docs/start-here/getting-started',
            },
            {
              label: 'pond-ts (core)',
              to: '/docs/pond-ts',
            },
            {
              label: 'API Reference',
              to: '/api',
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
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
