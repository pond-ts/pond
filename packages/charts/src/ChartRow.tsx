import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { scaleLinear, type ScaleLinear } from 'd3-scale';
import { resolveYDomain } from './domain.js';
import { resolveAxisFormat } from './format.js';
import { resolveYTickCount } from './yticks.js';
import { placeAxisSlots, type SlotAxis } from './slots.js';
import { useSlotKey } from './use-slot-key.js';
import { YAxis } from './YAxis.js';
import {
  ContainerContext,
  RowContext,
  type AxisSpec,
  type CursorMode,
  type GutterReq,
  type LayerEntry,
  type RowFrame,
} from './context.js';

/** Sentinel id for the implicit axis a row gets when no `<YAxis>` is declared. */
const IMPLICIT_AXIS_ID = '__default__';

/** Element-wise compare of two optional number arrays (an axis's tick values) —
 *  so a *fresh* `ticks={[…]}` array whose contents are unchanged doesn't count as
 *  a new spec (see {@link axisSpecEqual}). */
function numberArraysEqual(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1)
    if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * Value-equality for two {@link AxisSpec}s — the registration guard's compare
 * (see `registerAxis`). Every field is a plain value except `format`, which may
 * be a `(value) => string` closure: those are compared by **reference**
 * (`Object.is`), so a stable/hoisted formatter (or a string specifier) is equal
 * across renders but a *fresh inline function* is not — the one case a structural
 * guard provably can't collapse, hence the `<YAxis format>` memoize note. A
 * fresh-but-value-equal `ticks` array (the common live-chart footgun) compares
 * equal element-wise and no-ops.
 */
function axisSpecEqual(a: AxisSpec, b: AxisSpec): boolean {
  return (
    a.id === b.id &&
    a.side === b.side &&
    a.width === b.width &&
    // Object.is (not ===) so a degenerate NaN bound compares equal to itself and
    // doesn't re-register every render.
    Object.is(a.min, b.min) &&
    Object.is(a.max, b.max) &&
    a.pad === b.pad &&
    a.labelPlacement === b.labelPlacement &&
    a.index === b.index &&
    a.tickCount === b.tickCount &&
    Object.is(a.format, b.format) &&
    numberArraysEqual(a.tickValues, b.tickValues)
  );
}

/**
 * Value-equality for two {@link LayerEntry}s — **defensive, not load-bearing.**
 * The axis guard (`axisSpecEqual`) is what breaks the update-depth loop; this is
 * belt-and-suspenders for the layer setter. Note that under the current draw-layer
 * structure it *won't* actually fire: every layer builds `layer` inside the same
 * `useMemo` as `entry`, so the register effect only runs when `entry` is fresh —
 * and a fresh `entry` always carries a fresh `layer`, so `a.layer === b.layer` is
 * never true when the guard runs (it falls through to a normal register). It would
 * only bite if a future layer memoized `layer` separately from `entry` (or the
 * `Layers` registry ref changed under a stable entry). A fresh `series` projection
 * (`byValue()` mints one each call) rebuilds the memo → a new `layer` and
 * legitimately re-registers; that's a consumer-side memoize (see the `series` note
 * on the draw-layer components), not something the setter can value-compare.
 */
function layerEntryEqual(a: LayerEntry, b: LayerEntry): boolean {
  return a.layer === b.layer && a.axisId === b.axisId && a.index === b.index;
}

/** Axis tick count for the per-axis formatter — matches `<YAxis>`'s tick count
 *  so the readout formatter is calibrated exactly as the labels are. */
const AXIS_TICK_COUNT = 5;

/** Vertical band (px) reserved above the plot for a `labelPlacement="top"` axis
 *  title, so it clears the top tick + plotted data. Sized for the default title
 *  (~`font.size + 1`); a much larger themed title may want more room. */
const TOP_LABEL_HEADER = 16;

export interface ChartRowProps {
  /** Row height in CSS pixels. */
  height: number;
  /** Cursor presentation for this row, overriding the container's default
   *  ({@link ChartContainerProps.cursor}). Omit to inherit. See {@link CursorMode}. */
  cursor?: CursorMode;
  children?: ReactNode;
}

