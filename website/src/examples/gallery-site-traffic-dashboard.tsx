import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart,
  BoxList,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
  defaultTheme,
  type BoxListColumn,
  type ChartTheme,
  type ListCellSpec,
  type ListRow,
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
 *
 * The interface table below the chart is `<BoxList>` — the same theme, one
 * register down: `as: 'toSite' | 'fromSite'` resolves `theme.box[as]`, and the
 * picked row's teal edge is `theme.annotation.color`.
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

  // The sample every row's tick and printed value read: the hovered one while
  // the pointer is over the plot, the window's last otherwise. Clamped to the
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

  // The list's rows. The five-number summaries come from `windowStats` and
  // move only when the window does; the two `*_now` entries are re-read on
  // every pointer move, which is the only part of the row the tracker touches.
  const listRows = useMemo<IfaceRow[]>(
    () =>
      rows.map((r) => ({
        key: r.name,
        label: <span className={styles.name}>{r.name}</span>,
        values: {
          category: r.category,
          in_min: r.in.min,
          in_q1: r.in.q1,
          in_q3: r.in.q3,
          in_max: r.in.max,
          in_now: r.points[mark]![1],
          out_min: r.out.min,
          out_q1: r.out.q1,
          out_q3: r.out.q3,
          out_max: r.out.max,
          out_now: r.points[mark]![2],
        },
      })),
    [rows, mark],
  );

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

          {/* The interface table is `<BoxList>`, which is a *table* rather than
              a plot (label cells, arbitrary data cells, per-row selection) and
              so renders DOM, not a canvas. Its glyph is this cell: a pale
              range band, a filled inter-quartile body, a dark current-value
              tick and that value printed beside it. Everything around it is a
              prop — `before` for the category tag, `selected` + `onRowClick`
              for the state the chart overlay reads. No shared scale to wire:
              one domain is fitted across every box of every row. */}
          <div className={styles.tableWrap}>
            <BoxList
              rows={listRows}
              columns={LIST_COLUMNS}
              theme={replicaTheme}
              before={BEFORE_CELLS}
              selected={selected}
              onRowClick={(r) =>
                setSelected((s) => (r.key === s ? null : r.key))
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

/** One interface's row. `category` is typed through because a `before` cell
 *  reads it — `<BoxList>` is generic over the row, so the extra field survives
 *  the trip into the callback. The rest are plain scale values. */
type IfaceRow = ListRow & { readonly values: { readonly category: string } };

/**
 * The two box lines drawn per row, top→bottom — the same in/out pairing the
 * chart mirrors, and named for the same two roles, so a row's boxes and the
 * band they contribute to are visibly one series.
 *
 * Each line carries **both facts the readout needs at once**: the band is where
 * this interface *ran* over the visible window (min→max, with the middle half
 * filled), the tick is where it *is* at the instant under the pointer, and
 * `format` prints that same number beside it. One column spec, no second
 * encoding to keep in sync.
 *
 * The median is deliberately left out. The line already carries two marks the
 * eye has to tell apart, and a third stripe inside the body competes with the
 * tick — which is the one the readout is actually about.
 */
const LIST_COLUMNS: BoxListColumn[] = [
  {
    lower: 'in_min',
    q1: 'in_q1',
    q3: 'in_q3',
    upper: 'in_max',
    value: 'in_now',
    format: rate,
    as: 'toSite',
  },
  {
    lower: 'out_min',
    q1: 'out_q1',
    q3: 'out_q3',
    upper: 'out_max',
    value: 'out_now',
    format: rate,
    as: 'fromSite',
  },
];

/** Between the label and the boxes: the product's category tag. */
const BEFORE_CELLS: ListCellSpec<IfaceRow>[] = [
  {
    key: 'category',
    render: (r) => (
      <span className={styles.category}>
        {r.values.category.toUpperCase()} (SAP)
      </span>
    ),
  },
];

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
  // The `<BoxList>` roles, resolved the same way one register down:
  // `theme.box[as]`. Three tones per direction, which is exactly what the
  // glyph has to say — where the interface ranged, where its middle half sat,
  // and where it is right now. The ticks are a touch more saturated than the
  // chart's own fills: in the product the bullet's mark is the loudest thing
  // in the row, and it has to beat a band sitting right underneath it.
  box: {
    ...defaultTheme.box,
    toSite: bullet('#bfd7f2', '#c9ddf2', '#5b9bd5'),
    fromSite: bullet('#fadbbc', '#f9d8b0', '#ed8c2b'),
  },
  axis: {
    ...defaultTheme.axis,
    label: '#8a99a8',
    grid: '#e8ecf0',
    gridDash: [],
    // The list reads its **text** ink from `axis.band.label` (the token the
    // stacked date band uses for the same job) — and that includes the number
    // printed beside each tick, which the product sets in a neutral grey
    // rather than its series colour. One ink for the whole list: there is no
    // per-column label colour. `fill` is required by the type and unread here
    // — no band axis on this page.
    band: { fill: '#ffffff', label: '#757575' },
  },
  cursor: '#98a6b4',
  chip: { background: '#ffffff' },
  // The annotation register — where a *user's* mark draws, as opposed to data.
  // Here that is one mark: the picked row's inset left edge, in the product's
  // teal, which is the only place teal appears on the page.
  annotation: { color: '#2fa8a0', fillOpacity: 0.1, depth: [1, 0.7, 0.4] },
  // The list tints a hovered row with `legend.border`. The panel draws no
  // `<Legend>` (its key is chrome, above the plot), so this trio is only that
  // hover wash.
  legend: { background: '#ffffff', border: '#f4f8fb', text: '#5a6b7b' },
};

