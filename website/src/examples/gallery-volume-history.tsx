import { useMemo, useState } from 'react';
import { Sequence, TimeRange, TimeSeries, type BoundedSequence } from 'pond-ts';
import {
  BarList,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  Marker,
  Region,
  YAxis,
  type ChartTheme,
  type ListCellSpec,
  type ListRow,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  VOLUME_LAST,
  VOLUME_MONTHS,
  VOLUME_RANGE,
  volumeAt,
  volumeMonth,
  volumeMonthStart,
  volumeSeries,
} from './lib/esnet-volume';
import styles from './gallery-volume-history.module.css';

/**
 * **ESnet's traffic-volume history** — thirty-six years of the US Department
 * of Energy's science network, rebuilt on pond. Real measured data (see
 * `lib/esnet-volume-samples.ts`), in contrast to the modelled fixtures most of
 * the Gallery runs on.
 *
 * The chart exists because of one number: the record spans **1.9 × 10¹⁰ to
 * 2.6 × 10¹⁷ bytes a month**, seven orders of magnitude. On a linear axis the
 * first two decades are a flat line on the floor — which is what the
 * **Scale** toggle is for, and why `<YAxis scale="log">` had to exist before
 * this card could.
 *
 * Five things are worth reading the source for:
 *
 * **The log axis formats the value, not its logarithm.** `format` is a
 * *function* returning `197.82 PB`, and it is applied to the ticks, to the
 * cursor readout and to nothing else — the transform lives in the scale, so no
 * layer, annotation or readout ever sees a logarithm. The obvious workaround
 * (plotting a `log10` column on a linear axis) makes every one of those lie.
 *
 * **The staggered starts are gaps, not zeroes.** `lhcone` begins in 2015 and
 * `oscars` in 2009; the months before are **absent** (`required: false` +
 * `null`), so those lines simply start partway across the plot. Zero would be
 * a different — and false — claim, and on a log axis it has no position at all.
 *
 * **The trend starts from a marker you can drag**, and is fitted on the data
 * from there to the end of the visible window, then drawn from there onward —
 * so the extrapolation past the last sample is over ground the fit actually
 * saw. That makes the marker a *question*: fitted from 1990 the record grows
 * +51.9% a year and doubles every 20 months; dragged to 2015 the same data
 * says +17.6% and 51 months. One fit across all 439 months averages two
 * different eras together, and dragging is how you find that out.
 *
 * **The trend is modelled, and says so** — `line.trend`, whose only job is to
 * be dashed. On a log axis an exponential fit is a **straight line**, which is
 * why this dataset is conventionally drawn log.
 *
 * **The summary is `<BarList>`, not markup.** One row per series, the bar
 * encoding its share of the month's total, the swatch tying it to its line.
 */
