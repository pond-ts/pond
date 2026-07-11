import { Fragment, useContext } from 'react';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import { ContainerContext } from './context.js';
import { axisPillStyle } from './chip.js';
import {
  resolveAxisFormat,
  resolveTimeFormat,
  type AxisFormat,
} from './format.js';

/** Tick strip height (mark + value label) in CSS px. */
const TICK_STRIP = 22;
/** Extra height reserved for an axis `label` line. */
const LABEL_STRIP = 16;
const TICK_COUNT = 5;

/** One placed tick — its plot-pixel x and the text to draw. */
interface PlacedTick {
  readonly x: number;
  readonly label: string;
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
  align = 'center',
}: XAxisProps = {}) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<XAxis> must be rendered inside a <ChartContainer>');
  }
  const { xScale, plotWidth, leftGutter, theme, formatTime, xKind } = container;

  // The crosshair's x-time pill: when the container cursor is `'crosshair'` and a
  // cursor is live in-bounds, pin the hovered time to this axis (covering the
  // tick behind it), matching the on-axis y value pills the rows draw. Gated on
  // the container default, so a per-row `cursor` override doesn't reach here.
  const cursorX = container.cursorX;
  const showCursorTag =
    container.cursor === 'crosshair' &&
    cursorX !== null &&
    cursorX >= 0 &&
    cursorX <= plotWidth;
  const cursorColor = theme.cursor ?? theme.axis.label;

  const annotationColor = theme.annotation?.color ?? '#0d9488';

  // Tick formatter: an explicit `format` is resolved against the axis kind
  // (a time specifier through the time scale, a number specifier through the
  // value scale); otherwise the container's shared formatter — the one the
  // cursor readout uses, so a tick and the cursor read identically.
  const fmt: (value: number) => string =
    // A category axis labels by name (the container's `formatTime` = the band
    // scale's label lookup); a d3 number/time `format` can't name a category, so
    // it's ignored here (customize the labels in the `categories` data instead).
    format === undefined || xKind === 'category'
      ? formatTime
      : xKind === 'time'
        ? resolveTimeFormat(
            xScale as ScaleTime<number, number>,
            TICK_COUNT,
            format,
          )
        : resolveAxisFormat(
            xScale as ScaleLinear<number, number>,
            TICK_COUNT,
            format,
          );

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
        text: fmt(at),
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

  const rawTicks: PlacedTick[] = customTicks
    ? customTicks.map((t) => ({ x: xScale(t.at), label: t.label }))
    : (xScale.ticks(TICK_COUNT) as ReadonlyArray<number | Date>).map((d) => ({
        x: xScale(d as number),
        label: fmt(+d),
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
  const stripHeight =
    (height ?? TICK_STRIP + (label ? LABEL_STRIP : 0)) +
    maxPillLane * PILL_LANE_H;

  return (
    <div
      style={{
        position: 'relative',
        marginLeft: `${leftGutter}px`,
        width: `${plotWidth}px`,
        height: `${stripHeight}px`,
        // The plot-facing edge carries the rule; a top axis rules its bottom.
        [onTop ? 'borderBottom' : 'borderTop']: `1px solid ${theme.axis.grid}`,
        fontFamily: theme.font.family,
        fontSize: `${theme.font.size}px`,
        color: theme.axis.label,
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
        // `right` drops a longer tick alongside the label; others keep the 4px stub.
        const tickHeight = align === 'right' ? theme.font.size + 4 : 4;
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
                background: theme.axis.grid,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${labelLeft}px`,
                [onTop ? 'bottom' : 'top']: `${labelOffset}px`,
                transform: labelTransform,
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </div>
          </Fragment>
        );
      })}
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
            color: theme.axis.title?.color ?? theme.axis.label,
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
            {fmt(+xScale.invert(cursorX!))}
          </div>
        </Fragment>
      )}
    </div>
  );
}
