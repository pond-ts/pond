import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
  defaultTheme,
  type ChartTheme,
} from '@pond-ts/charts';
import {
  COUNT,
  SAP_TRAFFIC,
  START_MS,
  STEP_MS,
  sapSeries,
  siteTotal,
  TRAFFIC_RANGE,
} from './lib/cern-traffic';
import styles from './gallery-site-traffic-dashboard.module.css';

/**
 * A **replica** of the production dashboard the CERN capture comes out of —
 * the same page, rebuilt on pond: header, control strip, the mirrored
 * total-traffic chart, and the per-interface table that drives it.
 *
 * Two things make this page different from the rest of the Gallery.
 *
 * **The overlay.** Selecting a row does not swap the chart's series — the site
 * total is *always* the drawn shape. What changes is which part of it is
 * saturated, under one rule: **the saturated colour marks what you are looking
 * at.** Nothing picked ⇒ the total itself is the subject, drawn saturated. Pick
 * a row and the total drops back to a pale wash while that interface's
 * contribution is drawn **over** it in the saturated shade, from the same zero
 * line — so the dark region reads as its share *of* the total rather than as a
 * separate chart. Two more `<AreaChart>`s and a swapped `as` role; that is the
 * whole trick.
 *
 * **The palette.** It is the product's, not pond's, and it arrives through the
 * one channel a chart has for colour: a {@link ChartTheme}. No hex literal
 * reaches the JSX. Swap `theme={replicaTheme}` for the site's
 * `useSiteChartTheme()` and the chart is a pond chart again with no other edit.
 */
