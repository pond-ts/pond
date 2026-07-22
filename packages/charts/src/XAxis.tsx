import { Fragment, useContext } from 'react';
import { scaleLinear } from 'd3-scale';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import { derivedTicks, type AxisTransform } from './derivedTicks.js';
import { ContainerContext, CursorContext } from './context.js';
import { axisPillStyle } from './chip.js';
import type { TradingTimeScale } from './tradingTimeScale.js';
import {
  resolveAxisFormat,
  resolveTimeFormat,
  type AxisFormat,
} from './format.js';

/** Tick strip height (mark + value label) in CSS px. */
const TICK_STRIP = 22;
/** Extra height reserved for an axis `label` line. */
const LABEL_STRIP = 16;
/** Extra height reserved for the stacked **band** (second) row. */
const BAND_STRIP = 20;
/** Minimum pixel gap between derived-unit (`transform`) ticks — the room a
 *  short numeric label needs plus breathing space, in the spirit of the
 *  ladder's per-tick budget (a hair tighter: derived labels are short). */
const TRANSFORM_TICK_PX = 48;

/** One placed tick — its plot-pixel x, the text to draw, and (stacked band
 *  style) whether it sits on a band turn and renders emphasized. */
interface PlacedTick {
  readonly x: number;
  readonly label: string;
  /** This tick opens a coarser calendar period (a day/month/year turn), so it
   *  renders emphasized (bold): a band turn in stacked, an inline promotion in
   *  flat — the same boundaries in both styles. */
  readonly bold?: boolean;
}

/**
 * Thin + truncate a **category** axis's labels so a dense axis stays legible: keep
 * every `stride`-th label (so a kept label has room), and ellipsize one that still
 * overruns its space. `stride` grows with the longest label vs the per-category
 * slot width, so a few short categories keep every full label and many long ones
 * decimate. A rough `fontSize`-based width estimate (no DOM measure) — good enough
 * for placement; the exact metric is the browser's. Rotation is a later option.
 */
function thinCategoryLabels(
  ticks: readonly PlacedTick[],
  plotWidth: number,
  fontSize: number,
): PlacedTick[] {
  const n = ticks.length;
  const slot = plotWidth / n; // per-category width in px
  // Before first layout `plotWidth` is 0 → `slot` is 0 and the stride/room math
  // below goes to Infinity/NaN. Nothing is visible at zero width anyway, so pass
  // the ticks through untouched until a real width arrives.
  if (!(slot > 0)) return [...ticks];
  const charW = fontSize * 0.62; // ~average glyph advance
  const longest = Math.min(
    12,
    ticks.reduce((m, t) => Math.max(m, t.label.length), 1),
  );
  const stride = Math.max(1, Math.ceil((longest * charW) / slot));
  const room = Math.max(1, Math.floor((slot * stride) / charW));
  const out: PlacedTick[] = [];
  for (let i = 0; i < n; i += stride) {
    const s = ticks[i]!.label;
    out.push({
      x: ticks[i]!.x,
      label: s.length <= room ? s : `${s.slice(0, Math.max(1, room - 1))}…`,
    });
  }
  return out;
}

