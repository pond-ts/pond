import { BoundedSequence } from './bounded-sequence.js';
import {
  type CalendarOptions,
  type CalendarUnit,
  type WeekStartsOn,
  normalizeWeekStartsOn,
  nextCalendarStart,
  plainDateToStart,
  resolveTimeZone,
  toPlainDateStart,
} from '../core/calendar.js';
import { parseDuration } from '../core/duration.js';
import type { DurationInput } from '../core/duration.js';
import { Interval } from '../core/interval.js';
import { toTimeRange } from '../core/time-range.js';
import type { TemporalLike, TimestampInput } from '../core/temporal.js';
import { normalizeTimestamp } from '../core/temporal.js';

export type { DurationInput };
export type SequenceSample = 'begin' | 'center' | 'end';

type FixedSequenceInput = {
  every: DurationInput;
  anchor?: TimestampInput;
};

type CalendarSequenceInput = {
  unit: CalendarUnit;
  timeZone: string;
  weekStartsOn?: WeekStartsOn;
};

/**
 * An unbounded fixed-step grid definition used for alignment or aggregation.
 *
 * `Sequence` defines where buckets fall. Call `bounded(...)` to realize a finite `BoundedSequence`
 * over a specific range.
 *
 * Important distinction:
 * - the sequence `anchor` defines where the unbounded grid starts
 * - the caller-supplied `range` defines which finite slice is realized
 *
 * The default anchor is Unix epoch `0`.
 */
export class Sequence {
  readonly #kind: 'fixed' | 'calendar';
  readonly #stepMs?: number;
  readonly #anchorMs?: number;
  readonly #calendarUnit?: CalendarUnit;
  readonly #timeZone?: string;
  readonly #weekStartsOn?: 1 | 2 | 3 | 4 | 5 | 6 | 7;

  constructor(input: FixedSequenceInput | CalendarSequenceInput) {
    if ('every' in input) {
      this.#kind = 'fixed';
      this.#stepMs = parseDuration(input.every);
      this.#anchorMs = normalizeTimestamp(input.anchor ?? 0, 'anchor');
    } else {
      this.#kind = 'calendar';
      this.#calendarUnit = input.unit;
      this.#timeZone = input.timeZone;
      this.#weekStartsOn = normalizeWeekStartsOn(input.weekStartsOn);
    }
    Object.freeze(this);
  }

  /**
   * Creates an unbounded fixed-step sequence.
   *
   * The returned sequence is a grid definition, not a finite bucket list. By default the grid is
   * anchored at Unix epoch `0`, which makes independently-created sequences line up by default.
   * Use `bounded(...)` or series operations like `align(...)` / `aggregate(...)` to realize a
   * finite slice of the grid over a concrete range.
   */
  static every(
    every: DurationInput,
    options: { anchor?: TimestampInput } = {},
  ): Sequence {
    return options.anchor === undefined
      ? new Sequence({ every })
      : new Sequence({ every, anchor: options.anchor });
  }

  /** Example: `Sequence.hourly()`. Creates an hourly fixed-step sequence. */
  static hourly(options: { anchor?: TimestampInput } = {}): Sequence {
    return Sequence.every('1h', options);
  }

  /** Example: `Sequence.daily()`. Creates a daily fixed-step sequence. */
  static daily(options: { anchor?: TimestampInput } = {}): Sequence {
    return Sequence.every('1d', options);
  }

  /**
   * Creates an unbounded calendar-aware sequence.
   *
   * Calendar sequences step by local calendar boundaries in an IANA time zone instead of by a
   * fixed millisecond duration. Supported units are `"day"`, `"week"`, and `"month"`.
   *
   * Defaults:
   * - `timeZone`: `"UTC"`
   */
  static calendar(unit: CalendarUnit, options: CalendarOptions = {}): Sequence {
    const timeZone = resolveTimeZone(options);
    return options.weekStartsOn === undefined
      ? new Sequence({ unit, timeZone })
      : new Sequence({ unit, timeZone, weekStartsOn: options.weekStartsOn });
  }

  /** Example: `sequence.kind()`. Returns whether this sequence is fixed-step or calendar-aware. */
  kind(): 'fixed' | 'calendar' {
    return this.#kind;
  }

