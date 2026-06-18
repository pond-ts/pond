/**
 * Visual styling for a chart, threaded through {@link ChartContainer} via
 * context. Canvas has no CSS cascade into drawn pixels, so this typed object is
 * the single styling channel for the drawn layers; DOM chrome (axis labels)
 * derives from it too.
 *
 * The styling pipeline is **time series → columns → semantic identifier →
 * style**: a draw layer tags its column with a *semantic identifier* (what the
 * data _is_ — e.g. `heartrate`, `power`, or a generic `primary`), and the theme
 * is the map from identifier → {@link LineStyle}. The visual discipline ("a
 * handful of roles, not a hue per channel") lives in the theme, not the type: a
 * good theme maps many identifiers onto few shared styles (estela maps
 * power / speed / cadence → one foam style). Tokens grow as components land
 * (axis tokens with `YAxis`, band tokens with `BandChart`).
 */
export interface ChartTheme {
  /** Painted behind the layers; omit for a transparent background. */
  readonly background?: string;
  /**
   * Map from a line's semantic identifier to its style. `default` is the
   * fallback for an identifier the theme doesn't name, so a chart always
   * renders; a line resolves `line[semantic] ?? line.default`.
   */
  readonly line: {
    readonly default: LineStyle;
    readonly [semantic: string]: LineStyle;
  };
  /**
   * Map from a band's semantic identifier to its fill style — the variance
   * underlay ({@link BandChart}). `default` is the fallback; a two-tone spread
   * is two bands composed in the z-stack (e.g. `outer` p5/p95 + `inner`
   * p25/p75), each resolving `band[semantic] ?? band.default`.
   */
  readonly band: {
    readonly default: BandStyle;
    readonly [semantic: string]: BandStyle;
  };
  /** Axis chrome: tick-label colour, gridline stroke + dash pattern. */
  readonly axis: {
    readonly label: string;
    readonly grid: string;
    /** Gridline dash pattern (px on/off pairs); `[]` for solid. */
    readonly gridDash: readonly number[];
  };
  /** Label / tick typography. One source for axes + chrome. */
  readonly font: {
    readonly family: string;
    readonly size: number;
  };
}

/** A resolved line style: stroke colour + width (px). */
export interface LineStyle {
  readonly color: string;
  readonly width: number;
}

/** A resolved band style: fill colour + opacity (0–1) for the variance envelope. */
export interface BandStyle {
  readonly fill: string;
  readonly opacity: number;
}

/**
 * The neutral default theme. `default` / `primary` match the M1 `LineChart`
 * colour (`#2563eb`) so adopting the theme channel doesn't shift existing
 * renders. `primary` / `secondary` / `context` are a built-in generic role
 * vocabulary; an unrecognised (e.g. domain-specific) identifier falls back to
 * `default`.
 */
export const defaultTheme: ChartTheme = {
  line: {
    default: { color: '#2563eb', width: 1.5 },
    primary: { color: '#2563eb', width: 1.5 },
    secondary: { color: '#e8836b', width: 1.5 },
    context: { color: '#5eb5a6', width: 1.5 },
  },
  band: {
    default: { fill: '#2563eb', opacity: 0.15 },
    outer: { fill: '#2563eb', opacity: 0.1 },
    inner: { fill: '#2563eb', opacity: 0.2 },
  },
  axis: {
    label: '#64748b',
    grid: '#e2e8f0',
    gridDash: [2, 2],
  },
  font: {
    family: 'system-ui, -apple-system, sans-serif',
    size: 11,
  },
};

/**
 * The estela theme — estela's real `@estela/ui` palette as *one theme*, on its
 * dark ground. A chart tags a column with a role (`<LineChart as="foam" />`) and
 * the colour lives here, not at the call site. The proving consumer for "target
 * other uses too": the same engine, restyled by swapping this for
 * {@link defaultTheme}.
 *
 * Line roles map to estela's palette tokens:
 * - `default` → `--es-estela` `#15B3A6` (primary / action — the brand teal)
 * - `foam` → `--es-foam` `#F1FBF9` (the shared "motion" trace estela uses for
 *   its primary channels — power / speed / cadence all render foam)
 * - `hr` → `--es-filament` `#E0B36A` (the rare warm accent — heart rate)
 *
 * Chrome: `--es-bg` ground, `--es-ink` gridlines, `--es-slate` labels, and the
 * `--es-font-data` (JetBrains Mono) face for crisp numeric ticks (falls back to
 * `ui-monospace` where the webfont isn't loaded). Band fills: `outer`
 * (`--es-reef`) + `inner` (`--es-shallows`) for the two-tone variance spread.
 */
export const estelaTheme: ChartTheme = {
  background: '#06191D', // --es-bg
  line: {
    default: { color: '#15B3A6', width: 1.5 }, // --es-estela (primary / action)
    foam: { color: '#F1FBF9', width: 2 }, // --es-foam (motion — shared primary trace)
    hr: { color: '#E0B36A', width: 1.5 }, // --es-filament (rare warm accent)
  },
  band: {
    default: { fill: '#45CDBE', opacity: 0.18 }, // --es-shallows
    outer: { fill: '#7FE2D2', opacity: 0.12 }, // --es-reef (wide p5/p95 spread)
    inner: { fill: '#45CDBE', opacity: 0.22 }, // --es-shallows (tight p25/p75)
  },
  axis: {
    label: '#4E6B6B', // --es-slate
    grid: '#06343A', // --es-ink
    gridDash: [2, 3],
  },
  font: {
    family: '"JetBrains Mono", ui-monospace, monospace', // --es-font-data
    size: 11,
  },
};
