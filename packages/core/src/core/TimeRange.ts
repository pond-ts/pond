import {
  calendarRangeForReference,
  dayRangeForDate,
  type CalendarOptions,
  type CalendarUnit,
  type TimeZoneOptions,
} from '../calendar.js';
import type {
  IntervalInput,
  TemporalLike,
  TimeRangeInput,
  TimestampInput,
} from '../temporal.js';
import { compareEventKeys, normalizeTimestamp } from '../temporal.js';
import type { EventKey } from '../temporal.js';

type TimeRangeObjectInput = { start: TimestampInput; end: TimestampInput };

function isBoundedTemporal(
  value: unknown,
): value is { begin(): number; end(): number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'begin' in value &&
    'end' in value
  );
}

function isRangedTemporal(value: unknown): value is { timeRange(): TimeRange } {
  return typeof value === 'object' && value !== null && 'timeRange' in value;
}

export function toTimeRange(value: TemporalLike): TimeRange {
  if (value instanceof TimeRange) {
    return value;
  }
  if (isRangedTemporal(value)) {
    return value.timeRange();
  }
  if (isBoundedTemporal(value)) {
    return new TimeRange({ start: value.begin(), end: value.end() });
  }
  if (value instanceof Date || typeof value === 'number') {
    const timestamp = normalizeTimestamp(value, 'time');
    return new TimeRange({ start: timestamp, end: timestamp });
  }
  if (Array.isArray(value)) {
    if (value.length === 2) {
      return new TimeRange(value as TimeRangeInput);
    }
    const interval = value as readonly [
      unknown,
      TimestampInput,
      TimestampInput,
    ];
    return new TimeRange({ start: interval[1], end: interval[2] });
  }
  if ('value' in value) {
    const interval = value as { start: TimestampInput; end: TimestampInput };
    return new TimeRange({ start: interval.start, end: interval.end });
  }
  return new TimeRange(value as TimeRangeInput);
}

/** A time interval event key with inclusive start and end boundaries. Example: `new TimeRange({ start, end })`. */
export class TimeRange implements EventKey {
  readonly kind = 'timeRange';
  readonly start: number;
  readonly endMs: number;

  /** Example: `TimeRange.fromDate("2025-01-01", { timeZone: "Europe/Madrid" })`. Creates the local calendar-day range for the supplied ISO date. */
  static fromDate(reference: string, options: TimeZoneOptions = {}): TimeRange {
    return new TimeRange(dayRangeForDate(reference, options));
  }

  /** Example: `TimeRange.fromCalendar("week", "2025-01-01", { timeZone: "UTC", weekStartsOn: 1 })`. Creates the containing calendar range for the supplied reference. */
  static fromCalendar(
    unit: CalendarUnit,
    reference: string,
    options: CalendarOptions = {},
  ): TimeRange {
    return new TimeRange(calendarRangeForReference(unit, reference, options));
  }

  /** Example: `new TimeRange([start, end])`. Creates an interval key from a `{ start, end }` object or tuple. */
  constructor(input: TimeRangeInput) {
    let rawStart: TimestampInput;
    let rawEnd: TimestampInput;
    if (Array.isArray(input)) {
      rawStart = input[0];
      rawEnd = input[1];
    } else {
      const objectInput = input as TimeRangeObjectInput;
      rawStart = objectInput.start;
      rawEnd = objectInput.end;
    }
    const start = normalizeTimestamp(rawStart, 'timeRange start');
    const end = normalizeTimestamp(rawEnd, 'timeRange end');
    if (start > end) {
      throw new TypeError('timeRange start must be <= end');
    }
    this.start = start;
    this.endMs = end;
    Object.freeze(this);
  }

  /** Example: `range.type() // "timeRange"`. Returns the key kind. */
  type(): 'timeRange' {
    return this.kind;
  }

  /** Example: `range.begin()`. Returns the inclusive start of the range in milliseconds since epoch. */
  begin(): number {
    return this.start;
  }

  /** Example: `range.end()`. Returns the inclusive end of the range in milliseconds since epoch. */
  end(): number {
    return this.endMs;
  }

  /** Example: `range.timeRange()`. Returns this key as a `TimeRange`. */
  timeRange(): TimeRange {
    return this;
  }

  /** Example: `range.duration()`. Returns the temporal duration of the range in milliseconds. */
  duration(): number {
    return this.endMs - this.start;
  }

  /** Example: `range.midpoint()`. Returns the midpoint of the range in milliseconds since epoch. */
  midpoint(): number {
    return this.start + this.duration() / 2;
  }

  /**
   * Example: `range.toJSON()`. Returns `{ start, end }` as ms-since-epoch
   * numbers — the same shape `JsonTimeRangeInput` accepts, so the result
   * round-trips through `new TimeRange(range.toJSON())` and JSON wire
   * formats. Implicitly invoked by `JSON.stringify(range)`.
   */
  toJSON(): { start: number; end: number } {
    return { start: this.start, end: this.endMs };
  }

  /**
   * Example: `range.toString()`. Returns an ISO-8601 representation of
   * the range as `start/end`, e.g. `2025-01-15T09:00:00.000Z/2025-01-15T10:00:00.000Z`.
   * Useful for debug logs and human-readable display.
   */
  toString(): string {
    return `${new Date(this.start).toISOString()}/${new Date(this.endMs).toISOString()}`;
  }

  /** Example: `range.contains(otherRange)`. Returns `true` when this range fully contains the supplied temporal value. */
  contains(other: TemporalLike): boolean {
    const range = toTimeRange(other);
    return range.begin() >= this.begin() && range.end() <= this.end();
  }

  /** Example: `range.overlaps(otherRange)`. Returns `true` when this range overlaps the supplied temporal value. */
  overlaps(other: TemporalLike): boolean {
    const range = toTimeRange(other);
    return this.begin() <= range.end() && range.begin() <= this.end();
  }

  /** Example: `range.isBefore(otherRange)`. Returns `true` when this range ends strictly before the supplied temporal value begins. */
  isBefore(other: TemporalLike): boolean {
    const range = toTimeRange(other);
    return this.end() < range.begin();
  }

  /** Example: `range.isAfter(otherRange)`. Returns `true` when this range begins strictly after the supplied temporal value ends. */
  isAfter(other: TemporalLike): boolean {
    const range = toTimeRange(other);
    return this.begin() > range.end();
  }

  /** Example: `range.intersection(otherRange)`. Returns the overlapping portion of this range and the supplied temporal value, if any. */
  intersection(other: TemporalLike): TimeRange | undefined {
    const range = toTimeRange(other);
    if (!this.overlaps(range)) {
      return undefined;
    }
    return new TimeRange({
      start: Math.max(this.begin(), range.begin()),
      end: Math.min(this.end(), range.end()),
    });
  }

  /** Example: `range.trim(otherRange)`. Returns this range clipped to the supplied temporal value, if the two overlap. */
  trim(other: TemporalLike): TimeRange | undefined {
    return this.intersection(other);
  }

  /** Example: `range.equals(otherRange)`. Returns `true` when the supplied key is the same `TimeRange`. */
  equals(other: EventKey): boolean {
    return (
      other instanceof TimeRange &&
      this.start === other.start &&
      this.endMs === other.endMs
    );
  }

  /** Example: `range.compare(otherRange)`. Compares this key to another key for ordering. */
  compare(other: EventKey): number {
    return compareEventKeys(this, other);
  }
}
