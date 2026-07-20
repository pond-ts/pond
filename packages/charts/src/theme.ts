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
   * Map from a scatter's semantic identifier to its point style — the single
   * styling channel for the **base mark** ({@link ScatterChart}): fill colour,
   * base radius, outline, and the optional per-point label colour. `default` is
   * the fallback; a scatter resolves `scatter[semantic] ?? scatter.default`.
   *
   * Scatter additionally supports **data-driven** radius + colour (a column run
   * through a scale — see `src/encoding.ts`); that is the deliberate, signed-off
   * exception to one-channel styling. The data-driven encoding *overrides* this
   * style's `radius` / `color` per point; this remains the fallback for
   * unencoded points and the source of the outline + label styling.
   */
  readonly scatter: {
    readonly default: ScatterStyle;
    readonly [semantic: string]: ScatterStyle;
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
  /**
   * Map from a candle's semantic identifier to its style — a first-class OHLC
   * mark ({@link Candlestick}), the financial sibling of the box. Unlike the
   * other slots a {@link CandleStyle} carries a *pair* (`rising`/`falling`, plus
   * an optional `neutral` doji): direction colouring is intrinsic to the mark, so
   * one colour can't express it. `default` is the fallback; a chart tags each
   * series with a role (`<Candlestick as="AAPL" />`) resolving `candle[semantic]
   * ?? candle.default`. The default pair is **neutral / unbranded** (a
   * distinguishable up/down, *not* market green/red) — a consumer supplies its
   * own palette via `cssVarTheme`; the library owns the type + a renderable
   * default, never a brand.
   */
  readonly candle: {
    readonly default: CandleStyle;
    readonly [semantic: string]: CandleStyle;
  };
  /**
   * Map from a bar's semantic identifier to its style — the fill, the
   * selected-bar highlight, and the slot gap / minimum width ({@link BarChart}).
   * `default` is the fallback; a bar resolves `bar[semantic] ?? bar.default`.
   */
  readonly bar: {
    readonly default: BarStyle;
    readonly [semantic: string]: BarStyle;
  };
  /** Axis chrome: tick-label colour, gridline stroke + dash pattern. */
  readonly axis: {
    readonly label: string;
    readonly grid: string;
    /** Gridline dash pattern (px on/off pairs); `[]` for solid. */
    readonly gridDash: readonly number[];
    /**
     * Stroke for **session dividers** — the solid verticals a trading-time axis
     * draws at each collapsed gap (session/day open). Optional; falls back to
     * {@link grid}. Set it a touch stronger than the gridlines so a session
     * boundary reads as structural.
     */
    readonly sessionDivider?: string;
    /**
     * The stacked date style's **band** row (the segmented second row: zebra
     * date/month/year cells with left-aligned labels + dividers). `fill` is the
     * shaded (odd-parity) cell background — "could be a background color" per
     * the design; `divider` the turn line (falls back to {@link grid}); `label`
     * the band-label ink (falls back to {@link title}.color → {@link label}).
     * Optional; the whole band row is stacked-only.
     */
    readonly band?: {
      readonly fill: string;
      readonly divider?: string;
      readonly label?: string;
    };
    /**
     * Typography for the axis **title** — the rotated y-axis unit strip and the
     * x-axis label (distinct from the per-tick `label` colour above). Omit a
     * field to fall back: `color` → `label`, `size` → `font.size + 1` (a touch
     * larger than the ticks so the rotated strip reads), `opacity` → `0.85`.
     */
    readonly title?: {
      readonly color?: string;
      readonly size?: number;
      readonly opacity?: number;
    };
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
  /**
   * Styling for the **inferred dashed gap connectors** — the `dashed` and `step`
   * gap modes ({@link GapMode}). Drawn fainter than the solid line (via
   * `connectorOpacity`, 0–1, applied over the layer's colour) so an *inferred*
   * bridge across a gap reads as secondary to measured data. Per-theme, so a
   * dark ground can tune the faintness independently. Falls back to `0.5` if
   * unset. (The `fade` mode has its own gradient and isn't governed by this.)
   */
  readonly gap?: { readonly connectorOpacity: number };
  /**
   * The **annotation register** — the styling for *user-authored* marks
   * (`<Region>` / `<Baseline>` / `<Marker>`), deliberately a distinct hue from
   * the data's `line`/`area`/… so a mark you place never reads as data (the
   * "data stays foam, marks are turquoise" rule). `color` is the shared register
   * hue (lines, region edges + fill, handles, label text); the region fill draws
   * at `fillOpacity`. **Luminosity encodes depth** — brighter reads as forward,
   * dimmer as further back. `depth` is the three-level ramp: `[0]` = level 1
   * (forward / brightest — a selected mark, or an edit-mode line), `[1]` = level 2
   * (mid — a hovered mark, or an edit-mode region body), `[2]` = level 3 (back —
   * the resting, backgrounded state). Cross-row guides draw fainter still (a
   * notional level 4, set in `Layers`). Falls back to a built-in turquoise.
   */
  readonly annotation?: {
    readonly color: string;
    readonly fillOpacity: number;
    readonly depth: readonly [number, number, number];
  };
  /**
   * The **`<Legend>` card** — background, border, and label text of the
   * in-chart series key. **Optional**: when absent the legend derives from
   * existing tokens (`chip.background`, `axis.grid`, `axis.label`), so a
   * hand-built theme keeps compiling and reads coherently without opting in.
   */
  readonly legend?: {
    readonly background: string;
    readonly border: string;
    readonly text: string;
  };
}

/** A resolved line style: stroke colour + width (px). */
export interface LineStyle {
  readonly color: string;
  readonly width: number;
  /**
   * Optional dash pattern — px on/off lengths (`[6, 4]` = 6 on, 4 off; `[2, 3]`
   * ≈ dotted). Omit or `[]` for a solid stroke. This is the *series'* own style
   * — distinct from a {@link GapMode}'s inferred faint gap-bridge dashing (that
   * marks missing data; this marks the whole line). Use it to set a **modeled**
   * series (a forecast / smoothed estimate, e.g. GARCH vol) apart from an
   * observed one at a glance.
   */
  readonly dash?: readonly number[];
}

/** A resolved band style: fill colour + opacity (0–1) for the variance envelope. */
export interface BandStyle {
  readonly fill: string;
  readonly opacity: number;
}

/**
 * A resolved scatter point style — the single styling channel for the base
 * mark. `color` fills each point and `radius` (px) sizes it (both the fallback
 * when a data-driven encoding leaves a point unencoded). `outline`/`outlineWidth`
 * stroke a ring around each point for legibility on a busy plot; the *selected*
 * point is restroked with `selectedOutline` at `selectedWidth` to lift it.
 * `label` colours the optional per-point text (the font comes from `theme.font`).
 */
export interface ScatterStyle {
  readonly color: string;
  /** Base point radius in px (data-driven radius overrides this per point). */
  readonly radius: number;
  /** Per-point outline stroke colour. */
  readonly outline: string;
  /** Per-point outline width in px. */
  readonly outlineWidth: number;
  /** Outline colour for the selected point (the highlight ring). */
  readonly selectedOutline: string;
  /** Outline width for the selected point (px) — wider than `outlineWidth`. */
  readonly selectedWidth: number;
  /** Colour of the optional per-point text label. */
  readonly label: string;
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
 * A resolved candlestick style ({@link Candlestick}). A candle is unreadable in
 * one colour — rising vs falling *must* differ to mean anything — so the style
 * is a **pair**: `rising` (close > open) and `falling` (close < open), each a
 * `body` (the open→close rectangle / the OHLC bar) and a `wick` (the high–low
 * line / the bar's stem). `neutral` styles a **doji** (open === close); it falls
 * back to `rising` when unset. `bodyWidth` is the body's fraction of the candle
 * slot (0–1; the wick always sits at the slot centre) — omitted ⇒ `0.8`.
 * `wickWidth` is the wick / bar stroke width in px.
 *
 * With `colorBy='series'` the direction split is bypassed and every candle draws
 * in the `rising` colours (one colour = one series, for a candle sitting beside
 * coloured lines).
 */
export interface CandleStyle {
  /** Rising candle (close > open) — body + wick colours. Also the single colour
   *  under `colorBy='series'`. */
  readonly rising: { readonly body: string; readonly wick: string };
  /** Falling candle (close < open) — body + wick colours. */
  readonly falling: { readonly body: string; readonly wick: string };
  /** Doji (open === close) — body + wick colours; falls back to `rising` if unset. */
  readonly neutral?: { readonly body: string; readonly wick: string };
  /** Body width as a fraction of the candle slot (0–1). Omitted ⇒ `0.8`. */
  readonly bodyWidth?: number;
  /** Wick / OHLC-bar stroke width in px. */
  readonly wickWidth: number;
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
 * A resolved bar style: the flat `fill` (scaled by `opacity`, 0–1) plus the
 * `highlight` colour the selected bar takes (also its outline), and the bar
 * geometry — `gap` (px between adjacent bars, the default for `<BarChart gap>`)
 * and `minWidth` (the px floor so a too-thin bucket stays visible) handed to
 * `barSpanPx`, with `outlineWidth` for the selected-bar stroke.
 */
export interface BarStyle {
  readonly fill: string;
  readonly opacity: number;
  readonly highlight: string;
  readonly gap: number;
  readonly minWidth: number;
  readonly outlineWidth: number;
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
  scatter: {
    // Brand blue fill with a white ring (legible on a busy plot); the selected
    // point gets a darker, wider ring. `primary`/`secondary` mirror the line
    // roles so a scatter overlaid on a line can share its identity.
    default: {
      color: '#2563eb',
      radius: 4,
      outline: '#ffffff',
      outlineWidth: 1,
      selectedOutline: '#1e293b',
      selectedWidth: 2,
      label: '#334155',
    },
    primary: {
      color: '#2563eb',
      radius: 4,
      outline: '#ffffff',
      outlineWidth: 1,
      selectedOutline: '#1e293b',
      selectedWidth: 2,
      label: '#334155',
    },
    secondary: {
      color: '#e8836b',
      radius: 4,
      outline: '#ffffff',
      outlineWidth: 1,
      selectedOutline: '#1e293b',
      selectedWidth: 2,
      label: '#334155',
    },
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
      whisker: '#aabee9',
      whiskerWidth: 1,
    },
  },
  candle: {
    // Neutral / unbranded up-down pair — *not* market green/red (a consumer
    // supplies that via cssVarTheme). Rising reuses the brand blue; falling the
    // warm secondary accent — distinguishable at a glance on the light ground.
    default: {
      rising: { body: '#2563eb', wick: '#1e3a8a' },
      falling: { body: '#e8836b', wick: '#b4442a' },
      neutral: { body: '#94a3b8', wick: '#64748b' },
      bodyWidth: 0.7,
      wickWidth: 1,
    },
  },
  bar: {
    // Flat blue fill; the selected bar brightens + outlines. `secondary` reuses
    // the line's warm accent for a second series.
    default: {
      fill: '#2563eb',
      opacity: 0.85,
      highlight: '#1d4ed8',
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
    },
    secondary: {
      fill: '#e8836b',
      opacity: 0.85,
      highlight: '#d65f43',
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
    },
  },
  axis: {
    label: '#64748b',
    grid: '#e2e8f0',
    gridDash: [2, 2],
    sessionDivider: '#cbd5e1', // slate-300 — a step stronger than the gridlines
    band: {
      fill: '#f8fafc', // slate-50 — the zebra shade on the stacked band row
      divider: '#cbd5e1', // slate-300 turn line
      label: '#334155', // slate-700 ink for band labels
    },
  },
  font: {
    family: 'system-ui, -apple-system, sans-serif',
    size: 11,
  },
  cursor: '#64748b',
  chip: { background: '#ffffff' },
  gap: { connectorOpacity: 0.5 },
  // Teal marks register — distinct from the blue data, reads on the light ground.
  annotation: {
    color: '#0d9488',
    fillOpacity: 0.1,
    depth: [1, 0.7, 0.4],
  },
  // The in-chart series key: chip-white card, gridline border, axis-label text.
  legend: {
    background: '#ffffff',
    border: '#e2e8f0',
    text: '#64748b',
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
  scatter: {
    // Brand-teal points ringed in the dark ground so they read as discrete
    // marks; the selected point gets the bright reef ring (the tracker colour).
    // `foam`/`hr` mirror the line roles for a scatter overlaid on those traces.
    default: {
      color: '#15B3A6', // --es-estela
      radius: 4,
      outline: '#06191D', // --es-bg (ring punches the point off the ground)
      outlineWidth: 1,
      selectedOutline: '#7FE2D2', // --es-reef (matches the tracker highlight)
      selectedWidth: 2,
      label: '#DBEAE8', // --es-mist (legible label on the dark ground)
    },
    foam: {
      color: '#F1FBF9', // --es-foam (motion — shared primary trace)
      radius: 4,
      outline: '#06191D',
      outlineWidth: 1,
      selectedOutline: '#7FE2D2',
      selectedWidth: 2,
      label: '#DBEAE8', // --es-mist
    },
    hr: {
      color: '#E0B36A', // --es-filament (rare warm accent — heart rate)
      radius: 4,
      outline: '#06191D',
      outlineWidth: 1,
      selectedOutline: '#7FE2D2',
      selectedWidth: 2,
      label: '#DBEAE8', // --es-mist
    },
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
      whisker: '#a4e4d9', // --es-reef
      whiskerWidth: 1.5,
    },
  },
  candle: {
    // On the dark ground: brand teal rising, warm filament falling — the estela
    // palette's own up/down, still *not* literal green/red (a financial consumer
    // like Tidal overlays its market palette via cssVarTheme).
    default: {
      rising: { body: '#15B3A6', wick: '#0E7D74' }, // --es-estela
      falling: { body: '#E0B36A', wick: '#B4863F' }, // --es-filament
      neutral: { body: '#4E6B6B', wick: '#DBEAE8' }, // --es-slate / --es-mist
      bodyWidth: 0.7,
      wickWidth: 1.5,
    },
  },
  bar: {
    // Brand-teal fill on the dark ground; the selected bar lifts to the bright
    // reef + an outline. `secondary` is the warm filament accent.
    default: {
      fill: '#15B3A6', // --es-estela
      opacity: 0.85,
      highlight: '#7FE2D2', // --es-reef (bright on the dark ground)
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
    },
    secondary: {
      fill: '#E0B36A', // --es-filament
      opacity: 0.85,
      highlight: '#F1D9A8',
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
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
  gap: { connectorOpacity: 0.5 },
  // Marks register: --es-reef, estela's bright attention turquoise (the same hue
  // as the cursor / selected highlight) — distinct from the foam (white) data.
  annotation: {
    color: '#7FE2D2', // --es-reef
    fillOpacity: 0.1,
    depth: [1, 0.7, 0.4],
  },
  // The in-chart series key on the dark ground: deep panel, abyss-line border.
  legend: {
    background: '#0B4E58', // --es-deep (the chip panel)
    border: '#1B6B75',
    text: '#B7D9DD',
  },
};
