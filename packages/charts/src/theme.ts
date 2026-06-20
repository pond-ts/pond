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
  /**
   * Map from an area's semantic identifier to its outline-plus-graded-fill style
   * (`AreaChart`) — outline colour/width and the gradient (opaque at the line,
   * fading to transparent at the baseline). `default` is the fallback; the
   * esnet two-colour traffic look is two areas composed in the z-stack (e.g.
   * `in` above the axis + `out` below), each resolving `area[semantic] ??
   * area.default`.
   */
  readonly area: {
    readonly default: AreaStyle;
    readonly [semantic: string]: AreaStyle;
  };
  /**
   * Map from a box's semantic identifier to its style — a discrete
   * box-and-whisker per key ({@link BoxPlot}), the bar-chart analog of the
   * band. `default` is the fallback; a chart tags each box series with a role
   * (`<BoxPlot as="latency" />`) resolving `box[semantic] ?? box.default`.
   */
  readonly box: {
    readonly default: BoxStyle;
    readonly [semantic: string]: BoxStyle;
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
  /** Crosshair / tracker stroke colour. Falls back to {@link axis.label} if unset. */
  readonly cursor?: string;
  /**
   * Readout chip background (the `flag` / `inline` tracker modes). The value text
   * is the series colour; this is the panel behind it. Falls back to the plot
   * background if unset.
   */
  readonly chip?: { readonly background: string };
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
 * A resolved box-and-whisker style ({@link BoxPlot}). The q1→q3 box is a filled
 * rect (`fill` at `fillOpacity`) outlined by `stroke`/`strokeWidth`; the
 * `median` line and the `whisker` (the lower/upper stems + caps) get their own
 * colour/width so the median reads against the fill. Whiskers and the box
 * outline are drawn at full alpha (only the box fill is graded by `fillOpacity`).
 */
export interface BoxStyle {
  readonly fill: string;
  readonly fillOpacity: number;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly median: string;
  readonly medianWidth: number;
  readonly whisker: string;
  readonly whiskerWidth: number;
}

/**
 * A resolved area style: an outline stroke plus a graded fill. `color`/`width`
 * stroke the value line on top; `fill` is the gradient base colour, opaque
 * (scaled by `fillOpacity`, 0–1) at the line and grading to transparent at the
 * baseline. `fill` must be a CSS hex (`#rgb` / `#rrggbb`) so the transparent
 * stop can be derived; other formats fall back to a flat fill.
 */
export interface AreaStyle {
  readonly color: string;
  readonly width: number;
  readonly fill: string;
  readonly fillOpacity: number;
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
  area: {
    // Outline at the line colour; graded fill from it. `in`/`out` are the
    // above/below-axis roles (esnet traffic), composed as two layers.
    default: {
      color: '#2563eb',
      width: 1.5,
      fill: '#2563eb',
      fillOpacity: 0.3,
    },
    in: { color: '#2563eb', width: 1.5, fill: '#2563eb', fillOpacity: 0.3 },
    out: { color: '#e8836b', width: 1.5, fill: '#e8836b', fillOpacity: 0.3 },
  },
  box: {
    // The blue brand box: a translucent fill outlined in the line colour, a
    // bolder median, and matching whiskers.
    default: {
      fill: '#2563eb',
      fillOpacity: 0.3,
      stroke: '#2563eb',
      strokeWidth: 1.5,
      median: '#1e3a8a',
      medianWidth: 2,
      whisker: '#2563eb',
      whiskerWidth: 1.5,
    },
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
  cursor: '#64748b',
  chip: { background: '#ffffff' },
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
  area: {
    // Elevation: the brand teal outline over a graded teal shade. `in`/`out`
    // are the above/below-axis traffic roles — teal `in`, warm filament `out`.
    default: {
      color: '#15B3A6',
      width: 1.5,
      fill: '#15B3A6',
      fillOpacity: 0.35,
    }, // --es-estela
    in: { color: '#15B3A6', width: 1.5, fill: '#15B3A6', fillOpacity: 0.35 }, // --es-estela
    out: { color: '#E0B36A', width: 1.5, fill: '#E0B36A', fillOpacity: 0.35 }, // --es-filament
  },
  box: {
    // A teal box on the dark ground: `--es-shallows` fill, `--es-estela` outline
    // + whiskers, and a bright `--es-foam` median so it reads against the fill.
    default: {
      fill: '#45CDBE', // --es-shallows
      fillOpacity: 0.28,
      stroke: '#15B3A6', // --es-estela
      strokeWidth: 1.5,
      median: '#F1FBF9', // --es-foam
      medianWidth: 2,
      whisker: '#7FE2D2', // --es-reef
      whiskerWidth: 1.5,
    },
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
  cursor: '#7FE2D2', // --es-reef (bright tracker on the dark ground)
  chip: { background: '#0B4E58' }, // --es-deep (panel behind readout text)
};
