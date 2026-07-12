/**
 * `docsTheme` — the one look for everything the project itself renders.
 *
 * Every Storybook story (except the theming-demonstration stories, whose whole
 * point is contrast) and every docs-site chart embed renders with this theme,
 * light or dark, so the deployed Storybook, the docs images, and the live
 * embeds read as one designed system (PLAN.md → Docs site wave, "One look").
 * The aesthetic register is the neutral, professional dark-grey/light
 * trading-terminal pairing.
 *
 * Contract:
 *
 * - **Dev-only.** This is a `*.fixture.ts` module: excluded from the published
 *   build (tsconfig), never exported from the barrel. The package ships
 *   `defaultTheme` only — the docs site and Storybook are *consumers*, and
 *   consumers own their themes ("charts export no consumer themes").
 * - **Canonical values live here.** `website/src/css/custom.css` mirrors these
 *   values as CSS custom properties (the site's own chrome needs literal CSS,
 *   and the docs embeds read the vars back through `cssVarTheme` — dogfooding
 *   the bridge). A sync test keeps the two in lockstep; change a value here and
 *   the website tokens must follow.
 * - **Light is the Storybook default**; `docsThemeDark` is the same design on
 *   the dark ground, used by the docs site's dark mode and any deliberately
 *   dark story.
 */
import type { ChartTheme } from './theme.js';

/**
 * The shared series ramp, by role. A handful of roles, not a hue per channel:
 * stories and docs map their semantics onto these five, in order.
 */
const light = {
  blue: '#3d76c2', // primary — the workhorse series colour
  amber: '#c99a2e', // secondary — the contrast series
  teal: '#319795', // context — reference / background series
  rose: '#c25450', // fourth series; also the "slow" / outflow role
  violet: '#8168b8', // fifth series
  ink: '#454c56', // strong text (axis titles, medians)
  label: '#5d6673', // axis tick labels, cursor
  grid: '#eceff3', // hairline gridlines
  divider: '#d4dae1', // session dividers — one step stronger than grid
  bg: '#ffffff',
  chip: '#f4f6f9',
  mark: '#0f9e8e', // the annotation (turquoise) register
  rising: '#2e9e83', // market up — the docs site is a consumer, so unlike
  falling: '#d15656', // defaultTheme it may use a market pair
  dojiBody: '#8b95a1',
  dojiWick: '#6b7482',
} as const;

const dark = {
  blue: '#6ea3e8',
  amber: '#dcb04a',
  teal: '#45b8b0',
  rose: '#e07a72',
  violet: '#a08fd8',
  ink: '#c6cdd6',
  label: '#99a3ae',
  grid: '#262b33',
  divider: '#3a414b',
  bg: '#16191f', // dark grey terminal ground — not black
  chip: '#20252d',
  mark: '#34c9b9',
  rising: '#35b593',
  falling: '#e06c66',
  dojiBody: '#8b95a1',
  dojiWick: '#a6afba',
} as const;

const FONT = {
  family: "'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif",
  size: 11,
} as const;

type Ramp = Record<keyof typeof light, string>;

/** Build the light/dark variants from one structure so they cannot drift. */
function buildDocsTheme(c: Ramp, pointOutline: string): ChartTheme {
  return {
    background: c.bg,
    line: {
      default: { color: c.blue, width: 1.5 },
      primary: { color: c.blue, width: 1.5 },
      secondary: { color: c.amber, width: 1.5 },
      context: { color: c.teal, width: 1.5 },
      // The two-series contrast pair the cursor/readout stories key on.
      fast: { color: c.blue, width: 1.5 },
      slow: { color: c.rose, width: 1.5 },
    },
    band: {
      default: { fill: c.blue, opacity: 0.14 },
      outer: { fill: c.blue, opacity: 0.1 },
      inner: { fill: c.blue, opacity: 0.22 },
    },
    area: {
      default: { color: c.blue, width: 1.5, fill: c.blue, fillOpacity: 0.28 },
      in: { color: c.blue, width: 1.5, fill: c.blue, fillOpacity: 0.28 },
      out: { color: c.rose, width: 1.5, fill: c.rose, fillOpacity: 0.28 },
    },
    scatter: {
      default: {
        color: c.blue,
        radius: 4,
        outline: pointOutline,
        outlineWidth: 1,
        selectedOutline: c.ink,
        selectedWidth: 2,
        label: c.ink,
      },
      primary: {
        color: c.blue,
        radius: 4,
        outline: pointOutline,
        outlineWidth: 1,
        selectedOutline: c.ink,
        selectedWidth: 2,
        label: c.ink,
      },
      secondary: {
        color: c.amber,
        radius: 4,
        outline: pointOutline,
        outlineWidth: 1,
        selectedOutline: c.ink,
        selectedWidth: 2,
        label: c.ink,
      },
    },
    box: {
      default: {
        fill: c.blue,
        fillOpacity: 0.24,
        stroke: c.blue,
        strokeWidth: 1.5,
        median: c.ink,
        medianWidth: 2,
        whisker: c.label,
        whiskerWidth: 1,
      },
    },
    candle: {
      default: {
        rising: { body: c.rising, wick: c.rising },
        falling: { body: c.falling, wick: c.falling },
        neutral: { body: c.dojiBody, wick: c.dojiWick },
        bodyWidth: 0.7,
        wickWidth: 1,
      },
    },
    bar: {
      default: {
        fill: c.blue,
        opacity: 0.88,
        highlight: c.amber,
        gap: 1,
        minWidth: 1,
        outlineWidth: 1.5,
      },
      secondary: {
        fill: c.amber,
        opacity: 0.88,
        highlight: c.blue,
        gap: 1,
        minWidth: 1,
        outlineWidth: 1.5,
      },
    },
    axis: {
      label: c.label,
      grid: c.grid,
      gridDash: [], // solid hairlines — the terminal register
      sessionDivider: c.divider,
      title: { color: c.ink },
    },
    font: FONT,
    cursor: c.label,
    chip: { background: c.chip },
    gap: { connectorOpacity: 0.45 },
    annotation: {
      color: c.mark,
      fillOpacity: 0.09,
      depth: [1, 0.7, 0.4],
    },
  };
}

/**
 * The raw ramps, exported for the fixture↔website sync test (the website's
 * `--pond-*` CSS custom properties must mirror these values exactly).
 */
export const docsPalette = { light, dark } as const;

/** The docs/Storybook look, light ground. The Storybook default. */
export const docsTheme: ChartTheme = buildDocsTheme(light, '#ffffff');

/** The same design on the dark terminal ground (docs-site dark mode). */
export const docsThemeDark: ChartTheme = buildDocsTheme(dark, dark.bg);
