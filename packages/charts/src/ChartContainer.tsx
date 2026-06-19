import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { scaleTime } from 'd3-scale';
import {
  ContainerContext,
  type ContainerFrame,
  type GutterReq,
  type ReadoutMode,
  type TrackerInfo,
  type TrackerSource,
} from './context.js';
import { maxSlotWidths, sum } from './slots.js';
import { TimeAxis } from './TimeAxis.js';
import { defaultTheme, type ChartTheme } from './theme.js';

export interface ChartContainerProps {
  /** Time domain `[start, end]` in epoch ms — the shared x-axis for all rows. */
  timeRange: readonly [number, number];
  /** Total width in CSS pixels (plot + axis gutters). */
  width: number;
  /** Vertical space between rows in CSS pixels (not under the time axis). Default 0. */
  rowGap?: number;
  /** Render the shared time (x) axis under the rows. Default `true`. */
  timeAxis?: boolean;
  /**
   * Controlled tracker position (epoch ms) — pins the synced crosshair across
   * rows. Omit for uncontrolled (the chart tracks the pointer itself); pass
   * `null` to force it hidden. See {@link onTrackerChanged}.
   */
  trackerPosition?: number | null;
  /**
   * In-chart readout presentation. **Default `'none'`** — just the crosshair +
   * per-series dots, with values surfaced *outside* the chart via
   * {@link onTrackerChanged}. `'flag'` / `'inline'` draw value chips in-plot.
   */
  readout?: ReadoutMode;
  /**
   * Fires on pointer move with the hovered time + every series' value there (so
   * you can render a readout outside the chart), and `null` on leave.
   */
  onTrackerChanged?: (info: TrackerInfo | null) => void;
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
  timeRange,
  width,
  rowGap = 0,
  timeAxis = true,
  trackerPosition,
  onTrackerChanged,
  readout = 'none',
  theme,
  children,
}: ChartContainerProps) {
  const t0 = timeRange[0];
  const t1 = timeRange[1];

  // Cross-row tracker. Uncontrolled by default (we track the pointer); a
  // `trackerPosition` prop overrides the displayed crosshair.
  const [hover, setHover] = useState<number | null>(null);
  const hoverTime = trackerPosition !== undefined ? trackerPosition : hover;

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

  const onTrackerRef = useRef(onTrackerChanged);
  onTrackerRef.current = onTrackerChanged;
  useEffect(() => {
    const cb = onTrackerRef.current;
    if (cb === undefined) return;
    if (hover === null) {
      cb(null);
      return;
    }
    const values = Array.from(sources.values()).flatMap((s) =>
      s.sampleAt(hover),
    );
    cb({ time: hover, values });
  }, [hover, sources]);

  // Rows report their per-slot gutter widths; we reserve each slot's max.
  const [gutters, setGutters] = useState<readonly GutterReq[]>([]);
  const registerGutter = useCallback((req: GutterReq) => {
    setGutters((g) => [...g, req]);
    return () => setGutters((g) => g.filter((x) => x !== req));
  }, []);

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

  const xScale = useMemo(
    () => scaleTime().domain([t0, t1]).range([0, plotWidth]),
    [t0, t1, plotWidth],
  );

  const frame = useMemo<ContainerFrame>(
    () => ({
      timeRange: [t0, t1],
      width,
      theme: theme ?? defaultTheme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      hoverTime,
      setHoverTime: setHover,
      readout,
      registerTrackerSource,
      unregisterTrackerSource,
      xScale,
      registerGutter,
    }),
    [
      t0,
      t1,
      width,
      theme,
      plotWidth,
      leftSlots,
      rightSlots,
      leftGutter,
      rightGutter,
      rowGap,
      hoverTime,
      readout,
      registerTrackerSource,
      unregisterTrackerSource,
      xScale,
      registerGutter,
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
        {timeAxis && <TimeAxis />}
      </div>
    </ContainerContext.Provider>
  );
}
