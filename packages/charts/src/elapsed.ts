/**
 * The **elapsed (duration) x axis** — the shared x scale relabelled as *offsets
 * from an origin*, so an axis reads `00:00 00:05 00:10` (time since the start of
 * the series) instead of `10:35 10:40 10:45` (wall clock), and a value axis
 * reads distance-from-the-start instead of absolute distance.
 *
 * Two things change, and only these two: **where the ticks sit** and **what they
 * say**. The pixel mapping is untouched, and so are the data coordinates — a
 * mark's `at`, the container's `range`, an `onRegionSelect` span are all still
 * absolute axis units. Relabeling only.
 *
 * Where the ticks sit is the part that can't be done with `<XAxis transform>`:
 * an elapsed axis wants ticks at **round durations measured from the origin**
 * (a run starting at 10:33:17 ticks at 10:33:17, 10:38:17, … so its labels read
 * `00:00 00:05`), not at the wall-clock boundaries a calendar ladder picks. So
 * the walk here is `origin + k·step` with `step` off a **duration ladder**
 * (…15s, 30s, 1m, 2m, 5m… — not the 1-2-5 ladder, which would offer a
 * 200-second tick). A value axis runs the identical walk on the plain 1-2-5
 * ladder.
 *
 * Pure — no DOM, no React; {@link scaleElapsed} wraps a base scale with these
 * ticks + labels and the container hands the result out as its `xScale`, so
 * every consumer (axis labels, gridlines, cursor pill, marker indicators) reads
 * the elapsed axis without knowing it exists.
 */

import { scaleLinear } from 'd3-scale';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The duration tick ladder in ms — the steps a *clock* subdivides by, which is
 * not the 1-2-5 ladder: 15s and 30s are round durations where 20s and 50s are
 * not, and an hour divides by 2/3/6/12 rather than by 2/5. Steps coarser than a
 * day fall back to 1-2-5 whole days (see {@link durationStep}).
 */
const DURATION_STEPS: readonly number[] = [
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  200,
  500,
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
];

/** The smallest 1-2-5 nice step ≥ `target` (the value-axis ladder). */
export function niceStep(target: number): number {
  if (!(target > 0) || !Number.isFinite(target)) return 1;
  const pow = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5]) {
    if (m * pow >= target) return m * pow;
  }
  return 10 * pow;
}

/**
 * The tick step for a **duration** axis: the smallest ladder step that keeps the
 * tick total at or under `count` across `span` ms. Past a day the ladder runs
 * out and 1-2-5 whole days take over (2d, 5d, 10d, 20d, …) — calendar months
 * are deliberately not a rung, since an elapsed axis measures duration, and
 * "1 month later" is not a duration.
 */
export function durationStep(span: number, count: number): number {
  const target = span / Math.max(1, count);
  if (!(target > 0) || !Number.isFinite(target)) return 1;
  for (const step of DURATION_STEPS) {
    if (step >= target) return step;
  }
  return niceStep(target / DAY) * DAY;
}

/** Backstop against a pathological (step, domain) pair flooding the axis; the
 *  step is derived from the domain span, so a real axis never comes close. */
const MAX_TICKS = 10_000;

/** Closest two ticks may sit in pixels before the second is dropped as a
 *  duplicate. Only ever fires where a discontinuous base scale collapses a span
 *  to a point — a continuous axis spaces its ticks tens of px apart. */
const MIN_TICK_PX = 1;

/**
 * Tick values in **absolute axis units** at `origin + k·step`, covering
 * `domain` — the anchored walk that makes `00:05` land exactly five minutes
 * after the origin rather than on the nearest clock boundary. `k` runs negative
 * where the domain reaches back before the origin (a T-minus axis), so the walk
 * is origin-anchored, not domain-anchored. Ascending; `[]` for a degenerate
 * domain or step.
 */
export function originTicks(
  domain: readonly [number, number],
  origin: number,
  step: number,
): number[] {
  const lo = Math.min(domain[0], domain[1]);
  const hi = Math.max(domain[0], domain[1]);
  if (
    !Number.isFinite(lo) ||
    !Number.isFinite(hi) ||
    !Number.isFinite(origin) ||
    !(step > 0) ||
    hi < lo
  ) {
    return [];
  }
  // ±1e-9 relative slack so a tick sitting exactly on a domain edge (the very
  // common `origin === lo` case — the `00:00` tick) is not lost to float drift.
  const eps = 1e-9 * Math.max(1, Math.abs(hi - lo) / step);
  const k0 = Math.ceil((lo - origin) / step - eps);
  const k1 = Math.floor((hi - origin) / step + eps);
  if (k1 < k0 || k1 - k0 > MAX_TICKS) return [];
  const out: number[] = [];
  for (let k = k0; k <= k1; k++) out.push(origin + k * step);
  return out;
}

/**
 * Which components a duration label shows. Resolved once from the tick step and
 * the axis's magnitude ({@link durationShape}) so every label on one axis has
 * the same shape — and so the cursor readout can add seconds to the *same*
 * shape rather than picking its own (a `00:05` axis must not read `05:12` under
 * the pointer).
 */
