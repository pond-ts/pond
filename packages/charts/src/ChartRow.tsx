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
import {
  ContainerContext,
  RowContext,
  type AxisSpec,
  type GutterReq,
  type LayerEntry,
  type RowFrame,
} from './context.js';

/** Sentinel id for the implicit axis a row gets when no `<YAxis>` is declared. */
const IMPLICIT_AXIS_ID = '__default__';

export interface ChartRowProps {
  /** Row height in CSS pixels. */
  height: number;
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
 * {@link ChartContainer}: the row reports its per-side gutter need so the
 * container can reserve a *uniform* gutter, then pads with spacers so its plot
 * left-aligns with every other row under the one time axis.
 *
 * Children lay out left-to-right in author order, so `<YAxis side="left"/>` goes
 * before `<Layers/>` and `<YAxis side="right"/>` after.
 */
export function ChartRow({ height, children }: ChartRowProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<ChartRow> must be rendered inside a <ChartContainer>');
  }

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

  const registerAxis = useCallback((key: symbol, spec: AxisSpec) => {
    setAxes((m) => new Map(m).set(key, spec));
  }, []);
  const unregisterAxis = useCallback((key: symbol) => {
    setAxes((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);
  const registerLayer = useCallback((key: symbol, entry: LayerEntry) => {
    setLayers((m) => new Map(m).set(key, entry));
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
  // <YAxis> children. A row with none gets a single implicit auto-domain axis,
  // for *scaling* only (zero width, not rendered), so it still has a default.
  const realAxes = useMemo<readonly AxisSpec[]>(
    () => Array.from(axes.values()).sort((a, b) => a.index - b.index),
    [axes],
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
              index: 0,
            },
          ],
    [realAxes],
  );
  const defaultAxisId = effectiveAxes[0]!.id;

  // This row's axes per side, in slot order (slot 0 = innermost, nearest the
  // plot). Left axes are authored outer→inner so reverse them; right axes are
  // authored inner→outer already. Reported to the container as the per-slot
  // widths it maxes across rows.
  const { leftAxes, rightAxes, ownLeftSlots, ownRightSlots } = useMemo(() => {
    const l = realAxes.filter((a) => a.side === 'left');
    const r = realAxes.filter((a) => a.side === 'right');
    return {
      leftAxes: l,
      rightAxes: r,
      ownLeftSlots: l.map((a) => a.width).reverse(),
      ownRightSlots: r.map((a) => a.width),
    };
  }, [realAxes]);

  const { registerGutter } = container;
  const gutterReq = useMemo<GutterReq>(
    () => ({ left: ownLeftSlots, right: ownRightSlots }),
    [ownLeftSlots, ownRightSlots],
  );
  // Depend on the *stable* registerGutter (a useCallback) + the memoized req —
  // not the container frame, which is recreated whenever the reservation
  // changes (depending on it would loop register → re-render → re-register).
  useEffect(() => registerGutter(gutterReq), [registerGutter, gutterReq]);

  // Map each axis id to its reserved slot width, and the outer-slot padding this
  // row lacks. A left axis authored at position i (0 = outermost) sits in slot
  // (count-1-i) counting from the plot; a right axis at position j sits in slot
  // j. A row with fewer axes than the widest pads the outer slots so its plot
  // stays aligned. (Falls back to own width until the container has reserved.)
  const containerLeftSlots = container.leftSlots;
  const containerRightSlots = container.rightSlots;
  const { axisSlots, leftPad, rightPad } = useMemo(() => {
    const slotFor = new Map<string, number>();
    leftAxes.forEach((ax, i) => {
      const slotIdx = leftAxes.length - 1 - i;
      slotFor.set(ax.id, containerLeftSlots[slotIdx] ?? ax.width);
    });
    rightAxes.forEach((ax, j) => {
      slotFor.set(ax.id, containerRightSlots[j] ?? ax.width);
    });
    let lPad = 0;
    for (let i = leftAxes.length; i < containerLeftSlots.length; i++) {
      lPad += containerLeftSlots[i] ?? 0;
    }
    let rPad = 0;
    for (let j = rightAxes.length; j < containerRightSlots.length; j++) {
      rPad += containerRightSlots[j] ?? 0;
    }
    return { axisSlots: slotFor, leftPad: lPad, rightPad: rPad };
  }, [leftAxes, rightAxes, containerLeftSlots, containerRightSlots]);

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
      const [lo, hi] = resolveYDomain(ax.min, ax.max, extents);
      map.set(ax.id, scaleLinear().domain([lo, hi]).range([height, 0]));
    }
    return map;
  }, [effectiveAxes, layerList, height, defaultAxisId]);

  const frame = useMemo<RowFrame>(
    () => ({
      height,
      yScales,
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
      yScales,
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
        {indexedChildren}
        {rightPad > 0 && <div style={{ flex: `0 0 ${rightPad}px` }} />}
      </div>
    </RowContext.Provider>
  );
}