  /** Example: `sequence.anchor()`. Returns the millisecond anchor used by this grid definition. */
  anchor(): number {
    if (this.#kind !== 'fixed') {
      throw new TypeError(
        'calendar sequences do not have a fixed millisecond anchor',
      );
    }
    return this.#anchorMs!;
  }

  /** Example: `sequence.stepMs()`. Returns the fixed interval size in milliseconds. */
  stepMs(): number {
    if (this.#kind !== 'fixed') {
      throw new TypeError(
        'calendar sequences do not have a fixed millisecond step size',
      );
    }
    return this.#stepMs!;
  }

  /** Example: `sequence.timeZone()`. Returns the IANA time zone for calendar-aware sequences, if any. */
  timeZone(): string | undefined {
    return this.#timeZone;
  }

  /**
   * Example: `sequence.bounded(new TimeRange({ start, end }))`.
   * Realizes a finite `BoundedSequence` over the supplied range.
   *
   * Sample position controls which intervals are selected:
   *
   * - `'begin'` (default) — sample point is the interval's start.
   *   Includes buckets where `sample ∈ [range.begin, range.end]`.
   * - `'center'` — sample point is the interval's midpoint.
   *   Same inclusive range as `'begin'`.
   * - `'end'` — sample point is the interval's exclusive end (i.e.
   *   the start of the next bucket). Inclusion is **left-exclusive**:
   *   `sample ∈ (range.begin, range.end]`. This keeps the boundary
   *   case symmetric — an end-sample at exactly `range.begin()` would
   *   otherwise pull in an interval whose extent sits entirely before
   *   the range.
   */
  bounded(
    range: TemporalLike,
    options: { sample?: SequenceSample } = {},
  ): BoundedSequence {
    const sample = options.sample ?? 'begin';
    const requested = toTimeRange(range);
    const intervals: Interval[] = [];

    if (this.#kind === 'fixed') {
      const stepMs = this.#stepMs!;
      const anchorMs = this.#anchorMs!;
      // sampleOffset shifts the sample point relative to interval.begin()
      // so the inclusion test is "is the sample point inside the requested
      // range?" For 'begin' the sample is the start; for 'center' it's the
      // midpoint; for 'end' it's the exclusive interval boundary.
      //
      // 'begin' and 'center' use an inclusive range — sample ∈ [begin, end].
      // 'end' uses left-exclusive — sample ∈ (begin, end] — to keep the
      // boundary case symmetric: begin-sampling at range.end() and
      // end-sampling at range.begin() would otherwise BOTH include
      // intervals whose extent sits entirely outside the range.
      const sampleOffset =
        sample === 'center' ? stepMs / 2 : sample === 'end' ? stepMs : 0;
      const firstIndex =
        sample === 'end'
          ? Math.floor((requested.begin() - sampleOffset - anchorMs) / stepMs) +
            1
          : Math.ceil((requested.begin() - sampleOffset - anchorMs) / stepMs);
      const lastIndex = Math.floor(
        (requested.end() - sampleOffset - anchorMs) / stepMs,
      );

      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const start = anchorMs + index * stepMs;
        intervals.push(
          new Interval({ value: start, start, end: start + stepMs }),
        );
      }

      return new BoundedSequence(intervals);
    }

    const timeZone = this.#timeZone!;
    const unit = this.#calendarUnit!;
    const weekStartsOn = this.#weekStartsOn!;
    let currentDate = toPlainDateStart(
      requested.begin(),
      timeZone,
      unit,
      weekStartsOn,
    );

    while (true) {
      const currentStart = plainDateToStart(currentDate, timeZone);
      const nextDate = nextCalendarStart(currentDate, unit);
      const nextStart = plainDateToStart(nextDate, timeZone);
      const start = currentStart.epochMilliseconds;
      const end = nextStart.epochMilliseconds;
      const sampleTime =
        sample === 'end'
          ? end
          : sample === 'center'
            ? start + (end - start) / 2
            : start;

      if (sampleTime > requested.end()) {
        break;
      }

      // 'begin' and 'center': sample ∈ [requested.begin, requested.end]
      // 'end':                 sample ∈ (requested.begin, requested.end]
      const include =
        sample === 'end'
          ? sampleTime > requested.begin()
          : sampleTime >= requested.begin();

      if (include) {
        intervals.push(new Interval({ value: start, start, end }));
      }

      currentDate = nextDate;
    }

    return new BoundedSequence(intervals);
  }
}
