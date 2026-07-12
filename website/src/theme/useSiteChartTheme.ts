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
    background: v('--pond-chart-bg'),
    line: {
      default: { color: v('--pond-blue') },
      primary: { color: v('--pond-blue') },
      secondary: { color: v('--pond-amber') },
      context: { color: v('--pond-teal') },
      fast: { color: v('--pond-blue') },
      slow: { color: v('--pond-rose') },
    },
    band: {
      default: { fill: v('--pond-blue') },
      outer: { fill: v('--pond-blue') },
      inner: { fill: v('--pond-blue') },
    },
    area: {
      default: { color: v('--pond-blue'), fill: v('--pond-blue') },
      in: { color: v('--pond-blue'), fill: v('--pond-blue') },
      out: { color: v('--pond-rose'), fill: v('--pond-rose') },
    },
    scatter: {
      default: { color: v('--pond-blue'), label: v('--pond-ink') },
      primary: { color: v('--pond-blue'), label: v('--pond-ink') },
      secondary: { color: v('--pond-amber'), label: v('--pond-ink') },
    },
    box: {
      default: {
        fill: v('--pond-blue'),
        stroke: v('--pond-blue'),
        median: v('--pond-ink'),
        whisker: v('--pond-label'),
      },
    },
    candle: {
      default: {
        rising: { body: v('--pond-rising'), wick: v('--pond-rising') },
        falling: { body: v('--pond-falling'), wick: v('--pond-falling') },
      },
    },
    bar: {
      default: { fill: v('--pond-blue'), highlight: v('--pond-amber') },
      secondary: { fill: v('--pond-amber'), highlight: v('--pond-blue') },
    },
    axis: {
      label: v('--pond-label'),
      grid: v('--pond-grid'),
      gridDash: [],
      sessionDivider: v('--pond-divider'),
      title: { color: v('--pond-ink') },
    },
    cursor: v('--pond-label'),
    chip: { background: v('--pond-chip') },
    annotation: { color: v('--pond-mark') },
  }));
}
