import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    // Platform on-ramp — two top-level pages before the core section.
    'introduction',
    'getting-started',
    {
      type: 'category',
      label: 'pond-ts (core)',
      link: { type: 'doc', id: 'pond-ts/pond-ts-index' },
      items: [
        'pond-ts/introduction',
        'pond-ts/mental-model',
        {
          type: 'category',
          label: 'Concepts',
          link: { type: 'doc', id: 'pond-ts/concepts/index' },
          items: [
            'pond-ts/concepts/temporal-keys',
            'pond-ts/concepts/sequences',
            'pond-ts/concepts/series',
            'pond-ts/concepts/temporal-relations',
            'pond-ts/concepts/windowing',
            'pond-ts/concepts/triggers',
            'pond-ts/concepts/partitioning',
            'pond-ts/concepts/late-data',
            'pond-ts/concepts/value-axis',
          ],
        },
        'pond-ts/creating',
        {
          type: 'category',
          label: 'TimeSeries deep dive',
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
          label: 'LiveSeries deep dive',
          items: [
            'pond-ts/live/live-series',
            'pond-ts/live/live-transforms',
            'pond-ts/live/triggering',
          ],
        },
        'pond-ts/value-series',
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
          href: '/docs/api/',
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
      label: '@pond-ts/financial',
      link: { type: 'doc', id: 'financial/financial-index' },
      items: [
        {
          type: 'link',
          label: 'API reference (financial)',
          href: 'pathname:///generated-api/financial/',
        },
      ],
    },
    {
      type: 'category',
      label: '@pond-ts/charts',
      link: { type: 'doc', id: 'charts/charts-index' },
      items: [
        {
          type: 'category',
          label: 'Gallery',
          link: { type: 'doc', id: 'charts/gallery' },
          // One page per chart, `charts/gallery/<slug>` — the build-it
          // tutorial each card's "Build it →" link opens. Each track appends
          // its own slugs here, grouped as they are on the Gallery page;
          // `_template.mdx` is the shape they all follow.
          items: [
            // Track A — ops & infrastructure.
            'charts/gallery/network-traffic',
            'charts/gallery/traffic-by-interface',
            'charts/gallery/multi-host-cpu',
            'charts/gallery/latency-percentiles',
            'charts/gallery/sla-incidents',
            'charts/gallery/live-tail',
            'charts/gallery/site-traffic-dashboard',
            'charts/gallery/volume-history',
            // Track B — finance.
            'charts/gallery/candlestick',
            'charts/gallery/price-volume',
            'charts/gallery/bollinger-bands',
            'charts/gallery/drawdown',
            // Track C — weather & climate.
            'charts/gallery/temperature-range',
            'charts/gallery/rainfall',
            'charts/gallery/climate-stripes',
            'charts/gallery/wind-rose',
            // Track D — Energy
            'charts/gallery/grid-mix',
            'charts/gallery/renewables-vs-demand',
            'charts/gallery/negative-prices',
            'charts/gallery/eclipse-demand',
            'charts/gallery/eclipse-solar',
            // Track F — science & measurement.
            'charts/gallery/nino34',
            'charts/gallery/measles',
          ],
        },
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
            'learn-charts/cursors-readouts-zoom',
            'learn-charts/marking-up-charts',
            'learn-charts/live-charts',
            'learn-charts/beyond-the-time-axis',
          ],
        },
        {
          type: 'category',
          label: 'Axes',
          link: { type: 'doc', id: 'charts/axes/charts-axes-index' },
          items: [
            'charts/axes/value-axis',
            'charts/axes/category-axis',
            'charts/axes/trading-time-axis',
            'charts/axes/duration-axis',
          ],
        },
        'charts/layout',
        {
          type: 'category',
          label: 'Chart types',
          link: { type: 'doc', id: 'charts/types/charts-types-index' },
          items: [
            'charts/types/linechart',
            'charts/types/areachart',
            'charts/types/bandchart',
            'charts/types/scatterchart',
            'charts/types/barchart',
            'charts/types/boxplot',
            'charts/types/candlestick',
          ],
        },
        {
          type: 'category',
          label: 'Interaction',
          items: [
            'charts/interaction/cursors-and-readouts',
            'charts/interaction/selection-and-hover',
            'charts/interaction/legend',
            'charts/interaction/pan-zoom-and-range-selection',
          ],
        },
        {
          type: 'category',
          label: 'Annotations & indicators',
          items: [
            'charts/annotations/the-annotation-model',
            'charts/annotations/region-baseline-marker',
            'charts/annotations/editing-and-creating',
            'charts/annotations/axis-indicators-and-live-values',
          ],
        },
        'charts/gaps',
        'charts/financial',
        'charts/theming',
        'charts/cheat-sheet',
        {
          type: 'link',
          label: 'API reference (charts)',
          href: '/docs/api/',
        },
      ],
    },
    {
      type: 'category',
      label: '@pond-ts/process',
      link: { type: 'doc', id: 'process/process-index' },
      items: [
        'process/tutorial',
        'process/authoring',
        'process/requests',
        'process/plans',
        'process/registry',
        'process/host',
        'process/performance',
        {
          type: 'link',
          label: 'API reference (process)',
          href: 'pathname:///generated-api/process/',
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
        'recipes/responsive-width',
        'recipes/resizable-panels',
        'recipes/using-charts',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      link: { type: 'doc', id: 'reference/reference-index' },
      items: [
        'reference/benchmarks',
        'reference/charts-benchmarks',
        'reference/charts-scale-benchmarks',
      ],
    },
    {
      type: 'category',
      label: 'API reference',
      link: { type: 'doc', id: 'api/index' },
      items: [
        {
          type: 'category',
          label: 'pond-ts (core)',
          items: [
            'api/core/time',
            'api/core/time-range',
            'api/core/interval',
            'api/core/event',
            'api/core/sequence',
            'api/core/bounded-sequence',
            'api/core/time-series',
            'api/core/partitioned-time-series',
            'api/core/value-series',
            'api/core/live-series',
            'api/core/live-view',
            'api/core/live-partitioned-series',
            'api/core/live-partitioned-view',
            'api/core/functions',
          ],
        },
        {
          type: 'category',
          label: '@pond-ts/charts',
          items: [
            {
              type: 'category',
              label: 'Structure',
              items: [
                'api/charts/chart-container',
                'api/charts/chart-row',
                'api/charts/layers',
                'api/charts/x-axis',
                'api/charts/y-axis',
                'api/charts/canvas',
                'api/charts/time-axis',
                'api/charts/category-axis',
              ],
            },
            {
              type: 'category',
              label: 'Draw layers',
              items: [
                'api/charts/line-chart',
                'api/charts/area-chart',
                'api/charts/band-chart',
                'api/charts/bar-chart',
                'api/charts/scatter-chart',
                'api/charts/box-plot',
                'api/charts/candlestick',
              ],
            },
            {
              type: 'category',
              label: 'Annotations',
              items: [
                'api/charts/baseline',
                'api/charts/marker',
                'api/charts/region',
                'api/charts/y-axis-indicator',
              ],
            },
            {
              type: 'category',
              label: 'Functions',
              items: [
                'api/charts/data-adapters',
                'api/charts/theming',
                'api/charts/scales-and-live',
              ],
            },
          ],
        },
      ],
    },
  ],
};

export default sidebars;