export interface DurationShape {
  /** Prefix a `Nd ` day part (only rendered when the day count is non-zero). */
  readonly days: boolean;
  /** Head the clock with hours (`HH:MM`) rather than minutes (`MM:SS`). */
  readonly hours: boolean;
  readonly seconds: boolean;
  readonly millis: boolean;
  /** Whole days only (`0d 1d 2d`) — a day-or-coarser step has no clock to show. */
  readonly dayGrain: boolean;
}

/**
 * Pick the label shape for a duration axis from its tick `step` (which sets the
 * *finest* component shown — a 5-minute step has no business printing seconds)
 * and `maxAbs`, the largest offset the axis reaches (which sets the *coarsest*).
 *
 * The one non-obvious rung: an axis whose step is a minute or coarser heads its
 * clock with **hours even when they're zero** (`00:05` = five minutes in),
 * because that is what the wall-clock axis it replaces looked like. Only an axis
 * fine enough to show seconds drops to `MM:SS`.
 */
export function durationShape(step: number, maxAbs: number): DurationShape {
  const seconds = step < MINUTE;
  return {
    dayGrain: step >= DAY,
    days: maxAbs >= DAY,
    hours: maxAbs >= HOUR || !seconds,
    seconds,
    millis: step < SECOND,
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * Render an elapsed `ms` in the given {@link DurationShape}: `00:05`, `12:30`,
 * `01:15:30`, `2d 06:00`, `0d`, `-00:05`. Negative offsets (a domain reaching
 * back before the origin — the T-minus case) carry a leading `-`.
 *
 * Truncates rather than rounds, so a label reads like a clock: 59.7s at second
 * grain is `00:59`, not `01:00`. Hours accumulate past 24 when the shape has no
 * day part, so an off-axis readout can't silently wrap.
 */
export function formatDuration(ms: number, shape: DurationShape): string {
  if (!Number.isFinite(ms)) return '';
  const sign = ms < 0 ? '-' : '';
  let rest = Math.floor(Math.abs(ms));
  const dayPart = Math.floor(rest / DAY);
  if (shape.dayGrain) return `${sign}${dayPart}d`;
  if (shape.days) rest -= dayPart * DAY;
  const hours = Math.floor(rest / HOUR);
  rest -= hours * HOUR;
  const mins = Math.floor(rest / MINUTE);
  rest -= mins * MINUTE;
  const secs = Math.floor(rest / SECOND);
  rest -= secs * SECOND;
  // The day part shows only when there is one — an axis's first day reads
  // `06:00`, its second `1d 06:00`, exactly as the flat date style promotes a
  // tick that opens a coarser period.
  const prefix = shape.days && dayPart > 0 ? `${dayPart}d ` : '';
  const clock = shape.hours
    ? `${pad(hours)}:${pad(mins)}${shape.seconds ? `:${pad(secs)}` : ''}`
    : `${pad(mins)}:${pad(secs)}`;
  const frac = shape.millis ? `.${pad(rest, 3)}` : '';
  return `${sign}${prefix}${clock}${frac}`;
}

/**
 * The x scale a container in elapsed mode hands out — the base scale's pixel
 * mapping (`invert`, `domain`, `range` all pass straight through) with
 * origin-anchored {@link originTicks} and offset labels layered on. Deliberately
 * *not* a {@link TradingTimeScale}: it exposes no `tickBoundaries` / `bands` /
 * `gridLevels`, which is exactly how `<XAxis>` knows to skip the calendar date
 * styles and how `Layers` knows to draw its gridlines at the labelled (elapsed)
 * ticks instead of the calendar grain populations.
 */
export interface ElapsedScale {
  (value: number): number;
  invert(pixel: number): number;
  ticks(count?: number): number[];
  /**
   * The label formatter. With no `specifier` this is the **offset** formatter —
   * a duration on a time axis, the d3 default over the offset domain on a value
   * axis. With one, see {@link ElapsedOptions.absolute}.
   */
  tickFormat(
    count?: number,
    specifier?: string,
  ): (value: number | Date) => string;
  domain(): [number, number];
  range(): [number, number];
  /** The zero point, in absolute axis units. */
  readonly origin: number;
  /** A formatter one grain finer than the tick labels (seconds always shown on a
   *  time axis), for the cursor pill / marker indicators — the same
   *  precise-readout-over-terse-ticks split the calendar axis makes. */
  readoutFormat(count?: number): (value: number) => string;
}

/** The slice of the base scale {@link scaleElapsed} wraps — d3's `ScaleLinear`
 *  and a `TradingTimeScale` both satisfy it. */
interface ElapsedBase {
  (value: number): number;
  invert(pixel: number): number;
  domain(): number[];
  range(): number[];
}

export interface ElapsedOptions {
  /** The zero point in absolute axis units — what `00:00` (or `0`) means. */
  readonly origin: number;
  readonly kind: 'time' | 'value';
  /**
   * Formatter for an explicit d3 **specifier** on a *time* axis, in absolute
   * units (the container passes its wall-clock scale's `tickFormat`). A d3 time
   * specifier can only describe an instant — `%H:%M` of a duration is not a
   * thing — so an explicit format on an elapsed time axis labels the underlying
   * wall clock. That's the lever for pairing a wall-clock strip with a duration
   * strip on the same ticks. A **value** axis needs none: a number specifier
   * describes the offset perfectly well, so it formats the offset.
   */
  absolute?(count: number, specifier: string): (value: number) => string;
}

/** Default tick target when a caller passes none (d3's convention). */
const DEFAULT_COUNT = 10;

/**
 * Wrap `base` as an {@link ElapsedScale}: same pixels, ticks anchored at
 * `origin`, labels in offsets.
 */
export function scaleElapsed(
  base: ElapsedBase,
  options: ElapsedOptions,
): ElapsedScale {
  const { origin, kind, absolute } = options;
  const bounds = (): [number, number] => {
    const d = base.domain();
    return [Number(d[0] ?? 0), Number(d[1] ?? 0)];
  };
  const stepFor = (count: number): number => {
    const [lo, hi] = bounds();
    const span = Math.abs(hi - lo);
    return kind === 'time'
      ? durationStep(span, count)
      : niceStep(span / Math.max(1, count));
  };
  const shapeFor = (count: number): DurationShape => {
    const [lo, hi] = bounds();
    const maxAbs = Math.max(Math.abs(lo - origin), Math.abs(hi - origin));
    return durationShape(stepFor(count), maxAbs);
  };
  /** The value-axis offset formatter — resolved against a scale over the
   *  *offset* domain, so d3 picks its precision from the numbers on show. */
  const offsetFormat = (
    count: number,
    specifier?: string,
  ): ((value: number) => string) => {
    const [lo, hi] = bounds();
    const s = scaleLinear().domain([lo - origin, hi - origin]);
    const f =
      specifier !== undefined
        ? s.tickFormat(count, specifier)
        : s.tickFormat(count);
    return (v) => f(v - origin);
  };

  /**
   * Drop ticks that land on a pixel another tick already claimed. The walk is in
   * **wall-clock** ms, but the base scale need not be continuous: on a trading
   * axis every instant inside a collapsed session maps to the one seam pixel, so
   * a duration ladder striding through a closed market emits several ticks at
   * the *same* x — labels stacked on labels, gridlines stroked on gridlines
   * (issue #540, finding 1). A plain axis is untouched: its ticks are ~65px
   * apart by construction, so nothing is ever within the gap.
   *
   * The survivor is the **last** tick of each pixel group, not the first. Ticks
   * ascend, so a group spans a collapsed gap and ends at the first instant the
   * axis actually draws — the session open. Keeping the first would label the
   * seam with a moment the market was shut: on three 09:30–16:00 sessions the
   * pixel would read `12:00` (21:30 that night) instead of `1d 00:00`, the
   * Tuesday open that genuinely sits there (PR #541 review).
   */
  const dedupeByPixel = (values: readonly number[]): number[] => {
    const r = base.range();
    // Pre-layout the whole range is one pixel wide; nothing is visible, and
    // deduping there would collapse the axis to a single tick.
    if (!(Math.abs(Number(r[1] ?? 0) - Number(r[0] ?? 0)) > 0))
      return [...values];
    const out: number[] = [];
    let lastPx = 0;
    for (const v of values) {
      const px = base(v);
      if (!Number.isFinite(px)) continue;
      if (out.length > 0 && Math.abs(px - lastPx) < MIN_TICK_PX) {
        out[out.length - 1] = v; // same pixel — the later instant wins
        lastPx = px;
        continue;
      }
      out.push(v);
      lastPx = px;
    }
    return out;
  };

  const scale = ((value: number) => base(value)) as {
    (value: number): number;
  } & Record<string, unknown>;

  Object.assign(scale, {
    origin,
    invert: (pixel: number) => Number(base.invert(pixel)),
    domain: () => bounds(),
    range: (): [number, number] => {
      const r = base.range();
      return [Number(r[0] ?? 0), Number(r[1] ?? 0)];
    },
    ticks: (count = DEFAULT_COUNT) =>
      dedupeByPixel(originTicks(bounds(), origin, stepFor(count))),
    tickFormat: (count = DEFAULT_COUNT, specifier?: string) => {
      if (kind === 'value') return offsetFormat(count, specifier);
      if (specifier !== undefined && absolute !== undefined) {
        return absolute(count, specifier);
      }
      const shape = shapeFor(count);
      return (value: number | Date) => formatDuration(+value - origin, shape);
    },
    readoutFormat: (count = DEFAULT_COUNT) => {
      if (kind === 'value') return offsetFormat(count);
      // Seconds on top of the ticks' own shape — never a *different* shape, so
      // a `00:05` axis reads `00:05:12` under the pointer, not `05:12`.
      const shape = { ...shapeFor(count), seconds: true, dayGrain: false };
      return (value: number) => formatDuration(value - origin, shape);
    },
  });

  return scale as unknown as ElapsedScale;
}
