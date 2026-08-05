import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart,
  CategoryAxis,
  ChartContainer,
  ChartRow,
  Layers,
  Region,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  SEA_WIND_BOUNDS,
  WIND_ANNUAL,
  WIND_ROW_EXTENT,
  WIND_ROW_TICKS,
  WIND_ROW_TICKS_CARD,
  WIND_SPAN_DAYS,
  WIND_WINDOW_CEILING_PCT,
  seattleWindHourly,
  windWindow,
} from './lib/weather-fixtures';
import styles from './gallery-wind-rose.module.css';

const DAY_MS = 86_400_000;
const YEAR_DAYS = (SEA_WIND_BOUNDS[1] - SEA_WIND_BOUNDS[0]) / DAY_MS;

/** How fast **Play** sweeps: one day of 2024 every 45 ms, so a pass across the
 *  year takes about 15 seconds and the return trip another 15. */
const PLAY_MS_PER_DAY = 45;

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * Wind direction, scrubbed: **one dataset drawn twice.**
 *
 * The top strip is the raw record — 8,735 hourly METAR observations of 2024,
 * each one a mark on the compass lane it blew from. The bars underneath are a
 * *count of the shaded window*, recomputed from the same series every time the
 * window moves. Nothing is precomputed per frame: the histogram is
 * `within(...).partitionBy('sector').toMap()`, which is why the two views can
 * never disagree.
 *
 * With a `phase` (the Gallery card's autoplay clock) the window sweeps the year
 * on its own and there are no controls — a drag would be overwritten on the
 * next frame. Without one it's the interactive version: **Play**, a position
 * slider, and the window itself is draggable on the strip (drag the band to
 * move it, an edge to change its length).
 */
export default function GalleryWindRose({
  width,
  phase,
}: {
  width: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const hourly = seattleWindHourly();
  const interactive = phase === undefined;

  const [spanDays, setSpanDays] = useState<number>(WIND_SPAN_DAYS.initial);
  const maxOffset = YEAR_DAYS - spanDays;
  const [offsetDays, setOffsetDays] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Autoplay position — out and back, so the window never jump-cuts from
  // December to January (`scanWindow`'s note; the seam is a whole year here).
  const swept =
    phase === undefined ? 0 : phase < 0.5 ? phase * 2 : (1 - phase) * 2;

  // The window, always **whole days** from 1 January. Day alignment is what
  // makes `WIND_WINDOW_CEILING_PCT` a guarantee rather than a hope: it's the
  // tallest bar over every day-aligned window the controls can produce, so a
  // bar can't run off the top of the plot.
  const offset = clamp(
    Math.round(interactive ? offsetDays : swept * maxOffset),
    0,
    maxOffset,
  );
  const from = SEA_WIND_BOUNDS[0] + offset * DAY_MS;
  const to = from + spanDays * DAY_MS;

  const counted = useMemo(() => windWindow(from, to), [from, to]);

  // The `<CategoryAxis>` labels the bands from the **data**, and it thins names
  // that would collide off an estimated glyph width. On the card that estimate
  // sits right on the boundary and keeps all sixteen, which at 344 px reads as
  // one long word — so the card blanks every other label itself rather than
  // hoping the estimate lands the other way. The page has room for all of them.
  const bars = useMemo(
    () =>
      interactive
        ? counted.bars
        : counted.bars.map((bar, i) => ({
            ...bar,
            label: i % 2 === 0 ? bar.label : '',
          })),
    [counted, interactive],
  );

  // Play advances a float so motion is smooth, but only re-renders when the
  // rounded day changes — a day is under two pixels at this width, and
  // recounting the window sixty times a second to draw the same bars is waste.
  const positionRef = useRef(0);
  const directionRef = useRef(1);
  useEffect(() => {
    if (!playing) return;
    positionRef.current = clamp(positionRef.current, 0, maxOffset);
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      positionRef.current +=
        ((now - last) * directionRef.current) / PLAY_MS_PER_DAY;
      last = now;
      if (positionRef.current >= maxOffset) {
        positionRef.current = maxOffset;
        directionRef.current = -1;
      } else if (positionRef.current <= 0) {
        positionRef.current = 0;
        directionRef.current = 1;
      }
      const day = Math.round(positionRef.current);
      setOffsetDays((prev) => (prev === day ? prev : day));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, maxOffset]);

  /**
   * Move the window by hand — from the slider, or from dragging the band or
   * one of its edges. The policy lives here and nowhere else: snap to whole
   * days, clamp the length, keep it inside 2024, and stop any sweep in
   * progress rather than let the two fight over the same state.
   */
  const place = (nextOffset: number, nextSpan: number) => {
    const span = clamp(
      Math.round(nextSpan),
      WIND_SPAN_DAYS.min,
      WIND_SPAN_DAYS.max,
    );
    const start = clamp(Math.round(nextOffset), 0, YEAR_DAYS - span);
    setPlaying(false);
    setSpanDays(span);
    setOffsetDays(start);
    positionRef.current = start;
  };

  const strip = (
    <ChartContainer
      range={SEA_WIND_BOUNDS}
      width={width}
      theme={theme}
      // Edit mode is what makes the band grabbable; it also suppresses the
      // data cursor, which this strip has no use for — 8,735 marks at 16
      // discrete heights have no value to read out that the axis doesn't
      // already name.
      editAnnotations={interactive}
    >
      <ChartRow height={interactive ? 172 : 76}>
        <YAxis
          id="dir"
          side="left"
          label="blowing from"
          width={46}
          min={WIND_ROW_EXTENT[0]}
          max={WIND_ROW_EXTENT[1]}
          // Explicit ticks drive the labels *and* the gridlines together: on
          // the page every one of the sixteen lanes gets a line and every
          // other one a name; the card gets the four cardinals and no more,
          // because eight names in 76 pixels is a smear.
          ticks={interactive ? WIND_ROW_TICKS : WIND_ROW_TICKS_CARD}
        />
        <Layers>
          {/* `raw` is the site theme's cloud role — small, part-transparent,
              no outline. At 8,735 marks the density is the message. */}
          <ScatterChart
            series={hourly}
            column="row"
            axis="dir"
            as="raw"
            legend={false}
          />
          <Region
            from={from}
            to={to}
            label={false}
            selectable={interactive}
            // `onChange` is what makes it editable: drag the body to move it,
            // an edge to resize. Both arrive here as a new `{ from, to }`,
            // which we snap back to whole days and clamp to 2024.
            onChange={
              interactive
                ? (next) =>
                    place(
                      (next.from - SEA_WIND_BOUNDS[0]) / DAY_MS,
                      (next.to - next.from) / DAY_MS,
                    )
                : undefined
            }
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );

  const histogram = (
    <ChartContainer
      width={width}
      theme={theme}
      showAxis={false}
      // On an **ordinal** axis the crosshair degrades to a vertical line plus
      // the hovered category's name, pinned over its own axis label: there is
      // no continuous x to read back, so no horizontal arm and no value pill.
      cursor="crosshair"
    >
      <ChartRow height={interactive ? 196 : 100}>
        <YAxis
          id="pct"
          side="left"
          label="% of window"
          format=",.0f"
          width={46}
          min={0}
          max={WIND_WINDOW_CEILING_PCT}
        />
        <Layers>
          <BarChart
            categories={bars}
            axis="pct"
            gap={interactive ? 6 : 2}
            id="rose"
          />
        </Layers>
      </ChartRow>
      <CategoryAxis />
    </ChartContainer>
  );

  if (!interactive) {
    return (
      <div style={{ width }}>
        {strip}
        {histogram}
      </div>
    );
  }

  return (
    <div style={{ width }}>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.play}
          onClick={() => setPlaying((on) => !on)}
        >
          {playing ? '❙❙ Pause' : '▶ Play'}
        </button>
        <input
          className={styles.slider}
          type="range"
          min={0}
          max={maxOffset}
          step={1}
          value={offset}
          aria-label="Window start day"
          onChange={(e) => place(Number(e.target.value), spanDays)}
        />
        <span className={styles.span}>
          {spanDays}-day window — drag it on the strip to move it, an edge to
          resize ({WIND_SPAN_DAYS.min}–{WIND_SPAN_DAYS.max} days)
        </span>
      </div>
      {strip}
      <div className={styles.readout}>
        <span className={styles.dates}>
          {dayFormat.format(from)} – {dayFormat.format(to - DAY_MS)}
        </span>
        <span className={styles.field}>
          <span className={styles.name}>hours</span>
          {counted.hours}
        </span>
        <span className={styles.field}>
          <span className={styles.name}>northerly</span>
          {counted.northerly.toFixed(1)}%{' '}
          <span className={styles.year}>
            (year {WIND_ANNUAL.northerly.toFixed(1)}%)
          </span>
        </span>
        <span className={styles.field}>
          <span className={styles.name}>southerly</span>
          {counted.southerly.toFixed(1)}%{' '}
          <span className={styles.year}>
            (year {WIND_ANNUAL.southerly.toFixed(1)}%)
          </span>
        </span>
        <span className={styles.field}>
          <span className={styles.name}>calm + variable</span>
          {(counted.calm + counted.variable).toFixed(1)}%
        </span>
      </div>
      {histogram}
    </div>
  );
}
