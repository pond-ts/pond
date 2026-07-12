import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Start here',
      items: [
        'start-here/intro',
        'start-here/getting-started',
        {
          type: 'category',
          label: 'Concepts',
          link: { type: 'doc', id: 'start-here/concepts/index' },
          items: [
            'start-here/concepts/temporal-keys',
            'start-here/concepts/sequences',
            'start-here/concepts/series',
            'start-here/concepts/temporal-relations',
            'start-here/concepts/windowing',
            'start-here/concepts/triggers',
            'start-here/concepts/partitioning',
            'start-here/concepts/late-data',
            'start-here/concepts/value-axis',
          ],
        },
        'start-here/creating',
      ],
    },
    {
      type: 'category',
      label: 'pond-ts (core)',
      link: { type: 'doc', id: 'pond-ts/pond-ts-index' },
      items: [
        {
          type: 'category',
          label: 'TimeSeries',
          items: [
            'pond-ts/transforms/queries',
            'pond-ts/transforms/transformations',
            'pond-ts/transforms/alignment',
            'pond-ts/transforms/aggregation',
            'pond-ts/transforms/reshape',
            'pond-ts/transforms/rolling',
            'pond-ts/transforms/sampling',
            'pond-ts/transforms/smoothing',
            'pond-ts/transforms/anomaly-detection',
            'pond-ts/transforms/cleaning',
            'pond-ts/transforms/reducer-reference',
          ],
        },
        {
          type: 'category',
          label: 'LiveSeries',
          items: [
            'pond-ts/live/live-series',
            'pond-ts/live/live-transforms',
            'pond-ts/live/triggering',
          ],
        },
        {
          type: 'category',
          label: 'Advanced',
          items: [
            'pond-ts/advanced/columns',
            'pond-ts/advanced/charting',
            'pond-ts/advanced/arrays',
          ],
        },
        {
          type: 'link',
          label: 'API reference (core)',
          href: 'pathname:///generated-api/core/',
        },
      ],
    },
    {
      type: 'category',
      label: '@pond-ts/react',
      link: { type: 'doc', id: 'react/react-index' },
      items: [
        'react/concepts',
        'react/hooks',
        'react/patterns',
        {
          type: 'link',
          label: 'API reference (react)',
          href: 'pathname:///generated-api/react/',
        },
      ],
    },
    {
      type: 'category',
      label: '@pond-ts/fit',
      link: { type: 'doc', id: 'fit/fit-index' },
      items: [
        {
          type: 'link',
          label: 'API reference (fit)',
          href: 'pathname:///generated-api/fit/',
        },
      ],
    },
    {
      type: 'category',
      label: '@pond-ts/charts',
      link: { type: 'doc', id: 'charts/charts-index' },
      items: [
        'charts/gallery',
        {
          type: 'category',
          label: 'Learn charts',
          link: { type: 'doc', id: 'learn-charts/learn-charts-index' },
          items: [
            'learn-charts/your-first-chart',
            'learn-charts/anatomy-of-a-chart',
            'learn-charts/feeding-charts-pond-data',
            'learn-charts/shaping-data-to-chart',
            'learn-charts/styling-and-theming',
          ],
        },
        {
          type: 'link',
          label: 'API reference (charts)',
          href: 'pathname:///generated-api/charts/',
        },
      ],
    },
    {
      type: 'category',
      label: 'How-to guides',
      link: { type: 'doc', id: 'how-to-guides/how-to-guides-index' },
      items: [
        'how-to-guides/dashboard-guide',
        'how-to-guides/ingesting-messy-data',
        'how-to-guides/histograms',
        'how-to-guides/categorical-charts',
      ],
    },
    {
      type: 'category',
      label: 'Recipes',
      link: { type: 'doc', id: 'recipes/recipes-index' },
      items: [
        'recipes/telemetry-reporting',
        'recipes/streaming-dashboard',
        'recipes/streaming-baseline',
        'recipes/cpu-metrics',
        'recipes/error-rate-dashboard',
        'recipes/resizable-panels',
        'recipes/using-charts',
        'recipes/theming',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      link: { type: 'doc', id: 'reference/reference-index' },
      items: ['reference/benchmarks'],
    },
  ],
};

export default sidebars;