export default function GallerySiteTrafficDashboard({
  width: fixedWidth,
  chartHeight = 250,
  preview = false,
}: {
  /**
   * Panel width in px. Omit it on the page and the panel measures its own
   * container instead, so the dashboard fills the column the way the product
   * fills a browser window. The Gallery card passes an explicit width, because
   * a card stage hands one down already.
   */
  width?: number;
  chartHeight?: number;
  /**
   * Cut the panel off under the chart — no interface table — and open with
   * the busiest interface already picked, so the overlay is what you see.
   * The Gallery **card** renders this: a card stage is ~200px tall and clips
   * from its centre, so the whole panel would arrive headless and footless.
   * The page itself renders the real thing.
   */
  preview?: boolean;
}) {
  // Measure the container when no width was handed down (the page case).
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    if (fixedWidth !== undefined) return;
    const el = boxRef.current;
    if (!el) return;
    const read = () =>
      setMeasured(Math.round(el.getBoundingClientRect().width));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixedWidth]);
  const width = fixedWidth ?? Math.max(measured - 32, 320);

  const [selected, setSelected] = useState<string | null>(
    preview ? SAP_TRAFFIC[0]!.name : null,
  );
  const [gridlines, setGridlines] = useState(true);

  // The visible window, held here rather than in the container: the `TIME`
  // buttons jump it to a preset and pan/zoom nudges it from there, and both
  // have to write the same piece of state or the second one to move wins
  // forever. `<ChartContainer onTimeRangeChange>` is what makes the gesture
  // route through us instead of into the container's own uncontrolled view.
  const [range, setRange] = useState<[number, number]>(() => spanRange('6h'));

  // Which preset the window currently *is* — compared rather than remembered,
  // so panning off a preset lights neither button instead of lying about it.
  const activeSpan = SPANS.find((s) => {
    const [a, b] = spanRange(s);
    return a === range[0] && b === range[1];
  });

  // The instant the pointer is over, from `onTrackerChanged`; `null` off-chart.
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const onTracker = useCallback(
    (info: { time: number } | null) => setHoverTime(info?.time ?? null),
    [],
  );

  const { rows, peak, i0, i1 } = useMemo(() => windowStats(range), [range]);
  const per = ticksPerHalf(chartHeight);
  const bound = niceBound(peak, per);

  // The sample every row's tick and value read: the hovered one while the
  // pointer is over the plot, the window's last otherwise. Clamped to the
  // visible window so a tracker time from a stale frame can't point outside it.
  const mark =
    hoverTime === null
      ? i1
      : Math.min(
          i1,
          Math.max(i0, Math.round((hoverTime - START_MS) / STEP_MS)),
        );

  const total = siteTotal();
  const picked = selected === null ? null : sapSeries(selected);
  // The mirror: one negated copy per drawn series, so `out` fills *below* the
  // shared zero line. Memoized because a fresh instance re-registers its layer.
  const totalDown = useMemo(
    () => total.mapColumns({ out: (v) => -v }),
    [total],
  );
  const pickedDown = useMemo(
    () => (picked === null ? null : picked.mapColumns({ out: (v) => -v })),
    [picked],
  );

  const ticks = useMemo(() => symmetricTicks(bound, per), [bound, per]);
  const scale = Math.max(...rows.map((r) => Math.max(r.peakIn, r.peakOut)));

  return (
    <div
      ref={boxRef}
      className={styles.dash}
      style={
        fixedWidth === undefined
          ? { width: '100%' }
          : { width: fixedWidth + 32 }
      }
    >
      <header className={styles.topbar}>
        <div className={styles.org}>
          European Organization for Nuclear Research
        </div>
      </header>

      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Traffic</span>
          <span className={styles.inert} aria-disabled="true">
            All ▾
          </span>
        </div>
        <div className={styles.controlSet}>
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>Show gridlines</span>
            <div className={styles.seg}>
              <button
                type="button"
                aria-pressed={!gridlines}
                onClick={() => setGridlines(false)}
              >
                Off
              </button>
              <button
                type="button"
                aria-pressed={gridlines}
                onClick={() => setGridlines(true)}
              >
                On
              </button>
            </div>
          </div>
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>Time</span>
            <div className={styles.seg}>
              {SPANS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={s === activeSpan}
                  onClick={() => setRange(spanRange(s))}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.block}>
        <h3 className={styles.sectionTitle}>Total Site Traffic</h3>
        <p className={styles.caption}>Last updated {stamp(range[1])}</p>
        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span
              className={styles.swatch}
              style={{ background: TO_SITE }}
              aria-hidden="true"
            />
            To site
          </span>
          <span className={styles.legendItem}>
            <span
              className={styles.swatch}
              style={{ background: FROM_SITE }}
              aria-hidden="true"
            />
            From site
          </span>
        </div>

        <ChartContainer
          range={range}
          width={width}
          theme={replicaTheme}
          grid={gridlines}
          cursor="line"
          // Drag to pan, wheel to zoom — but only over ground the capture
          // covers. `bounds` is the fixture's full extent, so the window
          // clamps at the first and last sample instead of drifting off into
          // empty time, and the `TIME` presets stay reachable by hand.
          //
          // Off in the Gallery card: a card that zooms under the wheel traps
          // the scroll of anyone paging down the Gallery, which is exactly the
          // gesture that page is read with.
          panZoom={preview ? 'none' : 'panZoom'}
          bounds={TRAFFIC_RANGE}
          onTimeRangeChange={setRange}
          onTrackerChanged={onTracker}
        >
          <ChartRow height={chartHeight}>
            <YAxis
              id="bps"
              side="left"
              // The product prints no axis title — the `G` suffix on every
              // tick carries the unit. `<YAxis label>` defaults to the axis
              // **id**, so suppressing it means passing an empty one.
              label=""
              min={-bound}
              max={bound}
              ticks={ticks}
              format={gigabits}
              width={44}
            />
            <Layers>
              {/* Always the whole site. Its *role* is what the selection
                  moves: with nothing picked the total is the subject, so it
                  takes the saturated pair; pick a row and it steps back to the
                  wash the overlay sits in. Same series, same layer — one
                  swapped `as`. */}
              <AreaChart
                series={total}
                column="in"
                as={picked ? 'washIn' : 'strongIn'}
                axis="bps"
                baseline={0}
                legend="To site"
              />
              <AreaChart
                series={totalDown}
                column="out"
                as={picked ? 'washOut' : 'strongOut'}
                axis="bps"
                baseline={0}
                legend="From site"
              />
              {/* …and, when a row is picked, its contribution *within* it. Same
                  baseline, drawn after, and now the only saturated thing on the
                  chart — so the dark region is the part of the wash this
                  interface accounts for. */}
              {picked && pickedDown && (
                <AreaChart
                  series={picked}
                  column="in"
                  as="strongIn"
                  axis="bps"
                  baseline={0}
                  legend={`${selected} to site`}
                />
              )}
              {picked && pickedDown && (
                <AreaChart
                  series={pickedDown}
                  column="out"
                  as="strongOut"
                  axis="bps"
                  baseline={0}
                  legend={`${selected} from site`}
                />
              )}
            </Layers>
          </ChartRow>
        </ChartContainer>
      </div>

      {preview ? null : (
        <>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>Traffic by Interface</h3>
            <button
              type="button"
              className={styles.clear}
              disabled={selected === null}
              onClick={() => setSelected(null)}
            >
              ⊗ Clear Selection
            </button>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className={styles.pick}
                    aria-label="Selected"
                  />
                  <th scope="col">Interface</th>
                  <th scope="col">Category</th>
                  <th scope="col">In / out</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.name}
                    className={styles.row}
                    aria-selected={r.name === selected}
                    onClick={() =>
                      setSelected(r.name === selected ? null : r.name)
                    }
                  >
                    <td className={styles.pick} />
                    <td className={styles.name}>{r.name}</td>
                    <td className={styles.category}>
                      {r.category.toUpperCase()} (SAP)
                    </td>
                    <td>
                      <div className={styles.bullets}>
                        <Bullet
                          at={r.points[mark]![1]}
                          mean={r.meanIn}
                          scale={scale}
                          track={'var(--rep-in-track)'}
                          fill={'var(--rep-in)'}
                          mark={'var(--rep-in-mark)'}
                          label={`${r.name} to site`}
                        />
                        <Bullet
                          at={r.points[mark]![2]}
                          mean={r.meanOut}
                          scale={scale}
                          track={'var(--rep-out-track)'}
                          fill={'var(--rep-out)'}
                          mark={'var(--rep-out-mark)'}
                          label={`${r.name} from site`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One direction's bar: a pale full-width track, a filled portion at the
 * window **mean**, a darker tick at the **tracked** value, and that value
 * spelled out. Plain DOM, not a chart — at one row per interface a
 * `<BarChart>` would cost a canvas and a scale each to draw one rectangle.
 * Reach for a chart when you need an axis.
 *
 * `at` is the value at the instant the pointer is over (the window's last when
 * it is elsewhere). The tick and the printed number are the *same* number by
 * construction — one prop feeds both — because a marker and a label that
 * disagree about "the current value" is the failure mode this readout has.
 */
function Bullet({
  at,
  mean,
  scale,
  track,
  fill,
  mark,
  label,
}: {
  at: number;
  mean: number;
  scale: number;
  track: string;
  fill: string;
  mark: string;
  label: string;
}) {
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  return (
    <div className={styles.bulletRow}>
      <div
        className={styles.track}
        style={{ background: track }}
        role="img"
        aria-label={`${label}: ${rate(at)}, mean ${rate(mean)}`}
      >
        <div
          className={styles.fill}
          style={{ width: pct(mean), background: fill }}
        />
        <div
          className={styles.mark}
          style={{ left: pct(at), background: mark }}
        />
      </div>
      <span className={styles.value}>{rate(at)}</span>
    </div>
  );
}

/** The product's own palette, as a theme — one styling channel, different
 *  values. Built at module scope: it reads no CSS custom properties, so it
 *  neither needs nor wants the site's `useChartTheme` bridge, and it does not
 *  flip with the site's dark mode (the replica is a light surface). */
const TO_SITE = '#6ba5dc';
const FROM_SITE = '#f0a35a';

const replicaTheme: ChartTheme = {
  ...defaultTheme,
  background: '#ffffff',
  area: {
    ...defaultTheme.area,
    // Two pairs, named for the *emphasis* rather than for a series, because
    // that is what the roles select: whatever is being looked at takes
    // `strong*`, whatever is context takes `wash*`.
    //
    // `flatFill` matters here: a graded fill would fade the wash out towards
    // the baseline and the overlay would stop reading as a share of it.
    washIn: flat('#c3dbf0'),
    washOut: flat('#fbdcbe'),
    strongIn: flat('#4a8fcf'),
    strongOut: flat('#e8883c'),
  },
  axis: {
    ...defaultTheme.axis,
    label: '#8a99a8',
    grid: '#e8ecf0',
    gridDash: [],
  },
  cursor: '#98a6b4',
  chip: { background: '#ffffff' },
};

function flat(color: string) {
  return { color, width: 1, fill: color, fillOpacity: 1, flatFill: true };
}

/** The two windows the capture can actually fill. `day`/`week`/`month` are in
 *  the product's own strip; a six-hour fixture can't honour them, and a dead
 *  control is worse than no control, so they aren't rendered at all. */
const SPANS = ['1h', '6h'] as const;

/** A preset's window. `6h` is the whole capture; `1h` lands on its tail, in the
 *  busy afternoon — not a crop of the same numbers. */
function spanRange(s: (typeof SPANS)[number]): [number, number] {
  return s === '6h'
    ? [TRAFFIC_RANGE[0], TRAFFIC_RANGE[1]]
    : [TRAFFIC_RANGE[1] - 60 * 60_000, TRAFFIC_RANGE[1]];
}

/** Per-interface summary for one visible window, plus the symmetric bound the
 *  y axis needs. The capture is a uniform grid, so "which samples are in
 *  view" is index arithmetic rather than a scan. */
function windowStats(range: readonly [number, number]) {
  const i0 = Math.max(0, Math.ceil((range[0] - START_MS) / STEP_MS));
  const i1 = Math.min(COUNT - 1, Math.floor((range[1] - START_MS) / STEP_MS));
  const n = Math.max(1, i1 - i0 + 1);

  let bound = 0;
  for (let i = i0; i <= i1; i += 1) {
    let inb = 0;
    let outb = 0;
    for (const sap of SAP_TRAFFIC) {
      inb += sap.points[i]![1];
      outb += sap.points[i]![2];
    }
    bound = Math.max(bound, inb, outb);
  }

  const rows = SAP_TRAFFIC.map((sap) => {
    let sumIn = 0;
    let sumOut = 0;
    let peakIn = 0;
    let peakOut = 0;
    for (let i = i0; i <= i1; i += 1) {
      const a = sap.points[i]![1];
      const b = sap.points[i]![2];
      sumIn += a;
      sumOut += b;
      if (a > peakIn) peakIn = a;
      if (b > peakOut) peakOut = b;
    }
    return {
      name: sap.name,
      category: sap.category,
      // Kept on the row so the tracked value is a lookup at render time — the
      // window aggregates above don't recompute just because the pointer moved.
      points: sap.points,
      meanIn: sumIn / n,
      meanOut: sumOut / n,
      peakIn,
      peakOut,
    };
  });

  return { rows, peak: bound, i0, i1 };
}

/** How many gridlines each half of the mirror gets — the axis is symmetric, so
 *  the row's height is split between two stacks of labels and a short chart
 *  would otherwise pile them on top of each other. */
function ticksPerHalf(chartHeight: number): number {
  return Math.max(2, Math.min(6, Math.round(chartHeight / 42)));
}

/** Round the window's peak up to a whole number of gridline steps, so the
 *  mirrored axis is symmetric and its ticks land on round numbers. */
function niceBound(peak: number, per: number): number {
  const s = step(peak, per);
  return Math.max(s, Math.ceil(peak / s) * s);
}

/** `per` gridlines per half, snapped to a 1/2/5 × 10ⁿ step. */
function step(peak: number, per: number): number {
  const raw = Math.max(peak, 1) / per;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

/** Every step from −bound to +bound, labelled as the product labels them:
 *  magnitudes with a `G` suffix, and a bare `0.0` on the shared zero line. */
function symmetricTicks(bound: number, per: number) {
  const s = step(bound, per);
  const out: Array<{ at: number; label: string }> = [];
  for (let v = -bound; v <= bound + 1e-9; v += s) {
    const at = Math.round(v * 1e6) / 1e6;
    out.push({ at, label: gigabits(at) });
  }
  return out;
}

/** Both halves are magnitudes; only the drawing is signed. Hoisted so the axis
 *  isn't re-registered every render. */
const gigabits = (v: number): string => {
  const m = Math.abs(v);
  return m === 0 ? '0.0' : `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}G`;
};

/** Gbps in the units the table uses — sub-gigabit rows read in Mbps. */
function rate(gbps: number): string {
  return gbps >= 1
    ? `${gbps.toFixed(1)}Gbps`
    : `${Math.round(gbps * 1000)}Mbps`;
}

/** The capture's own clock, in UTC — a fixed string rather than the reader's
 *  locale, so the build and the browser agree. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
