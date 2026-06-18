import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
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
  const [axes, setAxes] = useState<ReadonlyMap<string, AxisSpec>>(
    () => new Map(),
  );
  const [layers, setLayers] = useState<ReadonlyMap<string, LayerEntry>>(
    () => new Map(),
  );

  const registerAxis = useCallback((id: string, spec: AxisSpec) => {
    setAxes((m) => new Map(m).set(id, spec));
  }, []);
  const unregisterAxis = useCallback((id: string) => {
    setAxes((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }, []);
  const registerLayer = useCallback((id: string, entry: LayerEntry) => {
    setLayers((m) => new Map(m).set(id, entry));
  }, []);
  const unregisterLayer = useCallback((id: string) => {
    setLayers((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }, []);

  // Layers in stable declaration order (the z-stack).
  const layerList = useMemo(() => Array.from(layers.values()), [layers]);

  // Declared axes (stable declaration order), or a single implicit auto-domain
  // axis (no gutter) so a row with no <YAxis> still scales — M1/M2 behaviour.
  const effectiveAxes = useMemo<readonly AxisSpec[]>(
    () =>
      axes.size > 0
        ? Array.from(axes.values())
        : [
            {
              id: IMPLICIT_AXIS_ID,
              side: 'left',
              width: 0,
              min: undefined,
              max: undefined,
            },
          ],
    [axes],
  );
  const defaultAxisId = effectiveAxes[0]!.id;

  // This row's own per-side gutter (sum of its axis widths each side). Reported
  // to the container, which reserves the max each side across all rows.
  const { ownLeft, ownRight } = useMemo(() => {
    let l = 0;
    let r = 0;
    for (const ax of effectiveAxes) {
      if (ax.side === 'left') l += ax.width;
      else r += ax.width;
    }
    return { ownLeft: l, ownRight: r };
  }, [effectiveAxes]);

  const { registerGutter } = container;
  const gutterReq = useMemo<GutterReq>(
    () => ({ left: ownLeft, right: ownRight }),
    [ownLeft, ownRight],
  );
  // Depend on the *stable* registerGutter (a useCallback) + the memoized req —
  // not the container frame, which is recreated whenever the reservation
  // changes (depending on it would loop register → re-render → re-register).
  useEffect(() => registerGutter(gutterReq), [registerGutter, gutterReq]);

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
      registerAxis,
      unregisterAxis,
      registerLayer,
      unregisterLayer,
      layerList,
    ],
  );

  // Pad to the container's uniform gutter so this row's plot left-aligns with
  // the others (and with the time axis). Zero on a row that owns the widest
  // gutter — invisible until rows differ.
  const leftSpacer = container.leftGutter - ownLeft;
  const rightSpacer = container.rightGutter - ownRight;

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
        {leftSpacer > 0 && <div style={{ flex: `0 0 ${leftSpacer}px` }} />}
        {children}
        {rightSpacer > 0 && <div style={{ flex: `0 0 ${rightSpacer}px` }} />}
      </div>
    </RowContext.Provider>
  );
}
