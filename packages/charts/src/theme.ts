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
   * Map from a heat map's semantic identifier to its **interaction states**
   * ({@link HeatMap}). Optional throughout; with no `heat` slot a live cell
   * takes the pre-states treatment (one outline per cell, in
   * `bar.highlight`).
   *
   * **Only the states, and deliberately so.** A heat map's *geometry* is
   * bar-family — the slot gap, the minimum bin width, the outline weight —
   * and it reads all of it from `bar[semantic] ?? bar.default`, which is
   * right: a cell is a bar's slot with colour instead of height. What it
   * cannot share is state styling, because a bar's fill is free and a cell's
   * fill **is the datum** (see {@link HeatStates}). So the split is between
   * the two things, not an accident of where the tokens landed.
   */
  readonly heat?: {
    readonly default: HeatStates;
    readonly [semantic: string]: HeatStates;
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
   * The **drag band** — the live region the shared brush paints while a drag
   * is in flight (`<RangeCursor>`'s band and `<MultiSelector>`'s sweep are the
   * same pixels; see `renderBrushBand`). `fill` washes the covered span and
   * `edge` hairlines its two boundaries at 1px, so the band has a readable
   * start/end while the gesture is still live.
   *
   * **Optional, and back-compatible when omitted:** with no `brush` the band
   * falls back to the cursor ink at 0.12 with no edges — byte-for-byte what
   * every theme drew before this token existed. `defaultTheme` opts in with
   * the *selection* blue at 7%: the band is about to become a selection, so it
   * should be the same hue as one (whereas the resting bars are teal).
   */
  readonly brush?: {
    /**
     * The band's wash. Drawn at **full element opacity**, so carry the alpha
     * in the colour (`rgba(…, 0.07)`) — a solid hex here paints over the marks
     * the band is supposed to be previewing.
     */
    readonly fill: string;
    /** Stroke for the band's 1px start/end edges. Omit for a fill-only band. */
    readonly edge?: string;
  };
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
    /**
     * Optional dash pattern for the register's **lines** — px on/off lengths,
     * the same shape as {@link LineStyle.dash} (`[6, 4]` = 6 on, 4 off). Omit or
     * `[]` for solid strokes. Applies to a marker's / baseline's line and to
     * region + zone boundaries; fills are never dashed.
     *
     * Worth reaching for when marks share a plot with data lines: a *dashed*
     * reference line reads as placed rather than measured, doing the "this isn't
     * data" work that colour alone can't when the register hue is near a series
     * hue. Set it per {@link roles | role} to dash one kind of mark only.
     */
    readonly dash?: readonly number[];
    /**
     * **Optional per-role overrides** — a small map from a role name to its
     * `color` (and optionally `fillOpacity` / `dash`), so distinct marks can be
     * styled at once without splitting the whole register: a `<Baseline
     * role="atm">` green, a `<Marker role="ref">` in another hue, a `<Zone
     * role="good">` per band of a value-axis scale — each still drawn through
     * the shared {@link depth} ramp. A mark's `role` resolves
     * `roles[role] ?? { color, fillOpacity, dash }` (an unknown/unset role is
     * the base register). Colour stays a **theme** concern — there is no
     * per-mark colour prop (the one-styling-channel discipline), which is why a
     * *scale* of bands (AQI categories, HR zones) is a role map and not six
     * colours at the call site.
     */
    readonly roles?: {
      readonly [role: string]: {
        readonly color: string;
        readonly fillOpacity?: number;
        readonly dash?: readonly number[];
      };
    };
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
  /**
   * The **row-chart register** — `<BarList>` / `<BoxList>`, whose row states
   * live on chrome the canvas has no equivalent of.
   *
   * A row chart cannot signal state the way a column chart does. Two reasons,
   * and the second is the load-bearing one:
   *
   * - **The row is the target, not the bar.** A vertical bar can be its own
   *   hit area because every mark spans the full column width; a row's mark
   *   is as short as its value, so a 4% row would be a 30px sliver. The
   *   label gutter, the track and the trailing value are one target, and the
   *   thing that lights has to be the whole **band**.
   * - **The band carries selection alone.** In a multi-metric row the fill
   *   *is* the identity of the metric, so it cannot also carry state — the
   *   same channel rule the canvas marks follow. Band + rail must read as
   *   selected with no help from the fill, and designing the single-metric
   *   case that way too means one treatment covers every row chart.
   *
   * So the two values here are the ones with no canvas counterpart: the row
   * **band** tints. Everything else resolves from tokens that already exist
   * and are per-metric where they should be — a selected fill takes
   * {@link BarStyle.highlight}, a dimmed one {@link BarStyle.dimmed} — so a
   * consumer who themes their bars gets a coherent list without theming it
   * twice.
   *
   * **The rail is deliberately NOT per-metric.** There is one rail per row
   * and a row may carry several metrics, so it cannot resolve through
   * `bar[as]` the way a fill does; it lives here with the bands.
   *
   * **Optional, and back-compatible when omitted:** with no `list` the rows
   * keep exactly the pre-token look — a hover band from `legend.border`, a
   * selection rail from the annotation register, and no dimmed state at all.
   */
  readonly list?: {
    /** Row stripe behind the hovered row — the whole band, gutter to value. */
    readonly hoverBand: string;
    /** The hovered row's 3px inset left edge. Never the selection hue. */
    readonly hoverRail: string;
    /** Row stripe behind a selected row. */
    readonly selectedBand: string;
    /** The selected row's 3px inset left edge. */
    readonly selectedRail: string;
    /**
     * Reference ink — per-row target markers, thresholds, reference ticks.
     *
     * **Reserved away from the selection hue on purpose.** On a bullet row
     * the marker sits *inside* the mark that selection recolors, so a tick
     * in the selection blue is the one collision the rest of the language
     * cannot absorb: you could not tell a target from a selected bar.
     */
    readonly markerInk: string;
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
  /**
   * The **interaction states** — fill and size per state, and the whole
   * styling channel for a live point when set. Unset ⇒ the pre-states
   * behaviour exactly: every point keeps its resting fill and radius, and a
   * live one is merely re-ringed in `selectedOutline`/`selectedWidth`.
   *
   * A scatter can afford what a candle cannot. A candle's hue *is* its
   * meaning (rising vs falling), so it carries state in weight and alpha
   * alone; a heat cell's colour is its value, so it carries state in chrome.
   * A point's colour encodes nothing by default, so it is free to recolour —
   * and it also has a channel none of the column marks have: **size**.
   *
   * That is why hover and selection split the channels rather than sharing
   * them. See {@link ScatterStates}.
   */
  readonly states?: ScatterStates;
}

/**
 * A scatter point's per-state fill and size ({@link ScatterStyle.states}).
 *
 * The radii are given in px against {@link ScatterStyle.radius}, and applied
 * as the **ratio** between them — so a data-driven `radius` encoding still
 * grows and shrinks by the same proportion instead of being flattened to one
 * size the moment a point goes live.
 */
export interface ScatterStates {
  /**
   * Fill for a **hovered** point — or one under a live drag rect, which is
   * the same state (the sweep lights its covered marks through the plural
   * `hovered`). A brightened form of the resting colour, not a new hue: the
   * preview says "these are the ones", and saying it in the committed colour
   * would make the preview and the commit read alike.
   */
  readonly hover: string;
  /** Hovered radius (px). Hover is the state that spends **size** — it is the
   *  channel a lone pointer-over can afford, and a hover does not have to
   *  survive being read against a whole field of committed marks. */
  readonly hoverRadius: number;
  /**
   * Fill for a **selected** point. Its radius is deliberately left at
   * {@link ScatterStyle.radius}: selection spends **hue** instead, so
   * committing a sweep does not reflow the cloud under the pointer.
   */
  readonly selected: string;
  /** The ring around a live (hovered or selected) point — what keeps
   *  overlapping points countable once a whole swept region shares one fill. */
  readonly halo: string;
  /** Halo width (px); `0` draws none. */
  readonly haloWidth: number;
  /**
   * Radius (px) of a point **outside a non-empty selection**. It shrinks as
   * well as fading because alpha alone at these levels thins a cloud to
   * nearly nothing, and the shape of the unselected field is the thing a
   * scatter's background is *for*.
   */
  readonly dimmedRadius: number;
  /** Alpha of a point outside a non-empty selection. */
  readonly dimmedOpacity: number;
}

/**
 * A heat map's **interaction states** ({@link ChartTheme.heat}).
 *
 * A cell has no spare channel at all. A bar's fill is free, so a bar swaps it;
 * a point's colour encodes nothing by default, so a point recolours *and*
 * resizes. A cell's colour **is** its value, and its rect is the grid — so
 * every state here is **chrome added around the cell** or a transform applied
 * uniformly to all of them, and none of them repaints a cell in a colour the
 * ramp could also have produced.
 */
export interface HeatStates {
  /**
   * The flat overlay painted over a cell **outside a non-empty selection** —
   * carry the alpha in the colour (`rgba(255,255,255,0.62)`), because it is
   * composited over the cell, not applied as one.
   *
   * **A flat overlay, not `globalAlpha`, and the difference is the whole
   * point.** Alpha and value are the same channel on a ramp, so fading a cell
   * slides it along the scale — a dimmed dark cell becomes a resting mid one.
   * An overlay is *uniform and monotonic*: every cell moves by the same
   * transform, so the ramp's **order survives inside the veiled set** and only
   * the cross-set comparison is ambiguous — which is exactly what the
   * {@link perimeter} is there to disambiguate.
   *
   * It is also why this is a colour and not a number: opacity composites with
   * whatever is *behind* the cell (a gridline, a non-white background, another
   * layer), so the same value would veil to different colours in different
   * charts. An overlay is a property of the cell.
   */
  readonly veil: string;
  /**
   * The hovered cell's **double ring**, outer colour first — two concentric
   * rings of {@link ringWidth}, both inside the cell.
   *
   * A single ring cannot work against a ramp: a light ring vanishes at the
   * pale end and a dark one at the dark end, and a cell can be anywhere on the
   * scale. The pair guarantees one of the two reads wherever the cell happens
   * to sit. (The same problem `bar.binFills` has, and a better answer than
   * picking one colour and hoping.)
   */
  readonly hoverRing: readonly [string, string];
  /** Width of each of the two hover rings, in px. */
  readonly ringWidth: number;
  /**
   * The selected region's **perimeter** — one outline around the union of
   * selected cells, not one per cell.
   *
   * Per-cell outlines are what this replaces, and the reason is legible in any
   * screenshot of them: a bordered grid is mostly border, and every interior
   * line says nothing, because it is interior to the selection. Drawn by
   * suppressing each cell edge whose neighbour is also selected, so a
   * selection in several disconnected pieces gets one outline **per piece**,
   * and a hole in the middle of one gets its own — no connectivity pass, and
   * no assumption that a selection is a single rectangle.
   */
  readonly perimeter: string;
  /** Perimeter stroke width, in px. */
  readonly perimeterWidth: number;
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
  /**
   * The **tint ladder** — one four-step ladder per interaction state, and the
   * whole styling channel for a box when set. Unset ⇒ the flat
   * `fill`/`stroke`/`median`/`whisker` tokens above, unchanged.
   *
   * Every mark of a box reads its step from the *same* ladder
   * ({@link BoxLadder} documents which step is which), so a state change is a
   * **single palette swap** rather than four independent colour decisions.
   * That is what keeps the quantile read intact across states: the ladder
   * carries its meaning in *lightness*, so moving the whole ladder — brighter
   * teal on hover, blue when committed — leaves every relationship between the
   * marks untouched.
   *
   * Two consequences worth stating, because both are the opposite of what the
   * multi-hue `bar` palette needs:
   *
   * - **Shift the ladder, not one step.** Recolouring only the median, or only
   *   the body, breaks the read. All four steps move together and keep their
   *   relative lightness spacing.
   * - **Dim without desaturating.** A single-hue ladder has nothing to muddy
   *   into, so {@link dimmedOpacity} alone is the receded state — no
   *   desaturated companion ladder of the kind `bar.groupsDimmed` needs.
   */
  readonly states?: BoxStates;
  /**
   * Stroke width for a **selected** box's hairlines — the body outline and the
   * whiskers both. Unset ⇒ they keep {@link strokeWidth} / {@link whiskerWidth}.
   *
   * A hairline cannot carry a state in hue alone: at 1px a colour change is
   * nearly invisible, and the whisker is the mark that reaches furthest. A
   * weight change is legible at any width, so selection bumps it (1 → 1.5 on
   * `defaultTheme`) alongside the ladder swap.
   */
  readonly selectedStrokeWidth?: number;
}

/**
 * A box's four tint steps, lightest → darkest. Which mark reads which step:
 *
 * | step | box plot        | quantile bands |
 * | ---- | --------------- | -------------- |
 * | `0`  | body fill / the solid shape's outer bar | outer band |
 * | `1`  | the solid shape's inner q1→q3 bar        | inner band |
 * | `2`  | body stroke + whiskers                   | —          |
 * | `3`  | the median rule                          | median rule |
 *
 * Steps are *positions on one hue's lightness ramp*, not four palette entries —
 * a ladder whose steps don't descend in lightness stops encoding anything.
 */
export type BoxLadder = readonly [string, string, string, string];

/** The per-state ladders (see {@link BoxStyle.states}). */
export interface BoxStates {
  /** Nothing selected anywhere. */
  readonly rest: BoxLadder;
  /** Pointer over this box — a preview of what a click would commit, so it
   *  sits between {@link rest} and {@link selected} in strength. */
  readonly hover: BoxLadder;
  /** Committed. Pairs with {@link BoxStyle.selectedStrokeWidth}. */
  readonly selected: BoxLadder;
  /** How far a box **outside** a non-empty selection recedes — the
   *  {@link rest} ladder at this alpha. No separate ladder, and deliberately
   *  no desaturation (see {@link BoxStyle.states}). */
  readonly dimmedOpacity: number;
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
  /**
   * The **interaction state** cues — and note what is *missing* from them.
   *
   * A `bar` swaps its fill and a `box` rotates its whole tint ladder, because
   * on those marks hue is free: the meaning lives in position and in lightness
   * ordering. **A candle's hue is its meaning** — rising vs falling is the
   * first thing anyone reads off it — so a candle introduces *no state colour
   * at all*, not even for its outline. Every cue here is a change of weight or
   * of alpha:
   *
   * - **Live** (hovered *or* selected) — the candle **grows**: its body is
   *   stroked in its own colour and its lines thicken to
   *   {@link liveWickWidth}, so the mark gets a little heavier and nothing
   *   else about it changes. Nothing is recoloured, and nothing is added that
   *   the chart doesn't otherwise draw.
   * - **Selected** — the same, plus the rest of the field recedes to
   *   {@link dimmedOpacity}. The dimming is what separates a committed
   *   selection from a passing hover, since the lit mark looks identical
   *   either way.
   *
   * That last point is deliberate but worth knowing: hover and selection are
   * distinguished by what happens to the *other* candles, not by this one.
   *
   * Both optional; unset ⇒ a display-only candle exactly as before.
   */
  readonly dimmedOpacity?: number;
  /**
   * Line weight for a **live** (hovered or selected) candle — its wick, and
   * the stroke around its body that makes the mark grow.
   *
   * Unlike {@link BoxStyle.selectedStrokeWidth}, which only selection triggers,
   * this fires on hover too: a box announces hover by moving its tint ladder,
   * and a candle has no ladder to move.
   */
  readonly liveWickWidth?: number;
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
  /**
   * Fill flat instead of grading to transparent at the baseline. Default
   * (omitted / `false`) keeps the gradient — the elevation look a single area
   * wants.
   *
   * Set it for **stacked** areas. A stack is drawn as overlapping cumulative
   * bands, so a fade to transparent at the baseline lets every band below show
   * through the one above it and the composition reads as mush. A flat fill is
   * what makes the slabs opaque to each other. (`fillOpacity` still applies, so
   * a stack can be uniformly translucent — just not *graded*.)
   */
  readonly flatFill?: boolean;
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
  /**
   * Optional distinct **hover** fill, so a bar can read a three-step emphasis —
   * `fill` at rest → `hover` under the pointer → `highlight` (+ outline) when
   * selected. **Omitted ⇒ `highlight`**, which is the shipped behaviour: hover
   * and select share one colour and differ only by the selected bar's outline.
   *
   * The scatter analogue is `outline` vs {@link ScatterStyle.selectedOutline} —
   * bars were the less expressive layer for the same two-state interaction
   * ([#577](https://github.com/pond-ts/pond/issues/577)). This is the *hover*
   * half rather than a rename of `highlight`, so no existing theme changes
   * meaning; a theme that wants the distinction opts in by adding one colour.
   *
   * **Where it applies.** Read by the `drawBars` single-series path, which
   * since [PND-BARSEM] covers every **one-segment vertical** bar however it
   * was fed — a `series` + `column` chart, a one-column `bins` histogram, or
   * a one-entry `columns`. Still not read by:
   *
   * - a genuine **multi-group stack** (`columns` / a `Map` series), whose
   *   {@link StackStyle} has no hover channel — segments in one bin would
   *   need their own hovered identity;
   * - **`categories`** and **horizontal** charts, which keep the transposed
   *   stacked draw path ([PND-HCAT] tracks the categorical half);
   * - **`binColors`** (per-bar colours), which pops each bar's *own* fill for
   *   both states so a red/green volume bar keeps its meaning while live —
   *   the one *design* exclusion rather than a path consequence.
   *
   * The **decimated** dense-bar pass also draws the flat fill only, as it
   * already did for `highlight`.
   */
  readonly hover?: string;
  /**
   * The **threshold-band ladder** — ordered fills for a bar coloured *along its
   * length* against `<BarChart thresholds>`: `bands[0]` up to the first
   * threshold, `bands[1]` between the first and second, and so on. A ladder of
   * `n` thresholds reads `n + 1` entries.
   *
   * This lives on `BarStyle` rather than as a `theme.bar.bands` sibling because
   * `theme.bar` is a semantic **map** (`{ default, [semantic]: BarStyle }`) — a
   * top-level key would collide with a role of that name. Per-role is also the
   * more useful shape: `bar.default.bands` and `bar.capacity.bands` can differ,
   * and the ladder resolves through the same `bar[semantic] ?? bar.default`
   * lookup as every other bar colour.
   *
   * **Overridden by `<BarChart bandColors>`** at the call site. If neither
   * resolves enough entries for the ladder, the bar falls back to its flat
   * {@link fill} and (in dev) warns — a silently-unbanded bar is exactly the
   * failure mode [PND-BANDBAR2] exists to remove.
   *
   * Read by the single-series `drawBars` path and by the `G === 1` stacked path
   * (which is where `categories` and every horizontal bar live). A genuine
   * **multi-group stack** ignores it and warns: banding a segment that is
   * already one slice of a total has no defined meaning.
   */
  readonly bands?: readonly string[];
  /**
   * The **stack group ramp** — ordered fills for a *multi-group* stack's
   * segments, `groups[0]` for the first (bottom / left) group. Cycles when the
   * stack has more groups than the ramp has entries.
   *
   * Sibling of {@link bands}, and here for the same reason (a `theme.bar`
   * top-level key would collide with a role of that name) — but a different
   * axis: `bands` colours one bar *along its length* against a threshold
   * ladder, this colours *across the groups* of one bin.
   *
   * **Multi-group only.** A ramp exists to tell groups apart, so with one group
   * there is nothing to tell apart and the bar keeps its {@link fill} — which
   * is what keeps every categorical and single-series chart (both of which run
   * the stacked draw path with `G === 1`) exactly as it was.
   *
   * Resolution order per group: `<BarChart colors>` → a theme role named after
   * the group (`bar.web`) → this ramp → {@link fill}. So a named role still
   * wins, and the ramp is the fallback that makes an *unthemed* stack legible
   * instead of painting every segment one colour.
   */
  readonly groups?: readonly string[];
  /**
   * The receded counterpart of {@link groups}, same order and cycling — what a
   * segment fades to when a selection exists elsewhere.
   *
   * Per-group rather than the flat {@link dimmed}, because a stack dimmed to a
   * single colour stops being a stack: the segment boundaries vanish and the
   * unselected columns read as solid blocks. Each entry is its ramp colour
   * desaturated and lightened, so the bin keeps its structure while clearly
   * receding.
   */
  readonly groupsDimmed?: readonly string[];
  /**
   * The **hovered** counterpart of {@link groups}, same order and cycling.
   *
   * Per-group for the reason the flat {@link hover} cannot be: one hover
   * colour repaints whichever segment the pointer is over in a hue belonging
   * to a different group, so pointing at a stack momentarily *erases the
   * ramp* — and under a `<MultiSelector>`, where hover is block-scoped, it
   * erases the whole bin at once. Each entry is its ramp colour brightened
   * (same hue, lighter), the same relationship {@link fill} has to
   * {@link hover}.
   */
  readonly groupsHover?: readonly string[];
  /**
   * Stroke for a **selected** bar's outline, where the default is the bar's own
   * resolved fill. The one selection cue that still works when the fill cannot
   * change — a `binColors` bar keeps its own colour by design, so without this
   * the alpha pop was the whole signal and nothing about it was themeable
   * ([PND-CATEMPH]).
   */
  readonly selectedOutline?: string;
  /**
   * The alpha a hovered / selected bar pops to. **Default `1`** (the shipped
   * behaviour). Previously the pop was hard-coded, so a theme could set the
   * resting {@link opacity} floor but not the *difference* between resting and
   * live — which is the part that reads as emphasis.
   */
  readonly emphasisOpacity?: number;
  /**
   * The fill for a bar that is **not** in a non-empty selection set — the
   * "everything else recedes" state a chart used as a filter control needs
   * ([PND-MULTISEL]).
   *
   * **Opt-in by construction:** a theme that sets no `dimmed` dims nothing, so
   * existing charts are untouched (RFC `selection.md` A2.3 — the library never
   * auto-dims; the theme carries the selection-state styling and the library
   * references it by state). Nothing dims while the set is empty either: with
   * no selection there is nothing to recede *from*.
   *
   * It exists because "not in the selection" was otherwise re-invented per
   * component, and drifted immediately — one consumer had three charts using
   * `color-mix` at 22%, 28% and 30% for the same concept, in the same week, for
   * no reason. One theme value fixes that permanently.
   */
  readonly dimmed?: string;
}

/**
 * The neutral default theme. The shared data hue is a cerulean (`#0284c7`)
 * across `line` / `band` / `area` / `scatter` / `box` / candle-rising, chosen
 * to clear the bar palette's *selection* blue (`#3F5BE0`) — the original M1
 * royal blue (`#2563eb`) sat ~ΔE 5 from it, so a line drawn over bars read as
 * nearly the selection colour. `primary` / `secondary` / `context` are a
 * built-in generic role vocabulary; an unrecognised (e.g. domain-specific)
 * identifier falls back to `default`.
 *
 * **Spreading this inherits every slot you don't override** — including colours
 * for layers you haven't added yet, so a `{ ...defaultTheme, bar: … }` theme
 * paints this blue the first time someone drops in a `<LineChart>`. That is the
 * intended workflow, not a trap: take the defaults, change the one or two things
 * that are yours. A design system that must own *every* colour should assert on
 * that in its own test rather than catch it in review — walk the resolved theme
 * for values outside your palette ([PND-THEMEBASE]).
 *
 * **The `bar` slot is the exception to "one blue".** Bars carry an interaction
 * state (rest / hover / selected / dimmed), and encoding four states as four
 * shades of one hue is unreadable — so `bar.default` runs its own
 * **interaction-state palette**: teal at rest, blue when selected, brighter
 * teal on hover. See the comment on that slot, and `brush` for the matching
 * drag band.
 */
export const defaultTheme: ChartTheme = {
  line: {
    default: { color: '#0284c7', width: 1.5 },
    primary: { color: '#0284c7', width: 1.5 },
    secondary: { color: '#e8836b', width: 1.5 },
    context: { color: '#5eb5a6', width: 1.5 },
  },
  band: {
    default: { fill: '#0284c7', opacity: 0.15 },
    outer: { fill: '#0284c7', opacity: 0.1 },
    inner: { fill: '#0284c7', opacity: 0.2 },
  },
  area: {
    // Outline at the line colour; graded fill from it. `in`/`out` are the
    // above/below-axis roles (esnet traffic), composed as two layers.
    default: {
      color: '#0284c7',
      width: 1.5,
      fill: '#0284c7',
      fillOpacity: 0.3,
    },
    in: { color: '#0284c7', width: 1.5, fill: '#0284c7', fillOpacity: 0.3 },
    out: { color: '#e8836b', width: 1.5, fill: '#e8836b', fillOpacity: 0.3 },
  },
  scatter: {
    // A 9px teal point with a white ring (legible on a busy plot), and the
    // shared `states` ladder over it. `primary`/`secondary` keep the LINE
    // roles' hues — that identity is the whole reason they exist, so a
    // scatter overlaid on a line still reads as the same series — and take
    // the same states with their own hue brightened for hover.
    //
    // The default role's rest is `#2A9D8F`, the bar's resting teal, and NOT
    // the old cerulean `#0284c7`: blue has to mean *committed*, and a
    // cerulean point going to selection blue is barely a change. Same rule
    // the bar palette reached, for the third time.
    default: {
      color: '#2A9D8F',
      radius: 4.5,
      outline: '#ffffff',
      outlineWidth: 1,
      selectedOutline: '#1e293b',
      selectedWidth: 2,
      label: '#334155',
      states: {
        hover: '#4FD0BE',
        hoverRadius: 5.5,
        selected: '#3F5BE0', // the shared selection blue
        halo: '#ffffff',
        haloWidth: 2,
        dimmedRadius: 2.5,
        dimmedOpacity: 0.34,
      },
    },
    primary: {
      color: '#0284c7',
      radius: 4.5,
      outline: '#ffffff',
      outlineWidth: 1,
      selectedOutline: '#1e293b',
      selectedWidth: 2,
      label: '#334155',
      states: {
        hover: '#38bdf8', // the primary cerulean, brightened
        hoverRadius: 5.5,
        selected: '#3F5BE0', // the shared selection blue
        halo: '#ffffff',
        haloWidth: 2,
        dimmedRadius: 2.5,
        dimmedOpacity: 0.34,
      },
    },
    secondary: {
      color: '#e8836b',
      radius: 4.5,
      outline: '#ffffff',
      outlineWidth: 1,
      selectedOutline: '#1e293b',
      selectedWidth: 2,
      label: '#334155',
      states: {
        hover: '#f5a991', // the secondary coral, brightened
        hoverRadius: 5.5,
        selected: '#3F5BE0', // the shared selection blue
        halo: '#ffffff',
        haloWidth: 2,
        dimmedRadius: 2.5,
        dimmedOpacity: 0.34,
      },
    },
  },
  heat: {
    // A cell's colour is its value, so every state here is chrome around the
    // cell (or one uniform transform over all of them) — see `HeatStates`.
    default: {
      veil: 'rgba(255,255,255,0.62)',
      // White outside, dark teal inside: one of the pair reads wherever on
      // the ramp the cell happens to sit.
      hoverRing: ['#ffffff', '#12564E'],
      ringWidth: 2,
      // The shared selection blue — a selected region beside a selected bar
      // reads as one act.
      perimeter: '#3F5BE0',
      perimeterWidth: 2,
    },
  },
  box: {
    // The cerulean data box: a translucent fill outlined in the line colour, a
    // bolder median, and matching whiskers.
    default: {
      fill: '#0284c7',
      fillOpacity: 0.3,
      stroke: '#0284c7',
      // 1px at rest, 1.5 when selected (`selectedStrokeWidth`) — the design's
      // hairline rule. Previously a flat 1.5, which left no headroom for a
      // weight change to mean anything.
      strokeWidth: 1,
      median: '#075985',
      medianWidth: 2,
      whisker: '#a3cde5',
      whiskerWidth: 1,
      // The tint ladder. Lightness spacing is held across all three ladders,
      // so the quantile read (outer < inner < stroke < median) never changes —
      // only where the ladder sits does. It follows the bar palette's rule
      // exactly: hover brightens within teal, blue means committed. Step 2 of
      // each ladder IS the matching bar token (`bar.hover` / `bar.highlight`),
      // so a live box beside a live bar reads as one act.
      states: {
        rest: ['#BFE3DE', '#7FC8BF', '#2A9D8F', '#1F7A6F'],
        // Hover brightens *within teal* — blue stays reserved for a committed
        // selection, the same rule `bar.hover` follows (and step 2 is exactly
        // `bar.default.hover`, so a hovered box and a hovered bar match).
        hover: ['#D6F1EC', '#9CDBD1', '#3FBFAE', '#2A9D8F'],
        selected: ['#C0CAF6', '#8095EA', '#3F5BE0', '#1C2E9E'],
        dimmedOpacity: 0.32,
      },
      selectedStrokeWidth: 1.5,
    },
    // The warm accent box — the second series of a paired distribution (an
    // in/out traffic list), mirroring `bar.secondary` / `line.secondary`.
    secondary: {
      fill: '#e8836b',
      fillOpacity: 0.3,
      stroke: '#d65f43',
      strokeWidth: 1.5,
      median: '#b4442a',
      medianWidth: 2,
      whisker: '#f0c2b2',
      whiskerWidth: 1,
    },
  },
  candle: {
    // Neutral / unbranded up-down pair — *not* market green/red (a consumer
    // supplies that via cssVarTheme). Rising reuses the data cerulean; falling
    // the warm secondary accent — distinguishable at a glance on light ground.
    default: {
      rising: { body: '#0284c7', wick: '#075985' },
      falling: { body: '#e8836b', wick: '#b4442a' },
      neutral: { body: '#94a3b8', wick: '#64748b' },
      bodyWidth: 0.7,
      wickWidth: 1,
      // No state colour at all — the direction hue owns that channel. A live
      // candle simply grows (its body stroked in its own colour, lines
      // heavier); a selection additionally recedes the field to `.32`, the
      // same step every other mark uses.
      dimmedOpacity: 0.32,
      liveWickWidth: 1.5,
    },
  },
  bar: {
    // The **interaction-state palette**: state is a *hue* difference, not a
    // shade of one colour. Rest is teal; a committed selection is blue; hover
    // is a *brighter teal* — deliberately not blue, because blue is reserved
    // for "committed". Out-of-selection bars recede to the same teal at 0.32.
    // The shared drag band (`brush` below) is the selection blue at 7%, so the
    // live region reads as the same act as the selection it is about to make.
    // `secondary` reuses the line's warm accent for a second series.
    default: {
      fill: '#2A9D8F', // rest — teal, full opacity
      opacity: 1,
      highlight: '#3F5BE0', // selected — blue; committed state
      hover: '#3FBFAE', // hover — brighter teal, never blue
      dimmed: 'rgba(42,157,143,0.32)', // outside an active selection
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
      // The default threshold ladder: the bar's own teal as the in-range band,
      // then amber, then red. Three entries serves the common two-threshold
      // ok/warning/alarm ladder out of the box; a longer `thresholds` needs a
      // longer ladder from the theme or `bandColors`.
      bands: ['#2A9D8F', '#e8a13c', '#d64545'],
      // The **stack group ramp**, first group first (so a vertical stack reads
      // teal at the bottom up to terracotta). Four muted hues at similar
      // lightness, so no segment shouts over its neighbours the way a
      // saturation ladder would — the ramp says "different group", not
      // "more important". It starts on a teal near the resting `fill` so a
      // two-group stack still looks like the rest of the palette.
      groups: ['#4c9e8f', '#5379be', '#e2a54a', '#b5604e'],
      // Each ramp entry desaturated (~×0.18) and lightened toward the ground,
      // keeping its hue and its *relative* lightness — so a receded bin still
      // reads as four bands rather than one grey block, and the amber stays
      // the lightest of them as it is in the vivid ramp.
      groupsDimmed: ['#c7cecd', '#ced1d6', '#dcd8d2', '#d3cdcc'],
      // Each ramp entry brightened by the same move `fill` → `hover` makes:
      // hue held, lightness +0.11, saturation left alone. So a hovered segment
      // still says which group it is — the thing a single hover colour cannot
      // do on a stack, and under a <MultiSelector> (block-scoped hover) it is
      // the whole bin that would otherwise go one flat colour.
      groupsHover: ['#6bb8a9', '#7c99cd', '#eabd7a', '#c68476'],
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
  // The drag band in the bar palette's selection blue at 7%, edged at 1px —
  // the live region reads as the selection it is about to commit.
  brush: { fill: 'rgba(63,91,224,0.07)', edge: 'rgba(63,91,224,0.45)' },
  chip: { background: '#ffffff' },
  gap: { connectorOpacity: 0.5 },
  // Burnt-amber marks register — a deliberately warm outlier against every
  // data hue, so a placed mark never reads as data (the same rule the docs
  // brand's `vizMark` encodes). Verified against the whole palette: its
  // nearest data neighbours are the threshold-ladder red `#d64545` (ΔE2000
  // ≈ 18) and the warm secondary accent `#e8836b` (ΔE2000 ≈ 21); everything
  // else — bar teal, hover teal, selection blue, the data cerulean — clears
  // ΔE2000 40+. (The previous turquoise `#0d9488` sat ~ΔE 4 from the bar
  // palette's resting teal `#2A9D8F` — indistinguishable at a glance.)
  annotation: {
    color: '#b45309',
    fillOpacity: 0.1,
    depth: [1, 0.7, 0.4],
  },
  // The in-chart series key: chip-white card, gridline border, axis-label text.
  // The row-chart register — see `ChartTheme.list`. The two band tints are
  // the only genuinely new values: the rails are the same teal/blue pair the
  // bar's interaction-state palette already uses (`hover` / `highlight`), and
  // the marker ink is the near-black the annotation register reads against.
  list: {
    hoverBand: '#F6F6F3', // warm neutral — a lift, not a hue
    hoverRail: '#4FD0BE', // brighter teal, never blue
    selectedBand: '#EEF1FD', // the selection blue, washed
    selectedRail: '#3F5BE0', // = bar.default.highlight — committed state
    markerInk: '#1C1C1A', // reserved from the selection hue (see the doc)
  },
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
    // The warm filament accent — the paired second distribution, mirroring
    // `bar.secondary` / `line.hr` on the dark ground.
    secondary: {
      fill: '#E0B36A', // --es-filament
      fillOpacity: 0.28,
      stroke: '#E0B36A',
      strokeWidth: 1.5,
      median: '#F1FBF9', // --es-foam
      medianWidth: 2,
      whisker: '#EDD5A8',
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
