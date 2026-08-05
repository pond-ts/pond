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
function fade(color: string | undefined, alpha: number): string | undefined {
  if (color === undefined) return undefined;
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const hex = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${hex}`;
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * Blend `color` a fraction `t` of the way toward `toward`, both `#rrggbb`.
 * `fade`'s opaque sibling: where `fade` derives a translucent shade by adding
 * alpha, this derives a **flat** one by mixing — which is the only option for
 * marks that are drawn over each other. A stacked area's slabs overlap, so an
 * alpha tint would compound and each band's apparent colour would depend on
 * whatever it happened to be painted over.
 *
 * Channel-wise in gamma-encoded sRGB, i.e. exactly `color-mix(in srgb, toward
 * t%, color)` — so any step here can be reproduced in a stylesheet by hand.
 * Returns `undefined` unless both inputs are 6-digit hex; callers omit the
 * role rather than emitting a half-derived one (see `seqRoles`).
 */
function mix(
  color: string | undefined,
  toward: string | undefined,
  t: number,
): string | undefined {
  if (color === undefined || toward === undefined) return undefined;
  if (!HEX6.test(color) || !HEX6.test(toward)) return undefined;
  const [a, b] = [channels(color), channels(toward)];
  return `#${a
    .map((c, i) =>
      Math.round(c + (b[i]! - c) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * One band of a stack: a flat, fully opaque fill with a hairline outline in its
 * own colour. Shared by both stacking role sets so they can't drift — the two
 * differ in which colours they step through, and in nothing else.
 */
const slab = (step: string) => ({
  color: step,
  width: 1,
  fill: step,
  fillOpacity: 1,
  flatFill: true,
});

/**
 * The two tonal families, as `[role prefix, base hue]`. `A` is the
 * **desaturated** one — `--pond-viz-5` is the palette's designated overflow
 * hue, so a family lives there without consuming a categorical slot — and `B`
 * is the brand accent, the family a reader's eye goes to first.
 */
const TONAL_FAMILIES = [
  ['tonalA', '--pond-viz-5'],
  ['tonalB', '--pond-viz-1'],
] as const;

/**
 * Step `n` is `TONAL_MIX[n-1]` of the way from the base hue to the page:
 * step 4 **is** the base hue, step 1 is the most washed-out. Numbering
 * therefore ascends with prominence, and each family "fades toward the ground"
 * as its number falls — one rule that reads the same in both themes (mixing
 * toward a white page tints, mixing toward a dark one shades).
 *
 * Even in sRGB, which lands near-even perceptually: ~12 L\* per step in both
 * themes. Stopping at 0.66 rather than going paler is what keeps the washed
 * end off the background — see the measurements on the Grid mix page.
 */
const TONAL_MIX = [0.66, 0.44, 0.22, 0];

/**
 * `tonalA1…4` / `tonalB1…4`: **two** tonal families of four steps, for a
 * nominal category set that splits into two meaningful groups.
 *
 * The sibling of `seqRoles`, and deliberately not the same thing. One ramp
 * across eight slots encodes an *order* — correct for a magnitude (the climate
 * stripes' anomaly), wrong for eight generation sources, which are categories
 * with a grouping rather than a ranking. Two families keep the tonal rule
 * (gallery plan §8.2 — tints within one or two brand hues, never eight
 * competing ones) while restoring the categorical break where the data has one:
 * within a family neighbours sit ~12 ΔE apart, across the families ~41.
 *
 * Derived by mixing rather than declared as sixteen more custom properties —
 * the steps are a fixed function of two palette hues and the page colour, so a
 * variable per step would be sixteen chances for the ramp and the palette to
 * drift apart.
 */
function tonalRoles<T>(
  v: VarReader,
  style: (step: string) => T,
): Record<string, T> {
  const out: Record<string, T> = {};
  const surface = v('--pond-surface');
  for (const [prefix, base] of TONAL_FAMILIES) {
    TONAL_MIX.forEach((t, i) => {
      const step = mix(v(base), surface, t);
      if (step) out[`${prefix}${i + 1}`] = style(step);
    });
  }
  return out;
}

/**
 * `highlight1…3` — the named series lifted **out of** an {@link
 * useSiteChartTheme `ensemble`} backdrop, in the first three categorical hues.
 *
 * Two things separate a highlight from the pack, and both are needed: a data
 * hue against the pack's neutral, and **weight**. The categorical hues are
 * mid-saturation by design, and one at the shared 1.5px default does not carry
 * over a busy texture — measured on the Niño 3.4 card, where three of them at
 * the default read as three more members of the pack.
 *
 * `highlight1` is the **subject** — the one series the chart is about — and is
 * heaviest on purpose; 2 and 3 are the named comparisons it is read against.
 * That asymmetry is the point: a flat set of three equal highlights says
 * "these three are the same kind of thing", which is exactly what a
 * this-year-against-history chart is not saying.
 */
function highlightRoles(
  v: VarReader,
): Record<string, { color?: string; width: number }> {
  const out: Record<string, { color?: string; width: number }> = {};
  const widths = [2.75, 1.75, 1.75];
  widths.forEach((width, i) => {
    const color = v(`--pond-viz-${i + 1}`);
    if (color) out[`highlight${i + 1}`] = { color, width };
  });
  return out;
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
      // `ensemble` + `highlight1…3` are a **pair**, and only make sense
      // together: dozens of traces of the same quantity drawn as one texture,
      // with a handful lifted out of it by name. A spaghetti plot of model
      // runs, a fan of scenarios, every year of a record on a shared seasonal
      // axis. Don't reach for one without the other.
      //
      // The line analogue of `scatter.raw`, and deliberately **much** fainter
      // than `muted`: `muted` is tuned for ONE backdrop trace with a highlight
      // drawn through it, and alpha compounds where strokes cross, so at that
      // weight forty-odd of them stack into a mass that competes with the
      // thing they are behind. 0.16 is set by the *ensemble's* apparent
      // weight, not by one stroke's — measured on the Niño 3.4 card, where it
      // puts the pack's mean ink at roughly a fifth of a highlight's.
      ensemble: { color: fade(v('--pond-muted'), 0.16), width: 1 },
      ...highlightRoles(v),
      // A **modelled** line, in two halves that differ by exactly one
      // property. `trendFit` is the stretch a model was fitted on; `trend` is
      // what it extrapolates, and `dash` is the whole difference — which is
      // the register `LineStyle.dash` exists for. Both take the annotation
      // hue rather than a data hue: a fit is something the *reader* asked for
      // by choosing a month, so it belongs with the selection band and the
      // axis pill that define it, not with the three measured series.
      trendFit: { color: v('--pond-viz-mark'), width: 1.5 },
      trend: { color: v('--pond-viz-mark'), width: 1.5, dash: [5, 4] },
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
      // The *stacking* roles: each band has to read as its own slab, so they
      // fill **flat** (`flatFill`) rather than grading to transparent at the
      // baseline — a graded band lets every band beneath show through it. Draw
      // cumulative columns top-down and the slabs cover each other cleanly.
      ...seqRoles(v, slab),
      // The two-family variant, same slab treatment. Stacking is the only
      // register these are wired into: they exist for a *composition* of
      // grouped categories, and the washed steps are built to be read against
      // their neighbours in a stack. As a lone line or bar against the page a
      // `tonalA1` would sit almost on the ground colour — the same trap the
      // ramp's own note warns about, one step further along.
      ...tonalRoles(v, slab),
    },
    scatter: {
      default: { color: v('--pond-viz-1'), label: v('--pond-ink') },
      primary: { color: v('--pond-viz-1'), label: v('--pond-ink') },
      secondary: { color: v('--pond-viz-2'), label: v('--pond-ink') },
      // Raw samples drawn as a **cloud** — thousands of points where the
      // density is the message and no single one is. Small, part-transparent
      // and outline-free: an outline at r=1.5 is most of the mark, and at this
      // count the rings merge into a grey wash that hides the shape they're
      // meant to reveal. The scatter analogue of `line.muted`.
      raw: {
        color: fade(v('--pond-viz-1'), 0.3),
        radius: 1.5,
        outlineWidth: 0,
        label: v('--pond-ink'),
      },
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
      // Neutral grey, not a data hue — the bar analogue of `line.muted` and
      // `scatter.raw`. For a `<BarList>` whose bars carry *magnitude* while
      // identity is carried elsewhere (a swatch, a label): `BarListColumn.as`
      // is per column, so a one-bar-per-row list has one colour for every row
      // and it had better not look like a series colour.
      muted: {
        ...defaultTheme.bar.default,
        fill: fade(v('--pond-muted'), 0.5) ?? defaultTheme.bar.default.fill,
        highlight: v('--pond-viz-1') ?? defaultTheme.bar.default.highlight,
      },
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
    // Without this the legend card keeps `defaultTheme.legend` — a hardcoded
    // **white** panel with slate text — which is invisible-adjacent on a light
    // page and a glaring white block on a dark one. It is the one register the
    // bridge had never mapped, so every embed drawing a `<Legend>` showed it.
    legend: {
      background: v('--pond-surface-2'),
      border: v('--pond-hairline'),
      text: v('--pond-body'),
    },
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
