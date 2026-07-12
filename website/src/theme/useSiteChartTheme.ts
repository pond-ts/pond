import { defaultTheme, useChartTheme, type ChartTheme } from '@pond-ts/charts';

/**
 * The theme every live chart embed on the docs site renders with —
 * `docsTheme`, but built live from the site's own `--pond-*` CSS custom
 * properties (defined in `src/css/custom.css`, mirroring
 * `packages/charts/src/docs-theme.fixture.ts`) rather than imported
 * directly. `docsTheme` is a dev-only Storybook fixture, excluded from the
 * published `@pond-ts/charts` build — the docs site is a consumer, and
 * consumers own their themes; this hook *is* that ownership.
 *
 * Dogfoods the exact bridge the Theming page documents: `useChartTheme`
 * re-resolves whenever the `data-theme` toggle flips, so every embed follows
 * the site's dark/light mode with no `mode` prop threaded through.
 */
export function useSiteChartTheme(): ChartTheme {
  return useChartTheme(defaultTheme, (v) => ({
    background: v('--pond-surface'),
    line: {
      default: { color: v('--pond-viz-1') },
      primary: { color: v('--pond-viz-1') },
      secondary: { color: v('--pond-viz-2') },
      context: { color: v('--pond-viz-3') },
      fast: { color: v('--pond-viz-1') },
      slow: { color: v('--pond-viz-4') },
    },
    band: {
      default: { fill: v('--pond-viz-1') },
      outer: { fill: v('--pond-viz-1') },
      inner: { fill: v('--pond-viz-1') },
    },
    area: {
      default: { color: v('--pond-viz-1'), fill: v('--pond-viz-1') },
      in: { color: v('--pond-viz-1'), fill: v('--pond-viz-1') },
      out: { color: v('--pond-viz-4'), fill: v('--pond-viz-4') },
    },
    scatter: {
      default: { color: v('--pond-viz-1'), label: v('--pond-ink') },
      primary: { color: v('--pond-viz-1'), label: v('--pond-ink') },
      secondary: { color: v('--pond-viz-2'), label: v('--pond-ink') },
    },
    box: {
      default: {
        fill: v('--pond-viz-1'),
        stroke: v('--pond-viz-1'),
        median: v('--pond-ink'),
        whisker: v('--pond-body'),
      },
    },
    candle: {
      default: {
        rising: { body: v('--pond-viz-up'), wick: v('--pond-viz-up') },
        falling: { body: v('--pond-viz-down'), wick: v('--pond-viz-down') },
      },
    },
    bar: {
      default: { fill: v('--pond-viz-1'), highlight: v('--pond-viz-2') },
      secondary: { fill: v('--pond-viz-2'), highlight: v('--pond-viz-1') },
    },
    axis: {
      label: v('--pond-body'),
      grid: v('--pond-viz-grid'),
      gridDash: [],
      sessionDivider: v('--pond-viz-divider'),
      title: { color: v('--pond-ink') },
    },
    cursor: v('--pond-body'),
    chip: { background: v('--pond-surface-2') },
    annotation: { color: v('--pond-viz-mark') },
  }));
}
