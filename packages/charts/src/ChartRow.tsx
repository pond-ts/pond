import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import { isDev } from './dev.js';
import { useIndexedChildren } from './child-index.js';
import { logAxisWarning, needsExtents, resolveYDomain } from './domain.js';
import { resolveAxisFormat } from './format.js';
import { resolveYTickCount } from './yticks.js';
import { placeAxisSlots, type SlotAxis } from './slots.js';
import { useSlotKey } from './use-slot-key.js';
import { LegacyCursor } from './cursors.js';
import { YAxis } from './YAxis.js';
import {
  ContainerContext,
  RowContext,
  type AxisSpec,
  type CursorMode,
  type GutterReq,
  type LayerEntry,
  type RowFrame,
  type YScale,
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
    a.scale === b.scale &&
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
  /**
   * Cursor presentation for this row, overriding the container's default
   * ({@link ChartContainerProps.cursor}). Omit to inherit. See {@link CursorMode}.
   *
   * @deprecated Mount a cursor component **inside the row** instead
   * (`<ChartRow><CrosshairCursor /> …</ChartRow>`) — the per-row override with
   * the same nearest-mount-wins semantics. Works for one more minor; a mounted
   * cursor in the row overrides this prop.
   */
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

  // Deprecation notice for the legacy `cursor` prop (dev, once per row): the
  // per-row override is now a cursor component mounted inside the row. The
  // prop keeps working via the shim rendered below.
  const warnedCursorRef = useRef(false);
  useEffect(() => {
    if (!isDev || cursor === undefined || warnedCursorRef.current) return;
    warnedCursorRef.current = true;
    console.warn(
      `[pond-charts] <ChartRow cursor="${cursor}"> is deprecated (it keeps ` +
        'working this minor, removed next) — mount the cursor component ' +
        'inside the row instead (docs/rfcs/interaction.md §9).',
    );
  }, [cursor]);

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
              scale: 'linear',
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
  const { k: yk, ty: yty } = container.yTransform;
  const yScales = useMemo(() => {
    const map = new Map<string, YScale>();
    for (const ax of effectiveAxes) {
      const extents: Array<readonly [number, number] | null> = needsExtents(ax)
        ? layerList
            .filter((entry) => (entry.axisId ?? defaultAxisId) === ax.id)
            .map((entry) => entry.layer.yExtent())
        : [];
      const [lo, hi] = resolveYDomain(
        ax.min,
        ax.max,
        extents,
        ax.pad,
        ax.scale,
      );
      // Reserve a header band at the top when any axis draws a `'top'` title,
      // so the title clears the top tick + plot (the whole row shifts down
      // uniformly, keeping stacked axes aligned). No top titles ⇒ range top 0,
      // so nothing changes for existing charts.
      // `scaleLog` and `scaleLinear` share the call/ticks/tickFormat/invert
      // surface every consumer uses (see `YScale`), so choosing between them
      // here is the whole of log support — no draw layer branches on it.
      const base = ax.scale === 'log' ? scaleLog() : scaleLinear();
      const s = base.domain([lo, hi]).range([height, topHeader]);
      // 2-D pan/zoom is carried as a **pixel** transform (`k`, `ty`) so one
      // gesture serves every axis in the row whatever its units, and all of them
      // zoom by the same factor — which is what fixes the aspect ratio. But it is
      // applied by narrowing the **domain** to the window that transform makes
      // visible, not by stretching the range.
      //
      // That distinction is not cosmetic. Stretching the range leaves the tick
      // generator working on the FULL domain, so ticks outside the view get
      // clamped onto the plot edge and pile up — 350 and 400 printed on top of
      // each other in the first cut. Narrowing the domain means ticks, padding
      // and every downstream reader see an ordinary axis over the visible
      // window, and none of them need to know a transform exists.
      if (yk !== 1 || yty !== 0) {
        const at = (px: number) => +s.invert((px - yty) / yk);
        s.domain([at(height), at(topHeader)]);
      }
      map.set(ax.id, s);
    }
    return map;
  }, [effectiveAxes, layerList, height, defaultAxisId, topHeader, yk, yty]);

  // Dev-mode diagnostics for a `scale="log"` axis (see `logAxisWarning`). Three
  // things about *where* this sits are load-bearing, each of them a bug the
  // first version shipped:
  //
  //  - **An effect, not the scale memo.** Warning from inside `useMemo` is a
  //    side effect in a function React may call speculatively — and does call
  //    twice under StrictMode.
  //  - **Deduplicated by message, in a ref.** The comment on the original said
  //    "warn once per offending axis" and nothing implemented it, so a live
  //    chart re-warned on every appended sample. Keying on the message (not a
  //    bare "already warned" flag) still reports a *different* complaint if the
  //    data changes shape.
  //  - **`height` is not a dependency.** It is one for the scales, which is why
  //    the warning must not ride along: a drag-resize would otherwise emit a
  //    line per animation frame.
  //
  // Gated on `isDev` **and** on some axis actually being logarithmic, so a
  // production build and every linear chart skip the extent walk entirely.
  const warnedRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!isDev || !effectiveAxes.some((ax) => ax.scale === 'log')) return;
    const warned = warnedRef.current;
    for (const ax of effectiveAxes) {
      // A linear axis in the same row has nothing to say and must not pay the
      // O(points) walk below just because a sibling is logarithmic.
      if (ax.scale !== 'log') continue;
      // Always walk the extents here, even for a fully-explicit domain the
      // scale memo skips them for: data that cannot be drawn is worth saying so
      // about whether or not it happened to constrain the bounds — and the
      // both-explicit axis was exactly the case the first version stayed silent
      // about.
      const message = logAxisWarning(
        ax,
        layerList
          .filter((entry) => (entry.axisId ?? defaultAxisId) === ax.id)
          .map((entry) => entry.layer.yExtent()),
      );
      if (message === null) warned.delete(ax.id);
      else if (warned.get(ax.id) !== message) {
        warned.set(ax.id, message);
        console.warn(message);
      }
    }
  }, [effectiveAxes, layerList, defaultAxisId]);

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
  //
  // A fragment child costs more here than it does in `<Layers>`: the axes
  // inside it lose the index *and* the `child.type === YAxis` sort below cannot
  // see through it, so they fall into `plotEls` and render in the middle of the
  // row instead of in a gutter. Hence the same warning on both.
  const indexedChildren = useIndexedChildren(
    children,
    '<ChartRow>',
    'the axes inside it lose their declaration order (the default-axis pick ' +
      'and slot order within a side) and are placed in the plot rather than a ' +
      'gutter, because the side sort cannot see through a fragment',
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
  let axisInsideWrapper = false;
  for (const child of indexedChildren ?? []) {
    if (isValidElement(child) && child.type === YAxis) {
      const side = (child.props as { side?: 'left' | 'right' }).side ?? 'left';
      (side === 'right' ? rightAxisEls : leftAxisEls).push(child);
    } else {
      // A `<Selector>`/`<MultiSelector>` is a legitimate row child now that it
      // wraps its scope (RFC A10.1) — but it must wrap the row's `<Layers>`,
      // NOT its axes: the sort above matches on `child.type`, so an axis
      // nested inside any wrapper is invisible to it and lands in the plot
      // column. The fragment warning cannot catch this one (a selector is a
      // real element, not a fragment), and the failure is silent, so look one
      // level down for the mistake the docs could invite.
      // A fragment is skipped here: `useIndexedChildren` already warns about
      // it and names the same gutter consequence, so checking it too would
      // print two warnings for one mistake.
      if (
        isDev &&
        isValidElement(child) &&
        child.type !== Fragment &&
        !axisInsideWrapper
      ) {
        const nested = (child.props as { children?: ReactNode }).children;
        if (nested !== undefined) {
          for (const g of Children.toArray(nested)) {
            if (isValidElement(g) && g.type === YAxis) {
              axisInsideWrapper = true;
              break;
            }
          }
        }
      }
      plotEls.push(child);
    }
  }
  const warnedAxisWrapperRef = useRef(false);
  useEffect(() => {
    if (!isDev || !axisInsideWrapper || warnedAxisWrapperRef.current) return;
    warnedAxisWrapperRef.current = true;
    console.warn(
      '[pond-charts] a <YAxis> is nested inside another element in this ' +
        '<ChartRow>, so it renders in the plot column instead of a gutter — ' +
        '<ChartRow> places axes by matching its own children, and cannot see ' +
        'through a wrapper. A row-scoped <Selector>/<MultiSelector> should ' +
        "wrap the row's <Layers>, leaving each <YAxis> a direct child of the " +
        '<ChartRow>.',
    );
  }, [axisInsideWrapper]);

  return (
    <RowContext.Provider value={frame}>
      {/* The deprecation shim for the legacy row-level `cursor` override:
          synthesized inside the row's context so it registers row-scoped. A
          cursor component mounted in this row overrides it. */}
      {cursor !== undefined && (
        <LegacyCursor
          mode={cursor}
          showTime={container.cursorTime}
          snap={container.crosshairSnap}
        />
      )}
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
