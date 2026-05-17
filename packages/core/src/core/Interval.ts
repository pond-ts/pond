import {
  calendarRangeForReference,
  dayRangeForDate,
  type CalendarOptions,
  type CalendarUnit,
  type TimeZoneOptions,
} from '../calendar.js';
import { TimeRange } from './TimeRange.js';
import type {
  EventKey,
  IntervalInput,
  IntervalValue,
  TemporalLike,
  TimestampInput,
} from '../temporal.js';
import {
  compareEventKeys,
  compareIntervalValues,
  normalizeTimestamp,
} from '../temporal.js';

type IntervalObjectInput = {
  value: IntervalValue;
  start: TimestampInput;
  end: TimestampInput;
};

/** A labeled time interval event key. Example: `new Interval({ value: "bucket", start, end })`. */
export class Interval implements EventKey {
  readonly kind = 'interval';
  readonly value: IntervalValue;
  readonly start: number;
  readonly endMs: number;

  /** Example: `Interval.fromDate("2025-01-01", { timeZone: "UTC" })`. Creates a labeled local-day interval using the ISO date string as the default label. */
  static fromDate(
    reference: string,
    options: TimeZoneOptions & { value?: IntervalValue } = {},
  ): Interval {
    const range = dayRangeForDate(reference, options);
    return new Interval({
      value: options.value ?? reference,
      start: range.start,
      end: range.end,
    });
  }

  /** Example: `Interval.fromCalendar("month", "2025-01", { timeZone: "America/New_York", value: "2025-01" })`. Creates a labeled calendar interval for the supplied reference. */
  static fromCalendar(
    unit: CalendarUnit,
    reference: string,
    options: CalendarOptions & { value?: IntervalValue } = {},
  ): Interval {
    const range = calendarRangeForReference(unit, reference, options);
    return new Interval({
      value: options.value ?? reference,
      start: range.start,
      end: range.end,
    });
  }

  /** Example: `new Interval(["bucket", start, end])`. Creates a labeled interval key from a `{ value, start, end }` object or tuple. */
  constructor(input: IntervalInput) {
    let value: IntervalValue;
    let rawStart: TimestampInput;
    let rawEnd: TimestampInput;
    if (Array.isArray(input)) {
      value = input[0];
      rawStart = input[1];
      rawEnd = input[2];
    } else {
      const objectInput = input as IntervalObjectInput;
      value = objectInput.value;
      rawStart = objectInput.start;
      rawEnd = objectInput.end;
    }
    const start = normalizeTimestamp(rawStart, 'interval start');
    const end = normalizeTimestamp(rawEnd, 'interval end');
    if (start > end) {
      throw new TypeError('interval start must be <= end');
    }
    this.value = value;
    this.start = start;
    this.endMs = end;
    Object.freeze(this);
  }

  /** Example: `interval.type() // "interval"`. Returns the key kind. */
  type(): 'interval' {
    return this.kind;
  }

  /** Example: `interval.begin()`. Returns the inclusive start of the interval in milliseconds since epoch. */
  begin(): number {
    return this.start;
  }

  /** Example: `interval.end()`. Returns the inclusive end of the interval in milliseconds since epoch. */
  end(): number {
    return this.endMs;
  }

  /** Example: `interval.valueOf()`. Returns the interval label. */
  valueOf(): IntervalValue {
    return this.value;
  }

  /** Example: `interval.asString()`. Returns the interval label as a string. */
  asString(): string {
    return String(this.value);
  }

  /** Example: `interval.timeRange()`. Returns the interval extent as a `TimeRange`. */
  timeRange(): TimeRange {
    return new TimeRange({ start: this.start, end: this.endMs });
  }

  /** Example: `interval.duration()`. Returns the temporal duration of the interval in milliseconds. */
  duration(): number {
    return this.endMs - this.start;
  }

  /** Example: `interval.overlaps(range)`. Returns `true` when this interval overlaps the supplied temporal value. */
  overlaps(other: TemporalLike): boolean {
    return this.timeRange().overlaps(other);
  }

  /** Example: `interval.contains(range)`. Returns `true` when this interval fully contains the supplied temporal value. */
  contains(other: TemporalLike): boolean {
    return this.timeRange().contains(other);
  }

  /** Example: `interval.isBefore(range)`. Returns `true` when this interval ends strictly before the supplied temporal value begins. */
  isBefore(other: TemporalLike): boolean {
    return this.timeRange().isBefore(other);
  }

  /** Example: `interval.isAfter(range)`. Returns `true` when this interval begins strictly after the supplied temporal value ends. */
  isAfter(other: TemporalLike): boolean {
    return this.timeRange().isAfter(other);
  }

  /** Example: `interval.intersection(range)`. Returns the temporal intersection with the supplied value, if any. */
  intersection(other: TemporalLike): TimeRange | undefined {
    return this.timeRange().intersection(other);
  }

  /** Example: `interval.trim(range)`. Returns this interval clipped to the supplied temporal value, preserving its label when overlapping. */
  trim(other: TemporalLike): Interval | undefined {
    const range = this.intersection(other);
    if (!range) {
      return undefined;
    }
    return new Interval({
      value: this.value,
      start: range.begin(),
      end: range.end(),
    });
  }

  /** Example: `interval.equals(otherInterval)`. Returns `true` when the supplied key has the same label and temporal extent. */
  equals(other: EventKey): boolean {
    return (
      other instanceof Interval &&
      this.start === other.start &&
      this.endMs === other.endMs &&
      this.value === other.value
    );
  }

  /** Example: `interval.compare(otherInterval)`. Compares this key to another key for ordering. */
  compare(other: EventKey): number {
    const base = compareEventKeys(this, other);
    if (base !== 0 || !(other instanceof Interval)) {
      return base;
    }
    return compareIntervalValues(this.value, other.value);
  }
}