function flat(color: string) {
  return { color, width: 1, fill: color, fillOpacity: 1, flatFill: true };
}

/**
 * One direction's box style, in the three tones the glyph draws with: the
 * `band` behind the whole min→max range, the `body` filling the middle half,
 * and the `tick` marking the current value.
 *
 * Two of the three are **composited, not painted**: the list draws the band at
 * a fixed `0.55` and the body at `fillOpacity × 2`. So `band` here is the
 * product's track colour divided back out of white — `#bfd7f2` renders as the
 * `#dce9f8` the product actually shows — while `fillOpacity: 0.5` doubles to a
 * flat `1`, which is what makes `body` the literal colour on screen. The body
 * paints *over* the band, so its colour is the whole story; the band's isn't.
 *
 * `median*`, `strokeWidth` and `whiskerWidth` are required by the type and
 * unread here — the median line is left out, and the tick's width is the
 * component's own 3px.
 */
function bullet(band: string, body: string, tick: string) {
  return {
    fill: body,
    fillOpacity: 0.5,
    stroke: tick,
    strokeWidth: 1.5,
    median: tick,
    medianWidth: 2,
    whisker: band,
    whiskerWidth: 1,
  };
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
    const ins: number[] = [];
    const outs: number[] = [];
    for (let i = i0; i <= i1; i += 1) {
      ins.push(sap.points[i]![1]);
      outs.push(sap.points[i]![2]);
    }
    return {
      name: sap.name,
      category: sap.category,
      // Kept on the row so the tracked value is a lookup at render time — the
      // summaries below don't recompute just because the pointer moved.
      points: sap.points,
      in: summarize(ins),
      out: summarize(outs),
    };
  });

  return { rows, peak: bound, i0, i1 };
}

/**
 * One direction's distribution over the visible window, in the vocabulary
 * `<BoxList>` reads: the range the interface actually ran in, and the middle
 * half of it. **Pre-computed here on purpose** — the list family draws
 * quantiles, it never derives them, so the statistic stays the caller's
 * decision (and this one is a plain sort over a few hundred samples, re-run
 * only when the window moves).
 */
function summarize(values: number[]) {
  const s = values.slice().sort((a, b) => a - b);
  return {
    min: s[0]!,
    q1: quantile(s, 0.25),
    q3: quantile(s, 0.75),
    max: s[s.length - 1]!,
  };
}

/** Linear-interpolated quantile of an ascending array — the `numpy`/`pandas`
 *  default convention, so the numbers match anything else you'd check against. */
function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo]! + (sorted[Math.ceil(h)]! - sorted[lo]!) * (h - lo);
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
