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
 * The estela theme — estela's fixed role palette as *one theme*, on its dark
 * ground. The role identifiers (`foam` primary group-channel / `coral` HR /
 * `teal` elevation) are the same names estela uses; a chart tags a column with
 * one (`<LineChart as="foam" />`) and the colour lives here, not at the call
 * site. The proving consumer for "target other uses too": the same engine,
 * restyled by swapping this object for {@link defaultTheme}.
 *
 * Colours are representative pending the exact `@estela/ui` palette pinned at
 * M5 parity; the *shape* (roles, dark ground, dashed grid) is what M2 proves.
 */
export const estelaTheme: ChartTheme = {
  background: '#0e1a18',
  line: {
    default: { color: '#eaf4f1', width: 1.5 },
    foam: { color: '#eaf4f1', width: 2 },
    coral: { color: '#ff7d68', width: 1.5 },
    teal: { color: '#5eb5a6', width: 1.5 },
  },
  axis: {
    label: '#6f9b93',
    grid: '#1c302c',
    gridDash: [2, 3],
  },
  font: {
    family: 'system-ui, -apple-system, sans-serif',
    size: 11,
  },
};
