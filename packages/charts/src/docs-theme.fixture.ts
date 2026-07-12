/**
 * `docsTheme` — the one look for everything the project itself renders.
 *
 * Every Storybook story (except the theming-demonstration stories, whose whole
 * point is contrast) and every docs-site chart embed renders with this theme,
 * light or dark, so the deployed Storybook, the docs images, and the live
 * embeds read as one designed system (PLAN.md → Docs site wave, "One look").
 *
 * Sourced from the real Pond brand system (`brand/Pond Brand Spec.html` §07
 * "Data visualization", v2): the brand's single teal UI accent becomes the
 * chart's *primary* data colour, extended by a design-system-provided
 * multi-series ramp for packages/charts specifically. **Hard rule the ramp
 * was built to satisfy: data and user-placed annotations never share a hue
 * family** — the mark/annotation register is a deliberate warm outlier
 * against the ramp's cool data hues, so a placed mark can never be mistaken
 * for a series at a glance.
 *
 * Contract:
 *
 * - **Dev-only.** This is a `*.fixture.ts` module: excluded from the published
 *   build (tsconfig), never exported from the barrel. The package ships
 *   `defaultTheme` only — the docs site and Storybook are *consumers*, and
 *   consumers own their themes ("charts export no consumer themes").
 * - **Canonical values live here.** `website/src/css/custom.css` mirrors these
 *   values as `--pond-viz-*` CSS custom properties (the site's own chrome
 *   needs literal CSS, and the docs embeds read the vars back through
 *   `cssVarTheme` — dogfooding the bridge). A sync test keeps the two in
 *   lockstep; change a value here and the website tokens must follow.
 * - **Light is the Storybook default**; `docsThemeDark` is the same design on
 *   the dark ground, used by the docs site's dark mode and any deliberately
 *   dark story.
 */
import type { ChartTheme } from './theme.js';

/**
 * The brand's UI-chrome neutrals (spec §02) plus the data-visualization ramp
 * (spec §07, `tokens.viz.css` — copied verbatim). `ink`/`body`/`muted`/
 * `surface`/`surface2` are the SAME tokens `website/src/css/custom.css`
 * defines for site chrome — one `ink`, not two ships-in-the-night values.
 */
const light = {
  // UI neutrals (brand spec §02)
  ink: '#0c2222',
  body: '#46605f',
  muted: '#8ba3a1',
  surface: '#ffffff',
  surface2: '#eef4f3',
  // Data-visualization ramp (brand spec §07 tokens.viz.css)
  viz1: '#0e8f86', // primary — the brand accent
  viz2: '#3d6fd9',
  viz3: '#8354cc',
  viz4: '#c43d82',
  viz5: '#5b7088', // overflow, desaturated
  vizMark: '#c2790f', // annotations — a deliberately different hue family
  vizUp: '#1f9d63', // candle up/down — the conventional exception
  vizDown: '#d8473f',
} as const;

const dark = {
  ink: '#e6f2f0',
  body: '#9fb4b1',
  muted: '#6b8180',
  surface: '#0f1c1a',
  surface2: '#142523',
  viz1: '#34d3c0',
  viz2: '#7fa8ff',
  viz3: '#b092f0',
  viz4: '#f17fc0',
  viz5: '#8fa3be',
  vizMark: '#f2b94a',
  vizUp: '#3ddc8f',
  vizDown: '#ff6e68',
} as const;

