import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { scaleLinear, type ScaleLinear } from 'd3-scale';
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

  const [axes, setAxes] = useState<readonly AxisSpec[]>([]);
  const [layers, setLayers] = useState<readonly LayerEntry[]>([]);

  const registerAxis = useCallback((spec: AxisSpec) => {
    setAxes((a) => [...a, spec]);
    return () => setAxes((a) => a.filter((x) => x !== spec));
  }, []);
  const registerLayer = useCallback((entry: LayerEntry) => {
    setLayers((l) => [...l, entry]);
    return () => setLayers((l) => l.filter((x) => x !== entry));
  }, []);

  // Declared axes, or a single implicit auto-domain axis (no gutter) so a row
  // with no <YAxis> still scales — the M1/M2 behaviour, unchanged.
  const effectiveAxes = useMemo<readonly AxisSpec[]>(
    () =>
      axes.length > 0
        ? axes
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
  // axis id matches; an axis with no finite data gets [0, 1], a flat one ±1.
  const yScales = useMemo(() => {
    const map = new Map<string, ScaleLinear<number, number>>();
    for (const ax of effectiveAxes) {
      let lo = ax.min ?? Infinity;
      let hi = ax.max ?? -Infinity;
      if (ax.min === undefined || ax.max === undefined) {
        let min = Infinity;
        let max = -Infinity;
        for (const entry of layers) {
          const id = entry.axisId ?? defaultAxisId;
          if (id !== ax.id) continue;
          const e = entry.layer.yExtent();
          if (e) {
            if (e[0] < min) min = e[0];
            if (e[1] > max) max = e[1];
          }
        }
        if (min === Infinity) {
          min = 0;
          max = 1;
        } else if (min === max) {
          min -= 1;
          max += 1;
        }
        if (ax.min === undefined) lo = min;
        if (ax.max === undefined) hi = max;
      }
      map.set(ax.id, scaleLinear().domain([lo, hi]).range([height, 0]));
    }
    return map;
  }, [effectiveAxes, layers, height, defaultAxisId]);

  const frame = useMemo<RowFrame>(
    () => ({
      height,
      yScales,
      defaultAxisId,
      registerAxis,
      registerLayer,
      layers,
    }),
    [height, yScales, defaultAxisId, registerAxis, registerLayer, layers],
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
