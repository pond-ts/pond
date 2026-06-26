import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { scaleLinear, scaleTime } from 'd3-scale';
import type { TimeRange } from 'pond-ts';
import {
  ContainerContext,
  type ContainerFrame,
  type GutterReq,
  type CursorMode,
  type SelectInfo,
  type TrackerInfo,
  type TrackerSource,
} from './context.js';
import { maxSlotWidths, sum } from './slots.js';
import { resolveCursorX, DEFAULT_CURSOR_MODE } from './tracker.js';
import {
  resolveAxisFormat,
  resolveTimeFormat,
  type AxisFormat,
} from './format.js';
import { TimeAxis } from './TimeAxis.js';
import { defaultTheme, type ChartTheme } from './theme.js';

/** Time-axis tick count — matches `<TimeAxis>` so the cursor-time formatter is
 *  calibrated as the time-axis labels are. */
const TIME_TICK_COUNT = 5;

/**
 * Normalize the `range` prop — a `[begin, end]` tuple or a `TimeRange` — to a
 * plain `[number, number]`, or `undefined` when omitted (→ auto-fit). The
 * `'begin' in range` check distinguishes the `TimeRange` from the tuple (a
 * tuple has no `begin` key).
 */
function normalizeRange(
  range: readonly [number, number] | TimeRange | undefined,
): readonly [number, number] | undefined {
  if (range === undefined) return undefined;
  return 'begin' in range ? [range.begin(), range.end()] : [range[0], range[1]];
}

export interface ChartContainerProps {
  /**
   * The shared x **domain** `[begin, end]` — a tuple, or a `TimeRange`
   * (`series.timeRange()`). Units follow the data: epoch-ms for a time axis,
   * the value units (distance, …) for a value axis. **Omit to auto-fit** to the
   * rows' extents. The axis *kind* is never taken from here — it's inferred from
   * the data — so a tuple stays a time domain on a time chart.
   */
  range?: readonly [number, number] | TimeRange;
  /** Total width in CSS pixels (plot + axis gutters). */
  width: number;
  /** Vertical space between rows in CSS pixels (not under the axis). Default 0. */
  rowGap?: number;
  /**
   * Auto-render the shared x axis under the rows. **Default `true`.** Set
   * `false` for a bare plot (a sparkline), or when you place your own `<XAxis>`
   * child (e.g. with a label, custom ticks, or on `side="top"`). Named
   * `showAxis` (not `axis`) to avoid clashing with a layer's `axis` prop, which
   * picks *which* `<YAxis>` it scales against — a different axis entirely.
   */
  showAxis?: boolean;
  /**
   * Controlled tracker position (epoch ms) — pins the synced crosshair across
   * rows. Omit for uncontrolled (the chart tracks the pointer itself); pass
   * `null` to force it hidden. See {@link onTrackerChanged}.
   */
  trackerPosition?: number | null;
  /**
   * In-chart cursor presentation — the default for all rows (a row may override
   * via `<ChartRow cursor>`). **Default `'line'`** — the synced vertical line,
   * with values surfaced *outside* the chart via {@link onTrackerChanged}.
   * `'point'` / `'inline'` / `'flag'` add per-series marks; `'none'` hides it.
   * See {@link CursorMode}.
   */
  cursor?: CursorMode;
  /**
   * Fires on pointer move with the hovered time + every series' value there (so
   * you can render a readout outside the chart), and `null` on leave.
   */
  onTrackerChanged?: (info: TrackerInfo | null) => void;
  /**
   * Controlled selection — the selected mark (echo the `onSelect` arg back), or
   * `null`. **Omitted ⇒ uncontrolled** (a click on a selectable layer manages it
   * internally; pass `null` to force nothing selected). Selectable layers
   * (`BarChart`, `BoxPlot`, `ScatterChart`) highlight the mark matching both its
   * key and series — so two series sharing a timestamp don't both light up.
   */
  selected?: SelectInfo | null;
  /**
   * Fires when a selectable layer's mark is clicked, with the hit mark, or `null`
   * when a click misses every mark (clears the selection). Notification only —
   * works in both controlled and uncontrolled mode.
   */
  onSelect?: (hit: SelectInfo | null) => void;
  /**
   * Enable pan/zoom: drag the plot to pan the time range, wheel to zoom around
   * the cursor. **Default off** — so it doesn't capture drag/scroll unless asked.
   */
  panZoom?: boolean;
  /**
   * Controlled view range — fires on pan/zoom with the new `[start, end]`. Wire
   * it back to `range` for a controlled chart; omit for uncontrolled (the
   * container holds the view internally). **Uncontrolled + `panZoom` seeds the
   * internal view from `range` whenever it isn't actively holding one — so
   * toggling `panZoom` on, or a controlled→uncontrolled switch, starts from the
   * current range, not the mount-time one. Once uncontrolled, later `range`
   * changes are ignored so they can't fight the user's pan. To drive the range
   * externally — or to follow a live sliding window — use controlled mode (this
   * callback).**
   */
  onTimeRangeChange?: (range: [number, number]) => void;
  /** Zoom-in floor — the minimum visible duration in ms. Default `1`. */
  minDuration?: number;
  /**
   * Show the cursor's time atop the in-chart readout (when a row's `cursor` draws
   * one). **Default `false`.** Formatted by {@link timeFormat} to match the time
   * axis.
   */
  cursorTime?: boolean;
  /**
   * Enter **annotation-edit mode**: suppresses the data cursor and makes editable
   * annotations (those given an `onChange`) interactive — hovering one reveals its
   * handles + highlights it, and dragging edits it. **Default `false`.** Pairs
   * with each annotation's `onChange` (where the edit goes); this is the mode that
   * turns the affordances on and gets the cursor out of the way.
   */
  editAnnotations?: boolean;
  /**
   * Time-axis value formatting — a d3 time specifier string (e.g. `'%H:%M'`) or a
   * `(epochMs) => string` function ({@link AxisFormat}); applies to both the time
   * axis labels and the cursor-time readout. **Omitted ⇒ d3's multi-scale time
   * format** (`12 PM`, `12:10`, …).
   */
  timeFormat?: AxisFormat;
  /** Visual theme for all rows; defaults to {@link defaultTheme}. */
  theme?: ChartTheme;
  children?: ReactNode;
}

