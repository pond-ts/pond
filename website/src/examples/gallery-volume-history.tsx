import { useMemo, useState } from 'react';
import { Sequence, TimeRange, TimeSeries } from 'pond-ts';
import {
  BarList,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
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
 * **There is exactly one selection: a month.** Everything hangs off it — the
 * band drawn on the chart, the row of numbers in the table, and the origin the
 * trend projects from. It is set two ways into the same piece of state: click
 * the plot, or step it with the arrows. That single-selection model is what
 * keeps the page honest; there is no second cursor state to fall out of sync.
 *
 * Four things are worth reading the source for:
 *
 * **The log axis formats the value, not its logarithm.** `format` is a
 * *function* returning `197.82 PB`, and the transform lives in the scale, so
 * no layer, annotation or axis pill ever sees a logarithm. The obvious
 * workaround — plotting a `log10` column on a linear axis — makes every one of
 * those lie.
 *
 * **The staggered starts are gaps, not zeroes.** `lhcone` begins in 2015 and
 * `oscars` in 2009; the months before are **absent** (`required: false` +
 * `null`), so those lines simply start partway across the plot. Zero would be
 * a different — and false — claim, and on a log axis it has no position at all.
 *
 * **The trend is fitted and then projected, and the two halves are drawn
 * differently.** Solid over the {@link LOOKBACK_MONTHS}-month window it was
 * fitted on, dashed from the selected month forward — so "what the model saw"
 * and "what the model guessed" are told apart by line style rather than by a
 * caption. The break sits exactly on the selection.
 *
 * And the finding that earns the controls: **a five-year lookback predicts
 * this data well, and only from a recent month.** Select July 2024 and the
 * exponential projection lands on **199 PB** for July 2026 against an actual
 * **197.82 PB** — within 0.5%. Walk the selection back and it falls apart:
 * March 2020 projects **3.19×** over, July 2016 **5.98×**, January 2010
 * **91.3×**. The model never changes; the growth rate does, and five years of
 * the late 2000s says nothing about the 2020s.
 *
 * Which also means the default view is deliberately undramatic — from a recent
 * month the dashed line just carries on where the data was going. That is the
 * result, not a missing feature.
 *
 * **The summary is `<BarList>`, not markup.** One row per series, the bar
 * encoding its share of the selected month's total, the swatch tying it to its
 * line on the chart.
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

  /**
   * **The** selection — one month, written by the plot click and by the
   * stepper alike. Defaults to the newest month, so the table opens on the
   * same row ESnet's own summary opens on.
   */
  const [selected, setSelected] = useState(VOLUME_LAST);

  // The visible window. Held here rather than inside the container because
  // three things write it — the TIME presets, the TREND toggle (which changes
  // the right edge) and wheel-zoom — and whichever owned it alone would win
  // forever. `onTimeRangeChange` is what routes the gesture through us.
  const [range, setRange] = useState<[number, number]>(() =>
    spanRange('All', 'off'),
  );

  // Which preset the window currently *is*, compared rather than remembered,
  // so zooming off a preset lights neither button instead of lying about it.
  const activeSpan = SPANS.find((s) => {
    const [a, b] = spanRange(s, trend);
    return a === range[0] && b === range[1];
  });

  const view = phase === undefined ? range : previewWindow(phase);

  // Which months the window actually contains — index arithmetic on the
  // calendar rather than a scan, since the grid has no holes.
  const first = firstMonthIn(view[0]);
  const last = Math.min(VOLUME_LAST, monthIndexAt(view[1]));

  // The selection, clamped into the window: a band nobody can see, over
  // numbers nobody can check against the chart, is worse than none.
  const marked = Math.min(Math.max(selected, first), last);

  // The fit window: a fixed lookback ending at the selection. Not the visible
  // range — narrowing the view must not silently change the model. `+ 1`
  // because both ends are inclusive, so a 60-month lookback is 60 samples and
  // the caption can say "five years" without lying by one.
  const fitFrom = Math.max(0, marked - LOOKBACK_MONTHS + 1);

  const fit = useMemo(
    () => (trend === 'off' ? null : fitTrend(trend, fitFrom, marked)),
    [trend, fitFrom, marked],
  );

  // Two layers, one model. The **fitted** half is drawn solid over the months
  // the least squares actually saw; the **projected** half is dashed from the
  // selection to the right edge. Both include the selected month, so they meet
  // on it rather than leaving a pixel of gap. Memoized: a fresh series
  // identity re-registers the layer.
  const fitLine = useMemo(
    () => (fit === null ? null : modelLine(fit, fitFrom, marked, scale)),
    [fit, fitFrom, marked, scale],
  );
  const projection = useMemo(
    () =>
      fit === null
        ? null
        : modelLine(fit, marked, rightEdgeMonth(trend), scale),
    [fit, marked, trend, scale],
  );

  // The y domain, computed rather than auto-fitted, because the projection is
  // a layer like any other and joins the fit — and a projection can be wrong
  // by decades. Data sets the floor; the projection may lift the ceiling only
  // so far before it is left to run off the top (see `yDomain`).
  const domain = useMemo(
    () => yDomain(first, last, scale, fit, fitFrom, rightEdgeMonth(trend)),
    [first, last, scale, fit, fitFrom, trend],
  );

  // The selected month's calendar extent — a real month, from pond's own
  // calendar, rather than a nominal 30 days. Each point on the chart is a
  // *month's* total, so the band is the span the point stands for.
  const markedRange = useMemo(
    () => TimeRange.fromCalendar('month', volumeMonth(marked), MONTH_TZ),
    [marked],
  );

  const chart = (
    <ChartContainer
      range={view}
      width={width}
      theme={theme}
      grid={grid}
      // ---------------------------------------------------------------
      // One selection, set by clicking. `cursor="region"` +
      // `cursorSequence` shades the **calendar month** under the pointer,
      // which is a preview of exactly what a click will select, and
      // `onRegionSelect` reports it. A plain click — press and release
      // without moving — fires with the single bucket under the pointer
      // (measured: `[2016-12-01Z, 2017-01-01Z]`), so no drag is needed.
      //
      // Deliberately **no hover readout**: the original has none, and one
      // would be a second thing tracking the pointer alongside the band.
      //
      // The cost, and it is a real one: a region-select **preempts pan**
      // on pointerdown unless `regionSelectModifier="shift"` is set — and
      // setting it would mean plain clicks fall through to pan and never
      // select, which is the whole gesture. So drag-to-pan is gone; the
      // wheel still zooms (unaffected in every case) and the TIME presets
      // do the coarse navigation. Three gestures, no conflicts.
      // ---------------------------------------------------------------
      cursor="region"
      cursorSequence={MONTH_SEQUENCE}
      {...(preview
        ? {}
        : {
            onRegionSelect: ([from]: readonly [number, number]) =>
              setSelected(clampMonth(monthIndexAt(from))),
          })}
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
          // No explicit `ticks`: the axis picks the decades itself
          // (`yTickValues` steps by whole powers of ten and thins to the row's
          // height). `format` stays a **function** — it is the one thing the
          // ticks and every axis pill share.
          format={formatBytes}
          width={58}
        />
        <Layers>
          {/* The selection, as a shaded span. Drawn first so the lines sit
              over it. Inert — it is a readout of the selection, and the way
              to change the selection is to click the plot. */}
          {preview ? null : (
            <Region
              from={markedRange.start}
              to={markedRange.endMs}
              label={monthLabel(marked)}
              selectable={false}
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
          {/* Solid: the window the model was fitted on. */}
          {fitLine && (
            <LineChart
              series={fitLine}
              column="fit"
              as="trendFit"
              axis="bytes"
              legend={`Fit, ${LOOKBACK_YEARS}y`}
            />
          )}
          {/* Dashed: everything after the selection, which the model is
              guessing. `line.trend` differs from `line.trendFit` by exactly
              one property — `dash` — because that is the only difference
              there should be. */}
          {projection && (
            <LineChart
              series={projection}
              column="fit"
              as="trend"
              axis="bytes"
              legend="Projection"
            />
          )}
        </Layers>
      </ChartRow>
      {preview ? null : <Legend placement="top-left" />}
    </ChartContainer>
  );

  if (preview) return chart;

  const shown = volumeAt(marked);

  return (
    <div className={styles.panel}>
      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Month</span>
          <div className={styles.stepper}>
            <button
              type="button"
              onClick={() => setSelected(marked - 1)}
              disabled={marked <= first}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className={styles.month}>{monthLabel(marked)}</span>
            <button
              type="button"
              onClick={() => setSelected(marked + 1)}
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
                  setSpan(s);
                  setRange(spanRange(s, trend));
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
                onClick={() => {
                  setTrend(t);
                  // The right edge follows the toggle: turning a projection on
                  // has to make room for it, or it would be drawn into a
                  // margin that does not exist. Keeps the left edge put.
                  setRange((r) => [r[0], volumeMonthStart(rightEdgeMonth(t))]);
                }}
              >
                {TREND_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {chart}

      {/* The model's own readout — or, when the selection is too early to have
          a lookback behind it, the reason there is no line. Saying that in the
          UI matters: a projection that silently vanishes reads as a bug. */}
      {trend !== 'off' &&
        (fit === null ? (
          <p className={styles.credit}>
            <strong>No projection.</strong> The fit needs at least three months
            of history behind the selected month, and{' '}
            {marked - fitFrom === 1
              ? 'there is 1'
              : `there are ${marked - fitFrom}`}
            . Select a later month.
          </p>
        ) : (
          <p className={styles.credit}>
            {fitCaption(fit, monthLabel(marked), marked - fitFrom + 1)}{' '}
            {backtest(fit, marked)}{' '}
            <em>
              Click the chart or step the month to refit from somewhere else.
            </em>
          </p>
        ))}

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
          domain={[0, shown.total]}
          after={SUMMARY_CELLS}
          barHeight={10}
          theme={theme}
        />
      </div>

      <p className={styles.credit}>
        Data: <a href="https://www.es.net/">ESnet</a>, the US Department of
        Energy&rsquo;s Energy Sciences Network — {VOLUME_MONTHS} months of
        measured traffic volume, 1990-01 to {volumeMonth(VOLUME_LAST)}. Real,
        unlike most of the Gallery&rsquo;s fixtures. &ldquo;Now&rdquo; on this
        page means the <strong>end of the record</strong>, never the wall clock
        — a chart whose numbers drifted with today&rsquo;s date could not render
        the same on the server and in your browser.
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

/** How far past the end of the record a projection is drawn — one year. */
const PROJECT_MONTHS = 12;

/**
 * The window's right edge, in month index.
 *
 * **"Now" is the last month of the record, not the wall clock.** Everything on
 * this site has to render identically on the server, in the browser and on
 * every future visit; a chart anchored to `Date.now()` would break SSR
 * hydration parity immediately and silently restate every number on the page
 * as the months went by.
 *
 * With no projection the edge is the end of that month. With one it is a year
 * further, so the forecast has somewhere to be drawn.
 */
function rightEdgeMonth(trend: Trend): number {
  return VOLUME_LAST + (trend === 'off' ? 1 : PROJECT_MONTHS);
}

/** A preset's window: the last `n` months, out to the trend-dependent edge. */
function spanRange(s: Span, trend: Trend): [number, number] {
  return [
    volumeMonthStart(Math.max(0, VOLUME_MONTHS - SPAN_MONTHS[s])),
    volumeMonthStart(rightEdgeMonth(trend)),
  ];
}

/** How far the zoom gesture may take the window — the record, plus the widest
 *  right margin any state asks for. */
const PAN_BOUNDS: readonly [number, number] = [
  VOLUME_RANGE[0],
  volumeMonthStart(VOLUME_LAST + PROJECT_MONTHS),
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
  const i = clampMonth(monthIndexAt(ms));
  return volumeMonthStart(i) < ms ? Math.min(VOLUME_LAST, i + 1) : i;
}

/** Into the record. */
function clampMonth(i: number): number {
  return Math.max(0, Math.min(VOLUME_LAST, i));
}

/** `[year, monthIndex]` of the record's first month. */
const VOLUME_EPOCH: readonly [number, number] = [1990, 0];

/** UTC, because the fixture's months are UTC months. The axis renders in the
 *  reader's local zone, so a band can sit a few hours off its label at the
 *  tightest zoom — the alternative is a band that moves with the reader. */
const MONTH_TZ = { timeZone: 'UTC' } as const;

/**
 * The bucketing the region cursor shades, and therefore what a click selects.
 *
 * `Sequence.calendar('month')`, not a duration: months are 28–31 days, so
 * there is no month *duration* to step by — `DurationUnit` stops at `d`, and
 * `'m'` there is **minutes**. Hoisted, because the container re-realizes the
 * sequence against the view whenever this value changes, and a fresh instance
 * every render would re-bucket on every pointer move.
 */
const MONTH_SEQUENCE = Sequence.calendar('month', MONTH_TZ);

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

/**
 * **The lookback: how many months before the selection the model is fitted
 * on.** Five years.
 *
 * This is a property of *this* chart, and it is the one number here that is
 * not derived from the data. ESnet's own chart uses some fixed lookback and we
 * do not know what it is — it was inferred from where the dashed line begins
 * in a screenshot, and inference from a screenshot is not measurement. So:
 * five years, stated plainly on the page as our choice, in one named constant
 * that is trivial to change if the real figure ever turns up.
 *
 * Five happens to be a good choice on its own merits for this data — it is
 * short enough to track the current regime (a fit ending July 2024 predicts
 * July 2026 to within 1%) and long enough not to chase noise.
 */
const LOOKBACK_YEARS = 5;
const LOOKBACK_MONTHS = LOOKBACK_YEARS * 12;

/** A fitted model of the total: `predict(i)` in bytes at month index `i`. */
interface Fit {
  readonly kind: 'linear' | 'exponential';
  readonly predict: (monthIndex: number) => number;
  /** Slope in the fitted space — bytes per month (linear) or log-bytes per
   *  month (exponential), which is what the caption turns into a growth rate. */
  readonly slope: number;
}

/**
 * Ordinary least squares over `[i0, i1]` — on the values for `linear`, on
 * their natural logarithms for `exponential`, which is the whole difference
 * between the two and the reason an exponential fit draws as a straight line
 * on a log axis.
 *
 * The window is the fixed lookback ending at the selected month, and nothing
 * else. Because it stops *at* the selection, everything drawn to the right of
 * the selection is genuinely out of sample — which is what lets the caption
 * score the projection against what actually happened.
 *
 * `null` below three points — two points fit any straight line exactly, which
 * is not a forecast, it is a ruler.
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
  // `required: false` because a model can leave the drawable range — a
  // declining linear fit crosses zero if extended far enough, and zero has no
  // position on a log axis. Absent is the truthful way to say "this model has
  // no value here"; a `NaN` coordinate would break the path instead.
  { name: 'fit', kind: 'number', required: false },
] as const;

/** One half of the model as a drawable series — `[from, to]` inclusive, a row
 *  per month. Used twice: once for the fitted stretch, once for the
 *  projection, so both halves come off the same `Fit` and cannot disagree. */
function modelLine(
  fit: Fit,
  from: number,
  to: number,
  scale: 'log' | 'linear',
): TimeSeries<typeof TREND_SCHEMA> {
  const rows: [number, number | null][] = [];
  for (let i = from; i <= to; i += 1) {
    const v = fit.predict(i);
    rows.push([
      volumeMonthStart(i),
      Number.isFinite(v) && (scale === 'linear' || v > 0) ? v : null,
    ]);
  }
  return TimeSeries.fromJSON({ name: 'trend', schema: TREND_SCHEMA, rows });
}

/** What the model learned, in words — computed from the fit, never estimated. */
function fitCaption(fit: Fit, endsAt: string, months: number): string {
  const on = `on the ${months} months to ${endsAt}`;
  if (fit.kind === 'exponential') {
    const yearly = Math.exp(fit.slope * 12) - 1;
    const doubling = Math.log(2) / fit.slope;
    const pace =
      doubling > 0
        ? `doubling every ${doubling.toFixed(0)} months`
        : `halving every ${(-doubling).toFixed(0)} months`;
    return `Fitted ${on}: ${signedPercent(yearly * 100)} a year, ${pace} — a straight line on a log axis.`;
  }
  return `Fitted ${on}: ${fit.slope >= 0 ? '+' : '−'}${formatBytes(Math.abs(fit.slope))} a month — a straight-line model, so it bends on a log axis.`;
}

/**
 * How the projection did — the sentence the fit/projection split exists to
 * make possible. The model saw nothing after the selected month, so its value
 * at the end of the record is a genuine out-of-sample prediction, and the
 * record says what actually happened.
 *
 * With the newest month selected there is nothing left to check it against,
 * so it reports the forecast instead.
 */
function backtest(fit: Fit, selectedMonth: number): string {
  const horizon = monthLabel(VOLUME_LAST + PROJECT_MONTHS);
  const ahead = fit.predict(VOLUME_LAST + PROJECT_MONTHS);
  if (selectedMonth >= VOLUME_LAST) {
    return Number.isFinite(ahead) && ahead > 0
      ? `Nothing past the record to check it against, so it is a forecast: ${formatBytes(ahead)} by ${horizon}.`
      : `Its projection leaves the drawable range — the wrong model for this data, which is the finding.`;
  }
  const predicted = fit.predict(VOLUME_LAST);
  const actual = volumeAt(VOLUME_LAST).total;
  if (!Number.isFinite(predicted) || predicted <= 0) {
    return `Its projection for ${monthLabel(VOLUME_LAST)} is not a positive number — the wrong model for this data, which is the finding.`;
  }
  const ratio = predicted / actual;
  const [factor, direction] =
    ratio >= 1 ? [ratio, 'over' as const] : [1 / ratio, 'under' as const];
  const miss =
    factor < 1.1
      ? `within ${precise((factor - 1) * 100)}%`
      : `${direction}shooting by ${precise(factor)}×`;
  return `It projected ${formatBytes(predicted)} for ${monthLabel(VOLUME_LAST)}; the actual was ${formatBytesExact(actual)} — ${miss}.`;
}

// ---------------------------------------------------------------------------
// Axis
// ---------------------------------------------------------------------------

/**
 * The y domain. `log` snaps to whole decades, which is what its gridlines are;
 * `linear` runs from zero, which is what makes the first two decades of the
 * record collapse onto the floor — the demonstration the toggle exists for.
 *
 * The **data** sets the bottom on both. The model is a layer, so an
 * auto-fitted domain would let a linear fit's negative values pick the floor
 * of a log axis; it may only widen the top.
 *
 * And only so far. A projection from an early selection can be wildly wrong —
 * fitted to the five years ending January 2010 the exponential projects
 * **19.3 EB** for July 2026 against an actual 197.82 PB, 97.7× over and two
 * decades above anything real. Letting that set the top would squash 36 years
 * of measurements into the bottom of the plot to make room for a line that is
 * *wrong*. So the model may lift the ceiling by at most one decade (log) or
 * half again (linear); past that it leaves the plot, which is the honest
 * rendering of a forecast that missed by more than the chart is tall.
 */
const PROJECTION_HEADROOM = { log: 10, linear: 1.5 } as const;

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
    const ceiling = hi * PROJECTION_HEADROOM[scale];
    for (let i = fitFrom; i <= rightEdge; i += 1) {
      const v = fit.predict(i);
      if (Number.isFinite(v) && v > hi) hi = Math.min(v, ceiling);
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

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB'];

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
 * Bytes for the **axis** — `10 GB`, `1 PB`, `198 PB`.
 *
 * Passed to `<YAxis format>` as a **function**: a d3 specifier would print
 * `197.8P`, which is not a byte count anyone writes. Single-argument on
 * purpose — the axis calls it as `fmt(value)`, and a second optional parameter
 * is one refactor away from being fed an array index. Hoisted to module scope
 * because an inline `format` function is a fresh reference each render and
 * would re-register the axis every frame.
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
 *  the build and the browser agree. Handles indexes past the end of the
 *  record, which the projection's horizon needs. */
function monthLabel(i: number): string {
  const ordinal = VOLUME_EPOCH[0] * 12 + VOLUME_EPOCH[1] + i;
  return `${MONTH_NAMES[ordinal % 12]} ${Math.floor(ordinal / 12)}`;
}