export default function GalleryVolumeHistory({
  width,
  phase,
  height = 300,
  preview = false,
}: {
  width: number;
  /** Autoplay loop phase from the Gallery card — sweeps a fifteen-year window
   *  across the record. Omitted on the page, where the reader steers. */
  phase?: number;
  height?: number;
  /**
   * Card mode: the chart alone, on a log axis, with no controls and no
   * summary. A card stage is ~200px tall and clips from its centre, so the
   * whole panel would arrive headless.
   */
  preview?: boolean;
}) {
  const theme = useSiteChartTheme();
  const series = volumeSeries();

  const [span, setSpan] = useState<Span>('All');
  const [scale, setScale] = useState<'log' | 'linear'>('log');
  const [grid, setGrid] = useState(true);
  const [trend, setTrend] = useState<Trend>('off');
  const [month, setMonth] = useState(VOLUME_LAST);
  /** The month the trend is fitted **from** — the draggable marker. */
  const [trendFrom, setTrendFrom] = useState(0);

  // The visible window. Held here rather than inside the container because two
  // things write it — the TIME presets and the pan/zoom gesture — and whichever
  // owned it alone would win forever. `onTimeRangeChange` is what routes the
  // gesture through us.
  const [range, setRange] = useState<[number, number]>(() => spanRange('All'));

  // Which preset the window currently *is*, compared rather than remembered,
  // so panning off a preset lights neither button instead of lying about it.
  const activeSpan = SPANS.find((s) => {
    const [a, b] = spanRange(s);
    return a === range[0] && b === range[1];
  });

  const view = phase === undefined ? range : previewWindow(phase);

  // Which months the window actually contains — index arithmetic on the
  // calendar rather than a scan, since the grid has no holes.
  const first = firstMonthIn(view[0]);
  const last = Math.min(VOLUME_LAST, monthIndexAt(view[1]));

  // The selected month is clamped into the window: a highlight band nobody can
  // see, over numbers nobody can check against the chart, is worse than none.
  const marked = Math.min(Math.max(month, first), last);

  // Where the trend is fitted **from** — the draggable marker's month. Clamped
  // the same way, and two months short of the end because three points is the
  // fewest a least-squares line can be honest about.
  const origin = Math.min(
    Math.max(trendFrom, first),
    Math.max(first, last - 2),
  );

  // The fit window is `[origin, last]` — fitted on the data from the marker to
  // the end of the visible range, then drawn from the marker onward. Passing
  // the window in rather than hardcoding it is what makes "since 2015?" a
  // question the reader can ask by dragging.
  const fit = useMemo(
    () => (trend === 'off' ? null : fitTrend(trend, origin, last)),
    [trend, origin, last],
  );

  // The fitted line as its own series — one row per month from the marker to
  // the right edge, so the extrapolation past the last sample is drawn rather
  // than implied. Memoized: a fresh series identity re-registers the layer.
  const trendSeries = useMemo(
    () => (fit === null ? null : trendLine(fit, origin, view[1], scale)),
    [fit, origin, view, scale],
  );

  // The y domain, computed rather than auto-fitted, because the trend is a
  // layer like any other and joins the fit — a linear fit runs *negative* over
  // a long window, and letting that pick the bottom of a log axis would be
  // absurd. Data sets the floor; the trend may only widen the top.
  const domain = useMemo(
    () => yDomain(first, last, scale, fit, origin, view[1]),
    [first, last, scale, fit, origin, view],
  );

  // The selected month's calendar extent — a real month, from pond's own
  // calendar, rather than a nominal 30 days. Each point on the chart is a
  // *month's* total, so the band is the span the point stands for.
  const markedRange = useMemo(
    () => TimeRange.fromCalendar('month', volumeMonth(marked), MONTH_TZ),
    [marked],
  );

  // The month grid the dragged marker snaps to. `Sequence.calendar('month')`
  // because a month is a **calendar unit, not a duration** — `DurationUnit`
  // stops at `d`, and `'m'` there means minutes. The marker's own snapping
  // (`snapToGuides`) follows *other marks* and session boundaries, not cursor
  // buckets, so a dragged mark would otherwise land mid-month.
  const monthGrid = useMemo(
    () =>
      MONTH_SEQUENCE.bounded(new TimeRange({ start: view[0], end: view[1] })),
    [view],
  );

  /** The origin marker is a page thing, not a card thing. */
  const trendMarker = !preview && fit !== null;

  const chart = (
    <ChartContainer
      range={view}
      width={width}
      theme={theme}
      grid={grid}
      // ---------------------------------------------------------------
      // The gesture budget — three, deliberately, not four.
      //
      // KEPT: hover reads all three series; drag pans; wheel zooms. Plus
      // the marker drag, which only exists while a trend is on and which
      // the library trades against hover (see `<Marker>` below).
      //
      // DROPPED: the **bucketed region cursor**. It would have been the
      // prettiest way to pick a month — `cursorSequence` +
      // `Sequence.calendar('month')` shades the real month under the
      // pointer, and a plain click fires `onRegionSelect` with exactly
      // that month (measured: `[2016-12-01Z, 2017-01-01Z]`). Two
      // measured facts ruled it out anyway:
      //
      //   1. `cursorSequence` is honoured **only** for `cursor="region"`,
      //      and `cursorParts('region')` is a band with no dots and no
      //      chips. Adopting it trades the three-series byte readout —
      //      the thing that proves the log axis formats values — for a
      //      shaded rectangle.
      //   2. It is invisible exactly when it would be used: any mark in
      //      edit mode forces `cursorParts('none')` for the whole row,
      //      so while the trend marker is draggable there is no region
      //      cursor to click.
      //
      // Two of the four cannot be on screen together by construction, so
      // this chart takes the readout and moves the marker by dragging it.
      // ---------------------------------------------------------------
      cursor="flag"
      // Drag to pan, wheel to zoom, clamped to the record (plus the two years
      // of empty right margin the extrapolation needs). No
      // `regionSelectModifier` is needed: that only arbitrates pan against a
      // region-drag, and there is no region cursor here. Off on the card: a
      // card that zooms under the wheel traps the scroll of anyone paging
      // down the Gallery.
      panZoom={preview ? 'none' : 'panZoom'}
      bounds={PAN_BOUNDS}
      onTimeRangeChange={setRange}
    >
      <ChartRow height={height}>
        <YAxis
          id="bytes"
          side="left"
          label=""
          scale={scale}
          min={domain[0]}
          max={domain[1]}
          // No explicit `ticks`: the axis picks the decades itself now
          // (`yTickValues` steps by whole powers of ten and thins to the row's
          // height). `format` stays a **function** — it is the one thing the
          // readout, the ticks and the marker's axis pill all share.
          format={formatBytes}
          width={58}
        />
        <Layers>
          {/* The month under inspection, as a shaded span. Drawn first so the
              lines sit over it. Inert — it is a readout of the stepper below,
              not something to click. */}
          {preview ? null : (
            <Region
              from={markedRange.start}
              to={markedRange.endMs}
              label={monthLabel(marked)}
              selectable={false}
            />
          )}
          {/* Where the trend starts — **drag it**. Only exists while a trend
              is on, because it has nothing to mean otherwise, and `editing`
              is what makes it draggable. Note the cost, which is the library's
              rule rather than a choice here: a mark in edit mode suppresses
              the row's data cursor (`editingActive` forces `cursorParts
              ('none')`), so the hover readout steps aside while the origin is
              placeable. */}
          {trendMarker && (
            <Marker
              at={volumeMonthStart(origin)}
              label={`Fit from ${monthLabel(origin)}`}
              editing
              indicator
              onChange={(at) => setTrendFrom(snapToMonth(monthGrid, at))}
            />
          )}
          <LineChart
            series={series}
            column="total"
            as="primary"
            axis="bytes"
            legend="Total"
          />
          <LineChart
            series={series}
            column="lhcone"
            as="secondary"
            axis="bytes"
            legend="LHCONE"
          />
          <LineChart
            series={series}
            column="oscars"
            as="context"
            axis="bytes"
            legend="OSCARS"
          />
          {trendSeries && (
            <LineChart
              series={trendSeries}
              column="fit"
              // `line.trend` is dashed, and dashed is the register for a
              // *modelled* series — this line is not a measurement.
              as="trend"
              axis="bytes"
              legend={trend === 'linear' ? 'Linear trend' : 'Exponential trend'}
            />
          )}
        </Layers>
      </ChartRow>
      {preview ? null : <Legend placement="top-left" />}
    </ChartContainer>
  );

  if (preview) return chart;

  const now = volumeAt(marked);

  return (
    <div className={styles.panel}>
      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Month</span>
          <div className={styles.stepper}>
            <button
              type="button"
              onClick={() => setMonth(marked - 1)}
              disabled={marked <= first}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className={styles.month}>{monthLabel(marked)}</span>
            <button
              type="button"
              onClick={() => setMonth(marked + 1)}
              disabled={marked >= last}
              aria-label="Next month"
            >
              ›
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
                onClick={() => {
                  const next = spanRange(s);
                  setSpan(s);
                  setRange(next);
                  // Re-seat the trend's origin on the new window's first month.
                  // Changing the range otherwise strands the marker off-screen
                  // (narrowing) or leaves it stuck mid-plot (widening), and a
                  // fit whose start you can't see is a fit you can't read.
                  setTrendFrom(firstMonthIn(next[0]));
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Scale</span>
          <div className={styles.seg}>
            {(['linear', 'log'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={s === scale}
                onClick={() => setScale(s)}
              >
                {s === 'log' ? 'Log' : 'Linear'}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Gridlines</span>
          <div className={styles.seg}>
            <button
              type="button"
              aria-pressed={!grid}
              onClick={() => setGrid(false)}
            >
              Off
            </button>
            <button
              type="button"
              aria-pressed={grid}
              onClick={() => setGrid(true)}
            >
              On
            </button>
          </div>
        </div>

        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Trend (total)</span>
          <div className={styles.seg}>
            {TRENDS.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={t === trend}
                onClick={() => setTrend(t)}
              >
                {TREND_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Two things at once, because the newest month has to be *visible*
            to be worth selecting: re-seat the window on the current preset
            (undoing any pan), then move the mark to the last sample. */}
        <button
          type="button"
          className={styles.recent}
          disabled={marked === VOLUME_LAST && activeSpan !== undefined}
          onClick={() => {
            setRange(spanRange(activeSpan ?? span));
            setMonth(VOLUME_LAST);
          }}
        >
          Show most recent month
        </button>
      </div>

      {chart}

      {fit && (
        <p className={styles.credit}>
          {fitCaption(fit, monthLabel(origin), last - origin + 1)}{' '}
          <em>
            Drag the marker to refit from another month — the readout follows.
          </em>
        </p>
      )}

      <div className={styles.tableHead}>
        <h4 className={styles.tableTitle}>{monthLabel(marked)}</h4>
        <span className={styles.tableNote}>
          Bar and per cent are the share of that month&rsquo;s total;{' '}
          <strong>1 m</strong> and <strong>1 y</strong> compare with the
          previous month and the same month a year earlier.
        </span>
      </div>

      {/* The summary is `<BarList>` — the list family renders a real table
          (label cells, aligned data cells, row semantics), which is what this
          is. The bar is the share of the month's total, on one shared domain
          pinned to that total so the four bars are directly comparable and
          `Total` is a full track. */}
      <div className={styles.tableWrap}>
        <BarList
          rows={summaryRows(marked, theme)}
          columns={SUMMARY_COLUMNS}
          domain={[0, now.total]}
          after={SUMMARY_CELLS}
          barHeight={10}
          theme={theme}
        />
      </div>

      <p className={styles.credit}>
        Data: <a href="https://www.es.net/">ESnet</a>, the US Department of
        Energy&rsquo;s Energy Sciences Network — {VOLUME_MONTHS} months of
        measured traffic volume, 1990-01 to {volumeMonth(VOLUME_LAST)}. Real,
        unlike most of the Gallery&rsquo;s fixtures.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** The presets, in the order the strip lists them. */
const SPANS = ['6M', '1Y', '5Y', '15Y', 'All'] as const;
type Span = (typeof SPANS)[number];

const SPAN_MONTHS: Record<Span, number> = {
  '6M': 6,
  '1Y': 12,
  '5Y': 60,
  '15Y': 180,
  All: VOLUME_MONTHS,
};

/**
 * Empty months kept to the **right** of the last sample, so a trend has
 * somewhere to be extrapolated into. A tenth of the window, floored at two so
 * the six-month preset shows something and capped at two years so `All`
 * doesn't spend a twentieth of its width on white space.
 */
function headroom(months: number): number {
  return Math.max(2, Math.min(Math.round(months * 0.1), 24));
}

/** A preset's window: the last `n` months, plus the right margin. */
function spanRange(s: Span): [number, number] {
  const months = SPAN_MONTHS[s];
  return [
    volumeMonthStart(Math.max(0, VOLUME_MONTHS - months)),
    volumeMonthStart(VOLUME_LAST + headroom(months)),
  ];
}

/** How far the pan/zoom gesture may take the window — the record, plus the
 *  largest right margin any preset asks for. */
const PAN_BOUNDS: readonly [number, number] = [
  VOLUME_RANGE[0],
  volumeMonthStart(VOLUME_LAST + 24),
];

/** The card's window: fifteen years sweeping across the record, so the
 *  staggered starts arrive rather than just being there. */
function previewWindow(phase: number): [number, number] {
  return scanWindow(
    VOLUME_RANGE[0],
    VOLUME_RANGE[1],
    15 * 12 * MONTH_MS,
    phase,
  );
}

/** Nominal month, for the card's sweep only — never for a boundary. */
const MONTH_MS = 30.44 * 24 * 3_600_000;

/** Index of the month *containing* `ms`. */
function monthIndexAt(ms: number): number {
  const d = new Date(ms);
  const [y0, m0] = VOLUME_EPOCH;
  return (d.getUTCFullYear() - y0) * 12 + (d.getUTCMonth() - m0);
}

/** Index of the first month whose sample lands at or after `ms`. */
function firstMonthIn(ms: number): number {
  const i = monthIndexAt(ms);
  const clamped = Math.max(0, Math.min(VOLUME_LAST, i));
  return volumeMonthStart(clamped) < ms
    ? Math.min(VOLUME_LAST, clamped + 1)
    : clamped;
}

/** `[year, monthIndex]` of the record's first month. */
const VOLUME_EPOCH: readonly [number, number] = [1990, 0];

/** UTC, because the fixture's months are UTC months. The axis renders in the
 *  reader's local zone, so a band can sit a few hours off its label at the
 *  tightest zoom — the alternative is a band that moves with the reader. */
const MONTH_TZ = { timeZone: 'UTC' } as const;

/**
 * The calendar-month grid the marker snaps to.
 *
 * `Sequence.calendar('month')`, not a duration: months are 28–31 days, so
 * there is no month *duration* to step by — `DurationUnit` stops at `d`, and
 * `'m'` there is **minutes**. Hoisted, because the sequence is realized against
 * the view on every change and a fresh instance would re-realize it needlessly.
 */
const MONTH_SEQUENCE = Sequence.calendar('month', MONTH_TZ);

/** The record's month index nearest `at`, snapped to the realized grid. */
function snapToMonth(grid: BoundedSequence, at: number): number {
  let bestIndex = monthIndexAt(at);
  let bestGap = Infinity;
  for (let i = 0; i < grid.length; i += 1) {
    const gap = Math.abs(grid.at(i)!.begin() - at);
    if (gap < bestGap) {
      bestGap = gap;
      bestIndex = monthIndexAt(grid.at(i)!.begin());
    }
  }
  return Math.max(0, Math.min(VOLUME_LAST, bestIndex));
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

const TRENDS = ['off', 'linear', 'exponential'] as const;
type Trend = (typeof TRENDS)[number];

const TREND_LABELS: Record<Trend, string> = {
  off: 'Off',
  linear: 'Linear',
  exponential: 'Exp',
};

/** A fitted model of the total: `predict(i)` in bytes at month index `i`. */
interface Fit {
  readonly kind: 'linear' | 'exponential';
  readonly predict: (monthIndex: number) => number;
  /** Slope in the fitted space — bytes per month (linear) or log-bytes per
   *  month (exponential), which is what the caption turns into a growth rate. */
  readonly slope: number;
}

/**
 * Ordinary least squares over the **visible** months — on the values for
 * `linear`, on their natural logarithms for `exponential`, which is the whole
 * difference between the two and the reason an exponential fit draws as a
 * straight line on a log axis.
 *
 * Fitted on `total` only: three fitted lines over three data lines is six
 * lines, and the total is the one the question is about.
 */
function fitTrend(
  kind: 'linear' | 'exponential',
  i0: number,
  i1: number,
): Fit | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = i0; i <= i1; i += 1) {
    const v = volumeAt(i).total;
    // A non-positive sample has no logarithm; this record has none, but a fit
    // that silently skipped them would be the wrong kind of quiet.
    if (!(v > 0)) continue;
    const x = i - i0;
    const y = kind === 'exponential' ? Math.log(v) : v;
    n += 1;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  if (n < 3) return null;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const predict = (i: number) => {
    const y = intercept + slope * (i - i0);
    return kind === 'exponential' ? Math.exp(y) : y;
  };
  return { kind, predict, slope };
}

const TREND_SCHEMA = [
  { name: 'time', kind: 'time' },
  // `required: false` because a *linear* fit over a long window is negative
  // early on, and a negative number has no position on a log axis. Absent is
  // the truthful way to say "this model doesn't have a value here".
  { name: 'fit', kind: 'number', required: false },
] as const;

/** The fit as a drawable series: every month from the first visible one to the
 *  right edge of the window, so the extrapolation past the last sample is
 *  drawn rather than implied. */
function trendLine(
  fit: Fit,
  from: number,
  rightEdge: number,
  scale: 'log' | 'linear',
): TimeSeries<typeof TREND_SCHEMA> {
  const to = monthIndexAt(rightEdge);
  const rows: [number, number | null][] = [];
  for (let i = from; i <= to; i += 1) {
    const v = fit.predict(i);
    rows.push([
      volumeMonthStart(i),
      Number.isFinite(v) && (scale === 'linear' || v > 0) ? v : null,
    ]);
  }
  return TimeSeries.fromJSON({
    name: 'trend',
    schema: TREND_SCHEMA,
    rows,
  });
}

/** What the fit actually says, in words — computed from the fit, never
 *  estimated. */
function fitCaption(fit: Fit, from: string, months: number): string {
  const over = `from ${from} (${months} months)`;
  if (fit.kind === 'exponential') {
    const yearly = Math.exp(fit.slope * 12) - 1;
    const doubling = Math.log(2) / fit.slope;
    const pace =
      doubling > 0
        ? `doubling every ${doubling.toFixed(0)} months`
        : `halving every ${(-doubling).toFixed(0)} months`;
    return `Exponential fit ${over}: ${signedPercent(yearly * 100)} a year, ${pace}. On a log axis that is a straight line.`;
  }
  return `Linear fit ${over}: ${fit.slope >= 0 ? '+' : '−'}${formatBytes(Math.abs(fit.slope))} a month. On a log axis a straight-line model bends.`;
}

// ---------------------------------------------------------------------------
// Axis
// ---------------------------------------------------------------------------

/**
 * The y domain. `log` snaps to whole decades, which is what its gridlines are;
 * `linear` runs from zero, which is what makes the first two decades of the
 * record collapse onto the floor — the demonstration the toggle exists for.
 *
 * The **data** sets the bottom on both. The trend is a layer, so an auto-fitted
 * domain would let a linear fit's negative early values pick the floor of a
 * log axis; it may only widen the top.
 */
function yDomain(
  i0: number,
  i1: number,
  scale: 'log' | 'linear',
  fit: Fit | null,
  fitFrom: number,
  rightEdge: number,
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = i0; i <= i1; i += 1) {
    const m = volumeAt(i);
    for (const v of [m.total, m.lhcone, m.oscars]) {
      if (v === null || !(v > 0)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [1, 10];
  if (fit !== null) {
    for (let i = fitFrom; i <= monthIndexAt(rightEdge); i += 1) {
      const v = fit.predict(i);
      if (Number.isFinite(v) && v > hi) hi = v;
    }
  }
  if (scale === 'linear') return [0, hi * 1.06];
  return [10 ** Math.floor(Math.log10(lo)), 10 ** Math.ceil(Math.log10(hi))];
}

// ---------------------------------------------------------------------------
// Summary list
// ---------------------------------------------------------------------------

/**
 * One bar per row, on the shared domain — the row's share of the total.
 *
 * Deliberately **one neutral colour for all four bars**: `BarListColumn.as` is
 * a property of the *column*, so a one-bar-per-row list cannot give each row
 * its own hue. Rather than fight that, the two channels are split — the bar
 * carries the magnitude, the swatch in the label carries the identity, and the
 * swatch takes its colour from the same `line` role the chart draws that
 * series with.
 */
const SUMMARY_COLUMNS = [{ column: 'bytes', as: 'muted' }];

/**
 * The four rows, in the order ESnet's own table lists them, each naming the
 * `line` role its swatch and its line on the chart share. `normal` is
 * **derived** — total − LHCONE − OSCARS — and is the one row with no line
 * above it, so it takes the muted, not-a-data-hue role.
 */
const SUMMARY_SERIES = [
  { key: 'oscars', name: 'OSCARS', as: 'context', note: 'reserved circuits' },
  { key: 'lhcone', name: 'LHCONE', as: 'secondary', note: 'LHC overlay' },
  { key: 'normal', name: 'Normal traffic', as: 'muted', note: 'derived' },
  { key: 'total', name: 'Total', as: 'primary', note: '' },
] as const;

type SummaryRow = ListRow & {
  readonly values: {
    readonly bytes: number | undefined;
    readonly share: number | undefined;
    readonly month: number | undefined;
    readonly year: number | undefined;
  };
};

/** The rows for one month, with the two changes computed against the month
 *  before and the same month a year earlier. */
function summaryRows(i: number, theme: ChartTheme): SummaryRow[] {
  const now = volumeAt(i);
  const prevMonth = i >= 1 ? volumeAt(i - 1) : null;
  const prevYear = i >= 12 ? volumeAt(i - 12) : null;
  return SUMMARY_SERIES.map((s) => {
    const value = now[s.key];
    // The swatch is the chart's own ink for that series, read from the same
    // theme the canvas draws with — never a literal, and never a second copy
    // of the palette that could drift out of step with it.
    const swatch = theme.line[s.as]?.color ?? theme.line.default.color;
    return {
      key: s.key,
      label: (
        <span className={styles.rowLabel}>
          <span
            className={styles.swatch}
            style={{ background: swatch }}
            aria-hidden="true"
          />
          {s.name}
          {s.note ? <span className={styles.derived}>{s.note}</span> : null}
        </span>
      ),
      values: {
        bytes: value ?? undefined,
        share: value === null ? undefined : (value / now.total) * 100,
        month: change(value, prevMonth?.[s.key] ?? null),
        year: change(value, prevYear?.[s.key] ?? null),
      },
    };
  });
}

/** Per-cent change, or `undefined` when either end is absent — a series that
 *  had not started yet has no change, which is not the same as no growth. */
function change(now: number | null, then: number | null): number | undefined {
  if (now === null || then === null || then === 0) return undefined;
  return ((now - then) / then) * 100;
}

/**
 * The cells right of the bars. The list family has no header row, so each
 * change cell carries its own `1 m` / `1 y` tag rather than relying on a
 * column heading that cannot be drawn.
 */
const SUMMARY_CELLS: ListCellSpec<SummaryRow>[] = [
  {
    key: 'bytes',
    align: 'right',
    render: (r) => (
      <span className={styles.value}>
        {r.values.bytes === undefined ? '—' : formatBytesExact(r.values.bytes)}
      </span>
    ),
  },
  {
    key: 'share',
    align: 'right',
    render: (r) => (
      <span className={styles.share}>
        {r.values.share === undefined ? '—' : `${precise(r.values.share)}%`}
      </span>
    ),
  },
  {
    key: 'month',
    align: 'right',
    render: (r) => <Change label="1 m" value={r.values.month} />,
  },
  {
    key: 'year',
    align: 'right',
    render: (r) => <Change label="1 y" value={r.values.year} />,
  },
];

function Change({
  label,
  value,
}: {
  label: string;
  value: number | undefined;
}) {
  return (
    <span className={styles.change}>
      <span className={styles.derived}>{label} </span>
      {value === undefined ? (
        <span className={styles.absent}>—</span>
      ) : (
        signedPercent(value)
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/** SI tier and mantissa for a byte count — `1.978e17` → `[197.82, 'PB']`. */
function scaleBytes(value: number): [number, string] {
  const magnitude = Math.abs(value);
  const tier = Math.min(
    UNITS.length - 1,
    Math.max(0, Math.floor(Math.log10(magnitude) / 3)),
  );
  return [magnitude / 1000 ** tier, UNITS[tier]!];
}

/**
 * Bytes for the **axis and the cursor readout** — `10 GB`, `1 PB`, `198 PB`.
 *
 * Passed to `<YAxis format>` as a **function**, which matters twice over here.
 * A d3 specifier would print `197.8P`; and on a log axis d3's `tickFormat`
 * returns the empty string for any value that isn't one of its own significant
 * ticks, so a cursor readout on a real sample would come out **blank**. A
 * function is handed to every value verbatim, so neither happens.
 *
 * Single-argument on purpose: the axis calls it as `fmt(value)`, and a second
 * optional parameter is one refactor away from being fed an array index.
 * Hoisted to module scope because an inline `format` function is a fresh
 * reference each render and would re-register the axis every frame.
 */
function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const [scaled, unit] = scaleBytes(value);
  return `${value < 0 ? '−' : ''}${Number(scaled.toPrecision(3))} ${unit}`;
}

/** Bytes for the **summary table**, to two decimals — `197.82 PB`. The table
 *  is a readout of one month, so it prints more precision than an axis tick. */
function formatBytesExact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const [scaled, unit] = scaleBytes(value);
  return `${value < 0 ? '−' : ''}${scaled.toFixed(2)} ${unit}`;
}

/** Three significant figures, kept as a string so `48.0` doesn't become `48`. */
function precise(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toPrecision(3);
}

/** A signed per cent — `+6.15%`, `−51.6%`. The minus is a real minus sign, so
 *  the column doesn't shimmer between hyphen and dash widths. */
function signedPercent(value: number): string {
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${precise(Math.abs(value))}%`;
}

const MONTH_NAMES = [
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

/** `2026-07` → `Jul 2026`. A fixed string rather than the reader's locale, so
 *  the build and the browser agree. */
function monthLabel(i: number): string {
  const [year, month] = volumeMonth(i).split('-');
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}