export interface XAxisProps {
  /**
   * Tick / cursor value formatting — a d3 format/time specifier string or a
   * `(value) => string`. **Omitted ⇒ the container's shared formatter** (so the
   * axis and the cursor readout agree), which is the d3 multi-scale time format
   * for a time axis or the number default for a value axis. The specifier is
   * resolved against the axis's kind (time vs value).
   */
  format?: AxisFormat;
  /** A label drawn centred below (or above) the ticks — e.g. `Distance (m)`. */
  label?: string;
  /** Which edge the axis sits on. **Default `'bottom'`.** Declaration order in
   *  the `<ChartContainer>` places it; `side` orients the ticks + label. */
  side?: 'top' | 'bottom';
  /** Strip height in px. Defaults to fit the ticks (+ the label line if any). */
  height?: number;
  /**
   * Explicit ticks — `{ at, label }` in axis-value units — instead of the
   * scale's automatic ticks. The value-axis lever for e.g. lap markers placed at
   * their cumulative-distance positions (`{ at: lap.endMeters, label: 'Lap 3' }`).
   */
  ticks?: ReadonlyArray<{ readonly at: number; readonly label: string }>;
  /**
   * Relabel this axis into a **derived unit on the same scale** — a second
   * tick layout, not a second scale (the pixel mapping never changes). E.g. a
   * BS-delta strip under a std-moneyness chart (`transform={{ to: sigmaToDelta,
   * from: deltaToSigma }}`) or a moneyness axis over a strike chart
   * (`transform={{ to: (k) => k / spot, from: (m) => m * spot }}`). `to`/`from`
   * are monotonic inverses (either direction); they may be **nonlinear** —
   * ticks are nice derived-unit values at mixed 1-2-5 step sizes, admitted
   * wherever they keep pixel room, so a span the transform compresses gets
   * coarser ticks and a span it stretches gets finer ones. `format` (or the
   * d3 number default) formats the derived values; the cursor pill and marker
   * indicators on this axis read in the derived unit too. Ignored on a
   * category axis; explicit {@link ticks} win. Typically used on a second
   * `<XAxis>` stacked with the primary one — declaration order places the
   * strips; gridlines stay on the container's own (primary) ticks.
   */
  transform?: AxisTransform;
  /**
   * This axis instance's colour — tick marks, labels, the plot-facing rule,
   * and the `label` title all take it, overriding the theme's `axis.label` /
   * `axis.grid` / `axis.title.color`. The lever that distinguishes stacked
   * dual axes (a blue derived-unit strip under a grey primary). Cursor and
   * marker pills keep their own colours. Omit for the theme's axis colours.
   */
  color?: string;
  /**
   * Horizontal placement of each tick label relative to its tick.
   * - **`'center'` (default)** — every label centred on its tick. Note the
   *   first/last labels can then extend past the plot edges (the strip doesn't
   *   clip), so a wide first label may reach into the left y-axis gutter; use
   *   `'auto'` if that crowds.
   * - `'auto'` — centred, but the first label left-anchors and the last
   *   right-anchors so the edge labels stay inside the plot (the old default).
   * - `'right'` — the label sits to the **right** of an extended tick that
   *   drops from the axis line (label beside the tick, not under it) — useful
   *   for dense or wide labels that would collide when centred.
   */
  align?: 'auto' | 'center' | 'right';
  /**
   * How a **time** axis lays out its date context (ignored on value / category
   * axes, and whenever a custom `format`, `transform`, or explicit `ticks`
   * owns the labels).
   * - **`'flat'` (default)** — one row: each tick that opens a coarser
   *   calendar period is relabelled **inline** to it (the month at a month
   *   turn, the year at a year turn, the date at a day turn under an intraday
   *   grain), every other tick a terse label (`5`, `Feb`, `14:00`). The
   *   TradingView look — the row reads `… 30 31 Feb 2 3 …`.
   * - `'stacked'` — two rows: a terse top row (the grain's bare unit — `14:00`,
   *   `12`, `Feb`) over a segmented **band** row of the next-coarser period
   *   (day bands under intraday ticks, month bands under day ticks, year bands
   *   under month/quarter ticks). Each band is a left-aligned label + a divider
   *   at its turn, zebra-shaded by the band's calendar parity; the top-row tick
   *   on each turn is emphasized and joins its divider as one boundary line.
   */
  dateStyle?: 'flat' | 'stacked';
}

/**
 * The shared **x axis**, a sibling of {@link YAxis} for the horizontal axis. A
 * child of {@link ChartContainer}, rendered as DOM chrome (crisp text,
 * themeable) under (or over) the rows, aligned to the plot. It reads the
 * container's resolved `xScale` + `xKind` — so a **time** container ticks on
 * wall-clock boundaries and a **value** container (a `ValueSeries` row) ticks as
 * numbers, with no axis-type prop here; the kind follows the data.
 *
 * `<TimeAxis>` is the time-flavoured preset (`<XAxis />`).
 */