/**
 * The top of the chart layout (react-timeseries-charts-style). Owns the shared
 * **x geometry**: it collects each row's per-slot gutter widths, reserves each
 * slot's max across rows (so the innermost axis aligns column-by-column and
 * every row's plot left-aligns), and from the slot sums derives `plotWidth` and
 * the shared time `xScale`. It renders its rows (separated by `rowGap`) then one
 * {@link TimeAxis} at the bottom, aligned under the plots. Y axes are per-row
 * (`<YAxis>`).
 */
export function ChartContainer({
  range,
  width,
  rowGap = 0,
  showAxis = true,
  trackerPosition,
  onTrackerChanged,
  selected,
  onSelect,
  panZoom = false,
  onTimeRangeChange,
  minDuration = 1,
  cursor = DEFAULT_CURSOR_MODE,
  cursorTime = false,
  editAnnotations = false,
  timeFormat,
  theme,
  children,
}: ChartContainerProps) {
  // The explicit base domain from `range` (a tuple or a TimeRange). `undefined`
  // ⇒ auto-fit (resolved from the layers below). Pan/zoom seeds from it; `seed`
  // is the placeholder while auto-fitting.
  const explicitDomain = normalizeRange(range);
  const seed: readonly [number, number] = explicitDomain ?? [0, 1];

  // View range: pan/zoom moves it. Controlled (onTimeRangeChange) reads the prop
  // and routes gestures back through the callback; uncontrolled holds it
  // internally. With panZoom off, the seed is used directly — so a static or live
  // (sliding-prop) chart tracks the prop as before.
  const [internalRange, setInternalRange] = useState<[number, number]>([
    seed[0],
    seed[1],
  ]);
  const uncontrolled = panZoom && onTimeRangeChange === undefined;
  // While the internal view isn't in use (not uncontrolled), keep it synced to
  // the prop — so *entering* uncontrolled pan/zoom (toggling panZoom on, or a
  // controlled→uncontrolled switch) starts from the current range, not the
  // mount-time one. While uncontrolled, leave it alone so a range change
  // can't fight the user's pan. (Adjusting state during render — React re-renders
  // before commit, no extra paint; the guard makes it converge in one step.)
  if (
    !uncontrolled &&
    (internalRange[0] !== seed[0] || internalRange[1] !== seed[1])
  ) {
    setInternalRange([seed[0], seed[1]]);
  }
  const view = uncontrolled ? internalRange : seed;
  const t0 = view[0];
  const t1 = view[1];

  // Latest onTimeRangeChange in a ref so applyRange stays stable. Written after
  // commit (not in render) so a gesture never reads a callback from a frame that
  // was abandoned under concurrent rendering.
  const onRangeRef = useRef(onTimeRangeChange);
  useLayoutEffect(() => {
    onRangeRef.current = onTimeRangeChange;
  });
  const applyRange = useCallback((range: [number, number]) => {
    const cb = onRangeRef.current;
    if (cb) cb(range);
    else setInternalRange(range);
  }, []);

  // Cross-row tracker. We store the cursor's plot-pixel x (not a timestamp), so a
  // still cursor stays put while a live window slides under it; a controlled
  // `trackerPosition` resolves to a pixel below.
  const [hoverX, setHoverX] = useState<number | null>(null);

  // Draw layers register as tracker sources; on hover we fan in their values at
  // the cursor and hand them out via onTrackerChanged (held in a ref so an
  // inline callback doesn't churn the frame). This powers a readout rendered
  // *outside* the chart — the preferred surface for hover values.
  const [sources, setSources] = useState<ReadonlyMap<symbol, TrackerSource>>(
    () => new Map(),
  );
  const registerTrackerSource = useCallback(
    (key: symbol, source: TrackerSource) =>
      setSources((m) => new Map(m).set(key, source)),
    [],
  );
  const unregisterTrackerSource = useCallback((key: symbol) => {
    setSources((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  // The shared x scale's kind, **inferred from the registered layers**: a
  // ValueSeries row plots on a value axis, a TimeSeries on time. A container
  // has one shared x (the synced cursor's whole point), so the rows must agree
  // — a mix is a hard error. Defaults to `'time'` until a layer registers (the
  // two-pass: register → re-resolve → rescale).
  const resolvedKind: 'time' | 'value' = useMemo(() => {
    let kind: 'time' | 'value' | undefined;
    for (const s of sources.values()) {
      if (kind === undefined) kind = s.xKind;
      else if (kind !== s.xKind) {
        throw new Error(
          `ChartContainer: rows mix x-axis kinds ('${kind}' and '${s.xKind}'). ` +
            `A container has one shared x axis — every row must plot the same ` +
            `kind (all time-keyed, or all value-keyed).`,
        );
      }
    }
    return kind ?? 'time';
  }, [sources]);

  // Auto-fit extent — the union of the layers' x extents — used as the domain
  // when no explicit `range` is given. (Same source registry as the kind; the
  // two-pass register→resolve applies.)
  const autoExtent = useMemo((): readonly [number, number] | null => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of sources.values()) {
      const e = s.xExtent();
      if (e) {
        if (e[0] < lo) lo = e[0];
        if (e[1] > hi) hi = e[1];
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }, [sources]);

  const onTrackerRef = useRef(onTrackerChanged);
  onTrackerRef.current = onTrackerChanged;

  // Selection: controlled (`selected` prop) or uncontrolled (internal). A click
  // on a selectable layer calls `select()` after hit-testing; `onSelect` notifies
  // in both modes, the internal state is managed only when uncontrolled. The full
  // SelectInfo is the identity (key + series), so multi-series marks at one
  // timestamp stay distinct. Refs written after commit (not in render) so the
  // click handler never reads a callback / mode from a frame abandoned under
  // concurrent rendering.
  const [internalSelected, setInternalSelected] = useState<SelectInfo | null>(
    null,
  );
  const controlledSelection = selected !== undefined;
  const selectedValue = controlledSelection
    ? (selected ?? null)
    : internalSelected;
  const onSelectRef = useRef(onSelect);
  const controlledSelectionRef = useRef(controlledSelection);
  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
    controlledSelectionRef.current = controlledSelection;
  });
  const select = useCallback((hit: SelectInfo | null) => {
    onSelectRef.current?.(hit);
    if (!controlledSelectionRef.current) setInternalSelected(hit);
  }, []);

  // Hover-highlight: the transient mark under the pointer (distinct from the
  // committed selection). Deduped by key+label so the data canvas repaints only
  // when the hovered mark changes — not on every pointer move (the move itself
  // just slides the SVG cursor, which never touches the data canvas).
  const [hovered, setHoveredState] = useState<SelectInfo | null>(null);
  const setHovered = useCallback((hit: SelectInfo | null) => {
    setHoveredState((prev) =>
      prev === hit ||
      (prev !== null &&
        hit !== null &&
        prev.key === hit.key &&
        prev.label === hit.label)
        ? prev
        : hit,
    );
  }, []);

  // Rows report their per-slot gutter widths; we reserve each slot's max.
  const [gutters, setGutters] = useState<readonly GutterReq[]>([]);
  const registerGutter = useCallback((req: GutterReq) => {
    setGutters((g) => [...g, req]);
    return () => setGutters((g) => g.filter((x) => x !== req));
  }, []);

  // Rows register on mount so we can mark the first (topmost) one — the shared
  // cursor-time chip shows there only. Effect order = mount order = top-to-bottom
  // for siblings, so the first row registers first (`rowKeys[0]`); this is robust
  // even when rows are wrapped in a fragment/helper component, where an index
  // injected into our direct children wouldn't reach through the wrapper.
  const [rowKeys, setRowKeys] = useState<readonly symbol[]>([]);
  const registerRow = useCallback((key: symbol) => {
    setRowKeys((k) => (k.includes(key) ? k : [...k, key]));
    return () => setRowKeys((k) => k.filter((x) => x !== key));
  }, []);
  const firstRowKey = rowKeys[0] ?? null;

  const leftSlots = useMemo(
    () => maxSlotWidths(gutters.map((g) => g.left)),
    [gutters],
  );
  const rightSlots = useMemo(
    () => maxSlotWidths(gutters.map((g) => g.right)),
    [gutters],
  );
  const leftGutter = sum(leftSlots);
  const rightGutter = sum(rightSlots);
  const plotWidth = Math.max(0, width - leftGutter - rightGutter);

  // The resolved x domain: while panning an explicit domain it's the live view
  // (t0/t1); otherwise the auto-fit extent (→ [0, 1] before any layer registers,
  // the two-pass settle). This is what the scale + cursor + axis read.
  const [d0, d1] =
    explicitDomain !== undefined ? [t0, t1] : (autoExtent ?? [0, 1]);

  // The shared x scale + the formatter for its ticks / cursor readout, built
  // together so each branch keeps its concrete scale type (no casts): a value
  // axis is a `scaleLinear` formatted by `resolveAxisFormat`, time is a
  // `scaleTime` formatted by d3's multi-scale `resolveTimeFormat`. `formatTime`
  // is the one formatter <TimeAxis> + the cursor readout share, so a tick and
  // the cursor read identically. (The `formatTime` name predates the value axis
  // — on a value axis it formats the value, not a time.)
  const { xScale, formatTime } = useMemo(() => {
    if (resolvedKind === 'value') {
      const s = scaleLinear().domain([d0, d1]).range([0, plotWidth]);
      return {
        xScale: s,
        formatTime: resolveAxisFormat(s, TIME_TICK_COUNT, timeFormat),
      };
    }
    const s = scaleTime().domain([d0, d1]).range([0, plotWidth]);
    return {
      xScale: s,
      formatTime: resolveTimeFormat(s, TIME_TICK_COUNT, timeFormat),
    };
  }, [resolvedKind, d0, d1, plotWidth, timeFormat]);

  // The crosshair pixel (see resolveCursorX). A stored hoverX is a *plot* pixel;
  // if plotWidth changes mid-hover (a gutter reserving, or a width change) it's
  // briefly stale until the next pointer move — rare, and the bounds check below
  // hides an out-of-plot crosshair meanwhile.
  const cursorX = resolveCursorX(trackerPosition, hoverX, xScale);

  // Emit { time, values } for an outside readout — recomputed as the cursor moves
  // *or* the window slides under it (xScale change → new time at the same pixel).
  // Out of the plot (null, or a controlled trackerPosition d3 extrapolated past
  // the edges) → no readout, matching the hidden overlay; the ref guard keeps a
  // not-hovering live chart from spamming `null`.
  const lastNullRef = useRef(false);
  useEffect(() => {
    const cb = onTrackerRef.current;
    if (cb === undefined) return;
    if (cursorX === null || cursorX < 0 || cursorX > plotWidth) {
      if (!lastNullRef.current) cb(null);
      lastNullRef.current = true;
      return;
    }
    lastNullRef.current = false;
    const time = +xScale.invert(cursorX);
    const values = Array.from(sources.values()).flatMap((s) =>
      s.sampleAt(time),
    );
    cb({ time, values });
  }, [cursorX, xScale, sources, plotWidth]);

  const frame = useMemo<ContainerFrame>(
    () => ({
      timeRange: [d0, d1],
      width,
      theme: theme ?? defaultTheme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      cursorX,
      setHoverX,
      selected: selectedValue,
      select,
      hovered,
      setHovered,
      cursor,
      cursorTime,
      editAnnotations,
      formatTime,
      registerTrackerSource,
      unregisterTrackerSource,
      xScale,
      xKind: resolvedKind,
      panZoom,
      minDuration,
      applyRange,
      registerGutter,
      registerRow,
      firstRowKey,
    }),
    [
      d0,
      d1,
      width,
      theme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      cursorX,
      selectedValue,
      select,
      hovered,
      setHovered,
      cursor,
      cursorTime,
      editAnnotations,
      formatTime,
      registerTrackerSource,
      unregisterTrackerSource,
      xScale,
      resolvedKind,
      panZoom,
      minDuration,
      applyRange,
      registerGutter,
      registerRow,
      firstRowKey,
    ],
  );

  return (
    <ContainerContext.Provider value={frame}>
      <div style={{ width: `${width}px` }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: `${rowGap}px`,
          }}
        >
          {children}
        </div>
        {showAxis && <TimeAxis />}
      </div>
    </ContainerContext.Provider>
  );
}
