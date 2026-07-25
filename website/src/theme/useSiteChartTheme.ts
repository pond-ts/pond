import { defaultTheme, useChartTheme, type ChartTheme } from '@pond-ts/charts';

/**
 * Add an alpha channel to a resolved `#rrggbb` custom property. Canvas takes
 * 8-digit hex, so this is the cheapest way to derive a translucent shade of a
 * palette colour without adding a second variable for every opacity we want.
 * Anything that isn't a 6-digit hex passes through untouched.
 */
function fade(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const hex = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${hex}`;
}

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
      // Neutral grey, hairline-thin and part-transparent — not a data hue. For
      // a raw/backdrop trace that a second layer is drawn *through* (raw watts
      // under a moving average). Every viz-N hue competes with the line it's
      // meant to sit behind, and at full opacity dense noise swallows it.
      muted: { color: fade(v('--pond-muted'), 0.55), width: 1 },
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
