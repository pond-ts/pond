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
import { resolveCursorX } from './tracker.js';
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

  const onTrackerRef = useRef(onTrackerChanged);
  onTrackerRef.current = onTrackerChanged;

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
      timeRange: [t0, t1],
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
      cursorX,
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