/**
 * A horizontal band sharing the container's time axis. `ChartRow` owns the
 * **horizontal layout** (axes left/right around a `<Layers>` plot area) and
 * coordinates the row's two registries — axes (`<YAxis>`) and draw layers
 * (`<LineChart>`, registered through `<Layers>`). From the layers it derives a
 * y-scale **per axis** (each axis auto-fits the layers linked to it, or uses its
 * explicit `[min, max]`), and provides them via context.
 *
 * The x geometry (plot width, time scale) is shared and lives on the
 * {@link ChartContainer}: the row reports its per-slot gutter widths so the
 * container can reserve each slot's max, then sizes each axis to its slot and
 * pads the outer slots it lacks, so its plot left-aligns with every other row
 * under the one time axis.
 *
 * Children lay out left-to-right in author order, so `<YAxis side="left"/>` goes
 * before `<Layers/>` and `<YAxis side="right"/>` after.
 */
export function ChartRow({ height, cursor, children }: ChartRowProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<ChartRow> must be rendered inside a <ChartContainer>');
  }

  // Register on mount so the container can mark the first (topmost) row by
  // mount order — the shared cursor-time chip renders there only.
  const rowKey = useSlotKey();
  const { registerRow } = container;
  useEffect(() => registerRow(rowKey), [registerRow, rowKey]);
  const isFirstRow = container.firstRowKey === rowKey;

  // Keyed by a stable per-instance id (Map preserves insertion order; setting an
  // existing key updates in place). So a re-register on a prop change keeps the
  // entry's slot — the axis-default (first axis) and layer z-order stay stable
  // across updates; only mount/unmount reorders. (registerAxis/Layer return
  // void and update in place — *not* unregister-and-append, which would let a
  // min/max or series change silently rebind axes / reorder the z-stack.)
  const [axes, setAxes] = useState<ReadonlyMap<symbol, AxisSpec>>(
    () => new Map(),
  );
  const [layers, setLayers] = useState<ReadonlyMap<symbol, LayerEntry>>(
    () => new Map(),
  );

  // Registration is idempotent under value-equality: a `<YAxis>` re-fires its
  // register effect whenever its `spec` memo yields a fresh object — which an
  // inline `ticks={[]}` / `format` or a re-rendered parent does every render. If
  // the spec is *value*-equal to the stored one, skip the `setState` entirely so
  // it can't spin `register → setState → re-render → register` into React's
  // "Maximum update depth exceeded" on a scrub-heavy chart (F-charts-axis-reregister).
  const registerAxis = useCallback((key: symbol, spec: AxisSpec) => {
    setAxes((m) => {
      const prev = m.get(key);
      if (prev !== undefined && axisSpecEqual(prev, spec)) return m;
      return new Map(m).set(key, spec);
    });
  }, []);
  const unregisterAxis = useCallback((key: symbol) => {
    setAxes((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);
  // Same value-equality guard as `registerAxis`: a re-register carrying the same
  // `layer` object (stable while the draw layer's inputs are) + `axisId`/`index`
  // no-ops rather than churning state. (A fresh `series` projection rebuilds the
  // layer and legitimately re-registers — see `layerEntryEqual`.)
  const registerLayer = useCallback((key: symbol, entry: LayerEntry) => {
    setLayers((m) => {
      const prev = m.get(key);
      if (prev !== undefined && layerEntryEqual(prev, entry)) return m;
      return new Map(m).set(key, entry);
    });
  }, []);
  const unregisterLayer = useCallback((key: symbol) => {
    setLayers((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  // Layers in declaration order (the z-stack) — sorted by their injected JSX
  // index, so order follows the markup regardless of mount timing.
  const layerList = useMemo(
    () => Array.from(layers.values()).sort((a, b) => a.index - b.index),
    [layers],
  );

  // Real declared axes in declaration order (by injected index) — the rendered
  // <YAxis> children, as [slot key, spec] so layout can key off the per-instance
  // symbol (not the data id, which may repeat across a mirror). A row with none
  // gets a single implicit auto-domain axis, for *scaling* only (zero width, not
  // rendered), so it still has a default.
  const realEntries = useMemo<readonly (readonly [symbol, AxisSpec])[]>(
    () => Array.from(axes.entries()).sort((a, b) => a[1].index - b[1].index),
    [axes],
  );
  const realAxes = useMemo<readonly AxisSpec[]>(
    () => realEntries.map(([, spec]) => spec),
    [realEntries],
  );
  const effectiveAxes = useMemo<readonly AxisSpec[]>(
    () =>
      realAxes.length > 0
        ? realAxes
        : [
            {
              id: IMPLICIT_AXIS_ID,
              side: 'left',
              width: 0,
              min: undefined,
              max: undefined,
              pad: 0,
              labelPlacement: 'rotated',
              format: undefined,
              tickValues: undefined,
              tickCount: undefined,
              index: 0,
            },
          ],
    [realAxes],
  );
  const defaultAxisId = effectiveAxes[0]!.id;

  // This row's axes per side (as {key, width}), in slot order (slot 0 = innermost,
  // nearest the plot). Left axes are authored outer→inner so reverse them; right
  // axes are authored inner→outer already. Reported to the container as the
  // per-slot widths it maxes across rows.
  const { leftAxes, rightAxes, ownLeftSlots, ownRightSlots } = useMemo(() => {
    const l: SlotAxis[] = [];
    const r: SlotAxis[] = [];
    for (const [key, spec] of realEntries) {
      (spec.side === 'left' ? l : r).push({ key, width: spec.width });
    }
    return {
      leftAxes: l,
      rightAxes: r,
      ownLeftSlots: l.map((a) => a.width).reverse(),
      ownRightSlots: r.map((a) => a.width),
    };
  }, [realEntries]);

  const { registerGutter } = container;
  const gutterReq = useMemo<GutterReq>(
    () => ({ left: ownLeftSlots, right: ownRightSlots }),
    [ownLeftSlots, ownRightSlots],
  );
  // Depend on the *stable* registerGutter (a useCallback) + the memoized req —
  // not the container frame, which is recreated whenever the reservation
  // changes (depending on it would loop register → re-render → re-register).
  useEffect(() => registerGutter(gutterReq), [registerGutter, gutterReq]);

  // Map each axis id to its reserved slot width + the outer-slot padding this
  // row lacks (see placeAxisSlots — slot 0 nearest the plot, pad keeps the plot
  // aligned). Falls back to own width until the container has reserved.
  const containerLeftSlots = container.leftSlots;
  const containerRightSlots = container.rightSlots;
  const { axisSlots, leftPad, rightPad } = useMemo(
    () =>
      placeAxisSlots(
        leftAxes,
        rightAxes,
        containerLeftSlots,
        containerRightSlots,
      ),
    [leftAxes, rightAxes, containerLeftSlots, containerRightSlots],
  );

  // Header band reserved at the top of the plot when any axis draws a `'top'`
  // title — the scale range then starts below it (see below).
  const topHeader = effectiveAxes.some((ax) => ax.labelPlacement === 'top')
    ? TOP_LABEL_HEADER
    : 0;

  // One y-scale per axis. A layer counts toward an axis when its (late-resolved)
  // axis id matches; `resolveYDomain` handles the auto-fit + empty/flat/inverted
  // edges. yExtent() is O(points), so only walk the layers when a bound auto-fits.
  const yScales = useMemo(() => {
    const map = new Map<string, ScaleLinear<number, number>>();
    for (const ax of effectiveAxes) {
      const extents: Array<readonly [number, number] | null> =
        ax.min === undefined || ax.max === undefined
          ? layerList
              .filter((entry) => (entry.axisId ?? defaultAxisId) === ax.id)
              .map((entry) => entry.layer.yExtent())
          : [];
      const [lo, hi] = resolveYDomain(ax.min, ax.max, extents, ax.pad);
      // Reserve a header band at the top when any axis draws a `'top'` title,
      // so the title clears the top tick + plot (the whole row shifts down
      // uniformly, keeping stacked axes aligned). No top titles ⇒ range top 0,
      // so nothing changes for existing charts.
      map.set(ax.id, scaleLinear().domain([lo, hi]).range([height, topHeader]));
    }
    return map;
  }, [effectiveAxes, layerList, height, defaultAxisId, topHeader]);

  // Resolved auto-tick count per axis — explicit `<YAxis tickCount>` else
  // height-derived (see resolveYTickCount). The single source the `<YAxis>`
  // labels, the readout formatter (below), and the `Layers` gridlines all read,
  // so label / readout / gridline stay on one `ticks(count)`.
  const tickCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const ax of effectiveAxes) {
      map.set(ax.id, resolveYTickCount(height, ax.tickCount));
    }
    return map;
  }, [effectiveAxes, height]);

  // A value formatter per axis (its `format` resolved against its scale) — shared
  // by the axis tick labels and the cursor readout so a value reads the same.
  // Calibrated to the axis's resolved tick count (density), like the labels.
  const formats = useMemo(() => {
    const map = new Map<string, (value: number) => string>();
    for (const ax of effectiveAxes) {
      const sc = yScales.get(ax.id);
      if (sc) {
        const count = tickCounts.get(ax.id) ?? AXIS_TICK_COUNT;
        map.set(ax.id, resolveAxisFormat(sc, count, ax.format));
      }
    }
    return map;
  }, [effectiveAxes, yScales, tickCounts]);

  // Explicit tick values per axis (axes that set `<YAxis ticks>`) — so Layers
  // draws the row's gridlines at the same positions the axis labels, instead of
  // d3's auto-picked ticks.
  const tickValues = useMemo(() => {
    const map = new Map<string, readonly number[]>();
    for (const ax of effectiveAxes) {
      if (ax.tickValues) map.set(ax.id, ax.tickValues);
    }
    return map;
  }, [effectiveAxes]);

  // Which side each axis sits on — so an axis-edge overlay (the crosshair's
  // value pills) hugs the correct gutter without re-deriving from the specs.
  const axisSides = useMemo(() => {
    const map = new Map<string, 'left' | 'right'>();
    for (const ax of effectiveAxes) map.set(ax.id, ax.side);
    return map;
  }, [effectiveAxes]);

  const frame = useMemo<RowFrame>(
    () => ({
      height,
      cursor,
      isFirstRow,
      rowKey,
      yScales,
      formats,
      tickValues,
      tickCounts,
      axisSides,
      defaultAxisId,
      axisSlots,
      registerAxis,
      unregisterAxis,
      registerLayer,
      unregisterLayer,
      layers: layerList,
    }),
    [
      height,
      cursor,
      isFirstRow,
      rowKey,
      yScales,
      formats,
      tickValues,
      tickCounts,
      axisSides,
      defaultAxisId,
      axisSlots,
      registerAxis,
      unregisterAxis,
      registerLayer,
      unregisterLayer,
      layerList,
    ],
  );

  // Inject each direct child's JSX position so axes register their declaration
  // order (the default-axis source). `<Layers>` receives an index too (harmless
  // — it's not an axis) and injects its own into the draw layers.
  const indexedChildren = Children.map(children, (child, index) =>
    isValidElement(child)
      ? cloneElement(child as ReactElement<{ index?: number }>, { index })
      : child,
  );

  // Place axes by their `side`, not by JSX author position — so a `side="right"`
  // axis always renders right of the plot (and a left axis left), **consistent
  // with the side-based gutter reservation above**. (Author position only
  // injects the index, which still drives slot order within a side + the
  // default-axis pick.) This makes `side` the single source of truth for both
  // placement *and* reserved space; mis-authoring can no longer desync them
  // (the bug: a right axis authored before `<Layers>` rendered left while its
  // gutter was reserved right). Non-axis children (`<Layers>`) stay in the middle.
  const leftAxisEls: ReactNode[] = [];
  const plotEls: ReactNode[] = [];
  const rightAxisEls: ReactNode[] = [];
  for (const child of indexedChildren ?? []) {
    if (isValidElement(child) && child.type === YAxis) {
      const side = (child.props as { side?: 'left' | 'right' }).side ?? 'left';
      (side === 'right' ? rightAxisEls : leftAxisEls).push(child);
    } else {
      plotEls.push(child);
    }
  }

  return (
    <RowContext.Provider value={frame}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          width: `${container.width}px`,
          height: `${height}px`,
        }}
      >
        {leftPad > 0 && <div style={{ flex: `0 0 ${leftPad}px` }} />}
        {leftAxisEls}
        {plotEls}
        {rightAxisEls}
        {rightPad > 0 && <div style={{ flex: `0 0 ${rightPad}px` }} />}
      </div>
    </RowContext.Provider>
  );
}
