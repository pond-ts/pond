import { useMemo, useState } from 'react';
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
 * **The overlay.** Selecting a row does not swap the chart's series. The pale
 * wash is *always* the site total; the picked interface is drawn **over** it in
 * the saturated shade, from the same zero line, so the dark region reads as
 * that interface's share *of* the total rather than as a separate chart. Two
 * more `<AreaChart>`s, mounted after the total's — that is the whole trick.
 *
 * **The palette.** It is the product's, not pond's, and it arrives through the
 * one channel a chart has for colour: a {@link ChartTheme}. No hex literal
 * reaches the JSX. Swap `theme={replicaTheme}` for the site's
 * `useSiteChartTheme()` and the chart is a pond chart again with no other edit.
 */
export default function GallerySiteTrafficDashboard({
  width = 620,
  chartHeight = 250,
  preview = false,
}: {
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
  const [selected, setSelected] = useState<string | null>(
    preview ? SAP_TRAFFIC[0]!.name : null,
  );
  const [gridlines, setGridlines] = useState(true);
  const [span, setSpan] = useState<'1h' | '6h'>('6h');

  // Only the two windows the capture can actually fill. `day`/`week`/`month`
  // are rendered disabled rather than silently clamped — a control that lies
  // about its data is worse than a control that isn't there.
  const range = useMemo<readonly [number, number]>(
    () =>
      span === '6h'
        ? TRAFFIC_RANGE
        : [TRAFFIC_RANGE[1] - 60 * 60_000, TRAFFIC_RANGE[1]],
    [span],
  );

  const { rows, peak } = useMemo(() => windowStats(range), [range]);
  const per = ticksPerHalf(chartHeight);
  const bound = niceBound(peak, per);

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
    <div className={styles.dash} style={{ width: width + 32 }}>
      <header className={styles.topbar}>
        <div className={styles.org}>
          European Organization for Nuclear Research
        </div>
        <nav className={styles.tabs} aria-label="View">
          <button type="button" className={styles.tab} aria-current="page">
            Interfaces
          </button>
          <button type="button" className={styles.tab} disabled>
            Flow
          </button>
        </nav>
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
                  aria-pressed={s === span}
                  disabled={s !== '1h' && s !== '6h'}
                  title={
                    s === '1h' || s === '6h'
                      ? undefined
                      : 'The fixture is a six-hour capture'
                  }
                  onClick={() => setSpan(s as '1h' | '6h')}
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
          cursor="crosshair"
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
              {/* Always the whole site — the wash the overlay sits in. */}
              <AreaChart
                series={total}
                column="in"
                as="totalIn"
                axis="bps"
                baseline={0}
                legend="To site"
              />
              <AreaChart
                series={totalDown}
                column="out"
                as="totalOut"
                axis="bps"
                baseline={0}
                legend="From site"
              />
              {/* …and, when a row is picked, its contribution *within* it. Same
                  baseline, drawn after, saturated — so the dark region is the
                  part of the wash this interface accounts for. */}
              {picked && pickedDown && (
                <AreaChart
                  series={picked}
                  column="in"
                  as="pickIn"
                  axis="bps"
                  baseline={0}
                  legend={`${selected} to site`}
                />
              )}
              {picked && pickedDown && (
                <AreaChart
                  series={pickedDown}
                  column="out"
                  as="pickOut"
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
                          now={r.nowIn}
                          mean={r.meanIn}
                          scale={scale}
                          track={'var(--rep-in-track)'}
                          fill={'var(--rep-in)'}
                          mark={'var(--rep-in-mark)'}
                          label={`${r.name} to site`}
                        />
                        <Bullet
                          now={r.nowOut}
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
 * window **mean**, a darker tick at the **current** value, and that value
 * spelled out. Plain DOM, not a chart — at one row per interface a
 * `<BarChart>` would cost a canvas and a scale each to draw one rectangle.
 * Reach for a chart when you need an axis.
 */
function Bullet({
  now,
  mean,
  scale,
  track,
  fill,
  mark,
  label,
}: {
  now: number;
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
        aria-label={`${label}: now ${rate(now)}, mean ${rate(mean)}`}
      >
        <div
          className={styles.fill}
          style={{ width: pct(mean), background: fill }}
        />
        <div
          className={styles.mark}
          style={{ left: pct(now), background: mark }}
        />
      </div>
      <span className={styles.value}>{rate(now)}</span>
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
    // `flatFill` matters here: a graded fill would fade the wash out towards
    // the baseline and the overlay would stop reading as a share of it.
    totalIn: flat('#c3dbf0'),
    totalOut: flat('#fbdcbe'),
    pickIn: flat('#4a8fcf'),
    pickOut: flat('#e8883c'),
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

const SPANS = ['1h', '6h', 'day', 'week', 'month', 'custom'] as const;

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
      nowIn: sap.points[i1]![1],
      nowOut: sap.points[i1]![2],
      meanIn: sumIn / n,
      meanOut: sumOut / n,
      peakIn,
      peakOut,
    };
  });

  return { rows, peak: bound };
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