export function XAxis({
  format,
  label,
  side = 'bottom',
  height,
  ticks: customTicks,
  transform,
  color,
  align = 'center',
  dateStyle = 'flat',
}: XAxisProps = {}) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<XAxis> must be rendered inside a <ChartContainer>');
  }
  const cursor = useContext(CursorContext);
  // `xTickCount` is the container's shared x-side count — the same value the x
  // gridlines and `formatTime` use, so labels and grid stay on the same instants
  // (width-derived on a trading-time axis).
  const {
    xScale,
    plotWidth,
    leftGutter,
    theme,
    formatTime,
    xKind,
    xTickCount,
  } = container;

  // The crosshair's x-time pill: when the container cursor is `'crosshair'` and a
  // cursor is live in-bounds, pin the hovered time to this axis (covering the
  // tick behind it), matching the on-axis y value pills the rows draw. Gated on
  // the container default, so a per-row `cursor` override doesn't reach here.
  const cursorX = cursor.cursorX;
  const showCursorTag =
    container.cursor === 'crosshair' &&
    cursorX !== null &&
    cursorX >= 0 &&
    cursorX <= plotWidth;
  const cursorColor = theme.cursor ?? theme.axis.label;

  const annotationColor = theme.annotation?.color ?? '#0d9488';

  // Derived-unit (`transform`) layout: nice ticks in the derived unit at
  // mixed step sizes, admitted where they keep pixel room (see derivedTicks).
  // Explicit `ticks` win; a category axis has no numeric unit to derive from.
  const derived =
    transform !== undefined && xKind !== 'category' && customTicks === undefined
      ? derivedTicks(
          transform,
          (xScale as { domain(): number[] }).domain() as [number, number],
          (v) => xScale(v),
          plotWidth,
          TRANSFORM_TICK_PX,
        )
      : null;
  // Formatter for derived-unit values — `format` resolved against a u-space
  // linear scale (so `'+.2f'` and the d3 number default both work).
  const uFmt: ((u: number) => string) | null =
    transform !== undefined && xKind !== 'category'
      ? (() => {
          const [d0, d1] = (xScale as { domain(): number[] }).domain() as [
            number,
            number,
          ];
          const u = [transform.to(d0), transform.to(d1)].sort((a, b) => a - b);
          return resolveAxisFormat(scaleLinear().domain(u), xTickCount, format);
        })()
      : null;

  // Whether this axis draws **ladder-derived** date context (flat promotions or
  // the stacked boundary row). Only a ladder-driven time scale supplies it;
  // explicit `ticks`, an explicit axis `format`, and a container-level
  // `timeFormat` all opt out (a custom format owns the whole label, and custom
  // ticks have no grain).
  const laddered =
    xKind === 'time' &&
    customTicks === undefined &&
    transform === undefined &&
    format === undefined &&
    !container.xFormatCustom &&
    'tickBoundaries' in xScale;
  // The flat-style single-row label formatter — the coarsest calendar period
  // each tick opens promoted inline, terse base labels otherwise (the
  // TradingView default `dateStyle`). Replaces the shared `formatTime` for the
  // tick labels; a non-tick instant (the cursor pill) still reads a full
  // timestamp through it. `undefined` for the stacked style / a custom format.
  const flatFmt =
    laddered && dateStyle === 'flat' && 'flatFormat' in xScale
      ? (xScale as TradingTimeScale).flatFormat(xTickCount)
      : undefined;

  // The **stacked** date style renders a segmented **band** row (the coarser
  // calendar period as zebra-shaded cells with left-aligned labels + dividers)
  // beneath a terse top row, with the band-turn tick emphasized. The top row
  // reads `baseFormat` (the grain's bare unit, no inline promotion — the
  // context lives in the band), and `bands` are the segments.
  const stacked = laddered && dateStyle === 'stacked' && 'bands' in xScale;
  // The terse base label (the grain's bare unit, no promotion): the stacked
  // top row, and — in flat — the yardstick for detecting which ticks were
  // *promoted* to a coarser period, so those can be emphasized to match the
  // stacked band turns (a period boundary reads the same in both styles).
  const baseFmt =
    laddered && 'baseFormat' in xScale
      ? (xScale as TradingTimeScale).baseFormat(xTickCount)
      : undefined;
  const bands = stacked ? (xScale as TradingTimeScale).bands(xTickCount) : [];
  // Pixel positions where a band **divider** is drawn — the interior band
  // starts (a start at/left of the plot edge maps to px ≤ 0 and draws no
  // divider). A top-row tick landing on one is the band turn: it renders bold
  // and in the divider colour, so tick + divider read as one continuous
  // boundary line. Matched by **pixel**, not by instant, because on a trading
  // axis the turn tick is the session OPEN sitting at the collapsed-midnight
  // seam — the same pixel as the midnight band-start, but a different instant.
  const dividerXs = new Set(
    bands
      .map((b) => xScale(b.start))
      .filter((px) => px > 0) // same threshold the band border uses (startPx > 0)
      .map((px) => Math.round(px)),
  );

  // Tick / readout formatter: an explicit `format` is resolved against the axis
  // kind (a time specifier through the time scale, a number specifier through
  // the value scale); otherwise the container's shared formatter — the one the
  // cursor readout uses, so a tick and the cursor read identically. On a
  // transformed axis every readout (cursor pill, marker indicator) speaks the
  // **derived unit** — the axis's own language. NOTE: the flat date style
  // applies *only* to the rendered tick labels (`tickFmt` below), never to this
  // `fmt` — the cursor pill and marker indicators keep reading a full timestamp
  // rather than a terse/promoted axis label.
  const fmt: (value: number) => string =
    transform !== undefined && uFmt !== null && xKind !== 'category'
      ? (v) => uFmt(transform.to(v))
      : // A category axis labels by name (the container's `formatTime` = the band
        // scale's label lookup); a d3 number/time `format` can't name a category, so
        // it's ignored here (customize the labels in the `categories` data instead).
        format === undefined || xKind === 'category'
        ? formatTime
        : xKind === 'time'
          ? resolveTimeFormat(
              xScale as ScaleTime<number, number>,
              xTickCount,
              format,
            )
          : resolveAxisFormat(
              xScale as ScaleLinear<number, number>,
              xTickCount,
              format,
            );
  // The formatter for the rendered **tick labels** specifically: flat-style
  // promoted labels, stacked-style terse base labels, else the shared `fmt`.
  // Split from `fmt` so an axis's terse tick labels never leak into the cursor /
  // marker readouts, which stay full timestamps.
  const tickFmt = flatFmt ?? (stacked ? baseFmt : undefined) ?? fmt;
  // The **readout** formatter — the cursor pill + marker indicator pills. A
  // container `cursorFormat` wins even over an explicit axis `format` (pill
  // precedence `cursorFormat → axis format → container`): the readout is its
  // own channel, so precise-pill-over-terse-ticks works on any axis kind. A
  // `transform`ed axis is exempt — its pill speaks the derived unit, which a
  // data-unit `cursorFormat` can't address.
  const readoutFmt =
    transform === undefined ? (container.formatReadout ?? fmt) : fmt;

  // Marker annotations that opted into an axis indicator (`<Marker indicator>`)
  // pin their **time** to this shared x-axis — a pill at `at`, in the annotation
  // colour, reading like a tick. An indicator always shows the axis coordinate
  // (the formatted `at`), never the marker's custom label (that stays the in-plot
  // chip). Skipped when off-plot.
  // Coincident indicator markers (same `at`) show the same time, so one pill
  // stands for the group — dedup by `at` (the first wins), then place.
  const seenAt = new Set<number>();
  const markerTags = container.annotations
    .filter((a) => a.indicator && a.kind === 'marker' && a.xs[0] !== undefined)
    .filter((a) => {
      const at = a.xs[0]!;
      if (seenAt.has(at)) return false;
      seenAt.add(at);
      return true;
    })
    .map((a) => {
      const at = a.xs[0]!;
      return {
        key: a.key,
        id: a.id ?? `marker-at-${at}`,
        x: xScale(at),
        text: readoutFmt(at),
      };
    })
    .filter((t) => t.x >= 0 && t.x <= plotWidth);

  // Stack overlapping marker pills into lanes — they all share this one strip.
  // Greedy left→right; the dragged mark (`draggingKey`) is pinned to lane 0 so the
  // static pills hold their lanes as it crosses them (no reshuffle mid-drag).
  const pillWidth = (text: string) => text.length * theme.font.size * 0.62 + 10;
  const pillLaneEnds: number[] = [];
  const markerLanes = new Map<string, number>();
  for (const t of [...markerTags].sort((p, q) => p.x - q.x)) {
    if (t.key === container.draggingKey) {
      markerLanes.set(t.id, 0);
      continue;
    }
    const left = t.x - pillWidth(t.text) / 2;
    let lane = 0;
    while (lane < pillLaneEnds.length && pillLaneEnds[lane]! + 4 > left)
      lane += 1;
    pillLaneEnds[lane] = left + pillWidth(t.text);
    markerLanes.set(t.id, lane);
  }
  const maxPillLane = Math.max(0, pillLaneEnds.length - 1);

  // (The `'stacked'` date style's coarser context is the segmented **band**
  // row — `bands`, computed above — not a per-tick boundary label. The old
  // ride-a-tick boundary row + pinned context are retired; the scale still
  // exposes `tickBoundaries` / `boundaryContext` for any external consumer.)

  // Derived ticks pass a **label-honesty filter**: the fill can descend below
  // the format's resolution (a delta tick at u = 0.498 renders as "+0.50" under
  // `+.2f` — a lie about its position), so a tick survives only when its
  // formatted label parses back to a value that maps to (±1px of) the tick's
  // own pixel. This also caps density at the format's precision and drops
  // would-be duplicate labels. Non-numeric labels (a custom format function)
  // are trusted as-is.
  const honestDerived = (): PlacedTick[] => {
    const out: PlacedTick[] = [];
    const seen = new Set<string>();
    for (const t of derived!) {
      const text = uFmt!(t.u);
      if (seen.has(text)) continue;
      const back = parseFloat(text.replace(/\u2212/g, '-').replace(/,/g, ''));
      if (Number.isFinite(back)) {
        const bx = xScale(transform!.from(back));
        if (!Number.isFinite(bx) || Math.abs(bx - t.x) > 1) continue;
      }
      seen.add(text);
      out.push({ x: t.x, label: text });
    }
    return out;
  };

  const rawTicks: PlacedTick[] = customTicks
    ? customTicks.map((t) => ({ x: xScale(t.at), label: t.label }))
    : derived !== null
      ? honestDerived()
      : (xScale.ticks(xTickCount) as ReadonlyArray<number | Date>).map((d) => ({
          x: xScale(d as number),
          label: tickFmt(+d),
          // A **period turn** renders emphasized (bold), consistently across
          // styles: in stacked, a tick on a band divider (matched by pixel);
          // in flat, a tick whose label was *promoted* to a coarser period
          // (its flat label differs from the terse base) — the same boundaries,
          // so `Feb` / `2026` read as strong in flat just as the band turns do.
          bold: stacked
            ? dividerXs.has(Math.round(xScale(d as number)))
            : flatFmt !== undefined &&
              baseFmt !== undefined &&
              flatFmt(+d) !== baseFmt(+d),
        }));
  // A category axis ticks once per category; thin + truncate its labels when they
  // crowd (an explicit `customTicks` axis keeps its labels verbatim).
  const placed: PlacedTick[] =
    xKind === 'category' && customTicks === undefined && rawTicks.length > 1
      ? thinCategoryLabels(rawTicks, plotWidth, theme.font.size)
      : rawTicks;

  const onTop = side === 'top';
  // Axis pills (marker / crosshair) sit at the same offset as the tick labels so
  // they line up with their tick-label neighbours (matches `labelOffset` below).
  const pillOffset = align === 'right' ? 2 : 6;
  // Per-lane vertical step for stacked pills; grow the strip to fit the stack.
  const PILL_LANE_H = theme.font.size + 6;
  // The stacked **band** row grows the strip by one band-height row (like pill
  // lanes do). Only when the stacked style actually has bands (not at year
  // grain / on a non-ladder axis).
  const hasBands = stacked && bands.length > 0;
  // Band-row colours (themeable via `theme.axis.band`): the zebra shade fill,
  // the turn divider, and the label ink. A per-axis `color` override wins for
  // divider + label (the fill stays the band's own shade).
  const bandTheme = theme.axis.band;
  const bandFill =
    bandTheme?.fill ?? theme.chip?.background ?? 'rgba(0,0,0,0.04)';
  const bandDivider = color ?? bandTheme?.divider ?? theme.axis.grid;
  const bandLabelColor =
    color ?? bandTheme?.label ?? theme.axis.title?.color ?? theme.axis.label;
  const stripHeight =
    (height ?? TICK_STRIP + (label ? LABEL_STRIP : 0)) +
    (hasBands ? BAND_STRIP : 0) +
    maxPillLane * PILL_LANE_H;

  return (
    <div
      style={{
        position: 'relative',
        marginLeft: `${leftGutter}px`,
        width: `${plotWidth}px`,
        height: `${stripHeight}px`,
        // The plot-facing edge carries the rule; a top axis rules its bottom.
        [onTop ? 'borderBottom' : 'borderTop']:
          `1px solid ${color ?? theme.axis.grid}`,
        fontFamily: theme.font.family,
        fontSize: `${theme.font.size}px`,
        color: color ?? theme.axis.label,
      }}
    >
      {placed.map((t, i) => {
        const isFirst = i === 0;
        const isLast = i === placed.length - 1;
        // `center`: every label centred on its tick. `auto`: centred, but the
        // edge labels end-align so they stay within [0, plotWidth]. `right`:
        // label left-anchored just past an extended tick (beside, not under).
        const labelTransform =
          align === 'right'
            ? 'none'
            : align === 'auto' && isFirst
              ? 'none'
              : align === 'auto' && isLast
                ? 'translateX(-100%)'
                : 'translateX(-50%)';
        // Stacked band mode: every tick runs the full tick-row height to *meet*
        // the inter-row rule, so the boundary reads as one line continuing into
        // the band divider below. `right` drops a longer tick beside the label;
        // otherwise a 4px stub.
        const tickHeight = hasBands
          ? stripHeight - BAND_STRIP
          : align === 'right'
            ? theme.font.size + 4
            : 4;
        // The band-turn tick takes the divider colour so tick + divider read as
        // one continuous boundary; minor ticks stay the faint grid colour.
        const tickColor =
          hasBands && t.bold ? bandDivider : (color ?? theme.axis.grid);
        const labelLeft = align === 'right' ? t.x + 4 : t.x;
        const labelOffset = align === 'right' ? 2 : 6;
        return (
          <Fragment key={`${t.x}-${i}`}>
            <div
              style={{
                position: 'absolute',
                left: `${t.x}px`,
                [onTop ? 'bottom' : 'top']: 0,
                width: '1px',
                height: `${tickHeight}px`,
                background: tickColor,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${labelLeft}px`,
                [onTop ? 'bottom' : 'top']: `${labelOffset}px`,
                transform: labelTransform,
                whiteSpace: 'nowrap',
                // Stacked band style bolds the tick sitting on a band turn
                // (the day/month/year start) — the emphasized boundary tick.
                fontWeight: t.bold ? 700 : undefined,
              }}
            >
              {t.label}
            </div>
          </Fragment>
        );
      })}
      {hasBands && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: `${plotWidth}px`,
            [onTop ? 'top' : 'bottom']: 0,
            height: `${BAND_STRIP}px`,
            // The rule between the terse tick row and the band row.
            [onTop ? 'borderBottom' : 'borderTop']:
              `1px solid ${color ?? theme.axis.grid}`,
            overflow: 'hidden',
          }}
        >
          {bands.map((b, i) => {
            // Each band spans [its start, the next band's start) in pixels,
            // clamped to the plot. The first (partial) band starts off-screen
            // left, so its label pins at x=0; interior bands carry a divider
            // at their start. Shaded bands paint the zebra fill.
            const startPx = xScale(b.start);
            const left = Math.max(0, startPx);
            const nextPx =
              i + 1 < bands.length ? xScale(bands[i + 1]!.start) : plotWidth;
            const width = Math.max(0, Math.min(plotWidth, nextPx) - left);
            if (width <= 0) return null;
            return (
              <div
                key={b.start}
                data-band-label
                style={{
                  position: 'absolute',
                  left: `${left}px`,
                  top: 0,
                  bottom: 0,
                  width: `${width}px`,
                  boxSizing: 'border-box',
                  background: b.shaded ? bandFill : 'transparent',
                  borderLeft: startPx > 0 ? `1px solid ${bandDivider}` : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: '8px',
                  color: bandLabelColor,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                {b.label}
              </div>
            );
          })}
        </div>
      )}
      {label !== undefined && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: '100%',
            textAlign: 'center',
            [onTop ? 'top' : 'bottom']: 0,
            // Themeable axis-title text (shared with the rotated y-axis title).
            fontSize: `${theme.axis.title?.size ?? theme.font.size + 1}px`,
            color: color ?? theme.axis.title?.color ?? theme.axis.label,
            opacity: theme.axis.title?.opacity ?? 0.85,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      )}
      {markerTags.map((t) => {
        // The pill's lane: stacked below the base row when it would overlap a
        // neighbour; the connector lengthens to reach it.
        const laneY = pillOffset + (markerLanes.get(t.id) ?? 0) * PILL_LANE_H;
        return (
          <Fragment key={t.id}>
            {/* Connector bridging the marker line (which ends at the plot's
                bottom edge = this strip's plot-facing edge) down to its pill, so
                the two read as one. */}
            <div
              style={{
                position: 'absolute',
                left: `${t.x}px`,
                [onTop ? 'bottom' : 'top']: 0,
                width: '1px',
                height: `${laneY}px`,
                background: annotationColor,
                zIndex: 2,
              }}
            />
            <div
              style={{
                ...axisPillStyle(theme, annotationColor),
                left: `${t.x}px`,
                transform: 'translateX(-50%)',
                [onTop ? 'bottom' : 'top']: `${laneY}px`,
                zIndex: 2,
              }}
            >
              {t.text}
            </div>
          </Fragment>
        );
      })}
      {showCursorTag && (
        <Fragment>
          {/* Connector bridging the crosshair's vertical line (ending at the
              plot's bottom edge = this strip's plot-facing edge) to its time
              pill, so the two read as one. */}
          <div
            style={{
              position: 'absolute',
              left: `${cursorX}px`,
              [onTop ? 'bottom' : 'top']: 0,
              width: '1px',
              height: `${pillOffset}px`,
              background: cursorColor,
              zIndex: 3,
            }}
          />
          <div
            style={{
              ...axisPillStyle(theme, cursorColor),
              left: `${cursorX}px`,
              transform: 'translateX(-50%)',
              [onTop ? 'bottom' : 'top']: `${pillOffset}px`,
              zIndex: 3,
            }}
          >
            {readoutFmt(+xScale.invert(cursorX!))}
          </div>
        </Fragment>
      )}
    </div>
  );
}
