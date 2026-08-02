import {
  defaultTheme,
  useChartTheme,
  type ChartTheme,
  type VarReader,
} from '@pond-ts/charts';

/**
 * How many steps the sequential ramp has (`--pond-viz-seq-1…8`). Eight is the
 * stress case the Gallery was scoped around — an eight-source grid mix.
 */
export const SEQ_STEPS = 8;

/** `seq1…seq8`, in ramp order (darkest → lightest). */
export const SEQ_ROLES = Array.from(
  { length: SEQ_STEPS },
  (_, i) => `seq${i + 1}`,
) as readonly string[];

/**
 * The `seq1…seq8` entries for one theme slot, resolved from
 * `--pond-viz-seq-N`. See the ramp block in `src/css/custom.css`: the
 * `--pond-viz-1…5` categorical set stays five hues wide, and anything needing
 * more slots than that steps **tonally** through one brand hue instead of
 * introducing competing ones (gallery plan §8.2).
 *
 * A step that doesn't resolve (SSR, where there's no `getComputedStyle`) is
 * **omitted** rather than emitted as `{ color: undefined }` — the merge treats
 * a brand-new key as "the partial wins wholesale", so a half-built role would
 * shadow `default` with a colourless style instead of falling back to it.
 */
function seqRoles<T>(
  v: VarReader,
  style: (step: string) => T,
): Record<string, T> {
  const out: Record<string, T> = {};
  SEQ_ROLES.forEach((role, i) => {
    const step = v(`--pond-viz-seq-${i + 1}`);
    if (step) out[role] = style(step);
  });
  return out;
}

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
      ...seqRoles(v, (step) => ({ color: step, width: 1.5 })),
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
      // Near-opaque (0.9), unlike the 0.28 wash the single-accent areas use:
      // these are the *stacking* roles and each band has to read as its own
      // slab. NB the fill is still a gradient to the baseline — for a true
      // stack, draw cumulative columns top-down so each fill covers the one
      // beneath it.
      ...seqRoles(v, (step) => ({
        color: step,
        width: 1,
        fill: step,
        fillOpacity: 0.9,
      })),
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
      // A stack reads only `.fill` per group (`colors[g] ?? theme.bar[g] ??
      // bar.default`); a single-series `as="seq3"` bar reads the whole style.
      ...seqRoles(v, (step) => ({
        fill: step,
        highlight: v('--pond-viz-2'),
      })),
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

/**
 * The resolved sequential ramp — eight steps, darkest first — flipping with
 * the site's dark/light toggle because it's read straight off the same live
 * theme every embed renders with.
 *
 * Use it where a layer takes **colours as data** rather than as a role: a
 * stacked `<BarChart colors={…}>` keyed by group name, `binColors`, a scatter
 * encoding. When the layer can take a *role* instead, prefer that — the
 * `seq1…seq8` line/area/bar roles say the same thing through the one styling
 * channel:
 *
 * ```tsx
 * const ramp = useSequentialRamp();
 * const bySource = Object.fromEntries(SOURCES.map((s, i) => [s, ramp[i]!]));
 * <BarChart series={byHost} column="mw" colors={bySource} />
 * ```
 *
 * Pass `count` for the first `n` steps stretched across the whole ramp, so a
 * five-series chart spans dark→light instead of crowding into the dark end.
 *
 * The ramp is built for **fills**, where each slab's neighbours supply the
 * contrast. A lone *line* at step 1 or 2 sits nearly on the ground colour —
 * give a single line `line.default` / `--pond-viz-1` instead.
 */
export function useSequentialRamp(count: number = SEQ_STEPS): string[] {
  const theme = useSiteChartTheme();
  const n = Math.max(1, Math.min(count, SEQ_STEPS));
  return Array.from({ length: n }, (_, i) => {
    // Even spread across the ramp: n=8 → 0..7, n=5 → 0,1,3,5,7.
    const step = n === 1 ? 0 : Math.round((i * (SEQ_STEPS - 1)) / (n - 1));
    return theme.bar[SEQ_ROLES[step]!]?.fill ?? theme.bar.default.fill;
  });
}