/** `color` at `alpha` opacity, as an rgba() string — for the grid/divider
 *  pair the spec derives from `muted` rather than naming outright
 *  ("Gridlines/dividers: --pond-muted at ~40% opacity. No new neutral
 *  tokens needed."). Session dividers read "one step stronger than
 *  gridlines," so they get a higher alpha off the same base colour. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const FONT = {
  family: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  size: 11,
} as const;

type Ramp = Record<keyof typeof light, string>;

/** Build the light/dark variants from one structure so they cannot drift. */
function buildDocsTheme(c: Ramp): ChartTheme {
  return {
    background: c.surface,
    line: {
      default: { color: c.viz1, width: 1.5 },
      primary: { color: c.viz1, width: 1.5 },
      secondary: { color: c.viz2, width: 1.5 },
      context: { color: c.viz3, width: 1.5 },
      // The two-series contrast pair the cursor/readout stories key on —
      // teal vs magenta, maximally distinct rather than adjacent-in-ramp.
      fast: { color: c.viz1, width: 1.5 },
      slow: { color: c.viz4, width: 1.5 },
    },
    band: {
      default: { fill: c.viz1, opacity: 0.14 },
      outer: { fill: c.viz1, opacity: 0.1 },
      inner: { fill: c.viz1, opacity: 0.22 },
    },
    area: {
      default: { color: c.viz1, width: 1.5, fill: c.viz1, fillOpacity: 0.28 },
      in: { color: c.viz1, width: 1.5, fill: c.viz1, fillOpacity: 0.28 },
      out: { color: c.viz4, width: 1.5, fill: c.viz4, fillOpacity: 0.28 },
    },
    scatter: {
      default: {
        color: c.viz1,
        radius: 4,
        outline: c.surface,
        outlineWidth: 1,
        selectedOutline: c.ink,
        selectedWidth: 2,
        label: c.ink,
      },
      primary: {
        color: c.viz1,
        radius: 4,
        outline: c.surface,
        outlineWidth: 1,
        selectedOutline: c.ink,
        selectedWidth: 2,
        label: c.ink,
      },
      secondary: {
        color: c.viz2,
        radius: 4,
        outline: c.surface,
        outlineWidth: 1,
        selectedOutline: c.ink,
        selectedWidth: 2,
        label: c.ink,
      },
    },
    box: {
      default: {
        fill: c.viz1,
        fillOpacity: 0.24,
        stroke: c.viz1,
        strokeWidth: 1.5,
        median: c.ink,
        medianWidth: 2,
        whisker: c.body,
        whiskerWidth: 1,
      },
    },
    candle: {
      default: {
        rising: { body: c.vizUp, wick: c.vizUp },
        falling: { body: c.vizDown, wick: c.vizDown },
        neutral: { body: c.muted, wick: c.body },
        bodyWidth: 0.7,
        wickWidth: 1,
      },
    },
    bar: {
      default: {
        fill: c.viz1,
        opacity: 0.88,
        highlight: c.viz2,
        gap: 1,
        minWidth: 1,
        outlineWidth: 1.5,
      },
      secondary: {
        fill: c.viz2,
        opacity: 0.88,
        highlight: c.viz1,
        gap: 1,
        minWidth: 1,
        outlineWidth: 1.5,
      },
    },
    axis: {
      label: c.body,
      grid: withAlpha(c.muted, 0.4),
      gridDash: [], // solid hairlines — the terminal register
      sessionDivider: withAlpha(c.muted, 0.65), // a step stronger than grid
      title: { color: c.ink },
    },
    font: FONT,
    cursor: c.body,
    chip: { background: c.surface2 },
    gap: { connectorOpacity: 0.45 },
    annotation: {
      // The hard rule (spec §07): never a data hue.
      color: c.vizMark,
      fillOpacity: 0.09,
      depth: [1, 0.7, 0.4],
    },
  };
}

/**
 * The raw ramps plus the computed grid/divider strings (`muted` + alpha —
 * see `withAlpha` above), exported for the fixture↔website sync test (the
 * website's `--pond-*`/`--pond-viz-*` CSS custom properties must mirror
 * these values exactly, byte for byte, so the CSS ships the *same* computed
 * rgba() strings rather than re-deriving them).
 */
export const docsPalette = {
  light: {
    ...light,
    grid: withAlpha(light.muted, 0.4),
    divider: withAlpha(light.muted, 0.65),
  },
  dark: {
    ...dark,
    grid: withAlpha(dark.muted, 0.4),
    divider: withAlpha(dark.muted, 0.65),
  },
} as const;

/** The docs/Storybook look, light ground. The Storybook default. */
export const docsTheme: ChartTheme = buildDocsTheme(light);

/** The same design on the dark terminal ground (docs-site dark mode). */
export const docsThemeDark: ChartTheme = buildDocsTheme(dark);
