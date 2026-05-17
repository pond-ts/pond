import { parseTimestampString, type TimeZoneOptions } from '../calendar.js';
import { TimeRange } from './TimeRange.js';
import type { EventKey, TemporalLike, TimestampInput } from '../temporal.js';
import { compareEventKeys, normalizeTimestamp } from '../temporal.js';

/** A point-in-time event key represented as a single millisecond timestamp. Example: `new Time(Date.now())`. */
export class Time implements EventKey {
  readonly kind = 'time';
  readonly timestamp: number;

  /** Example: `Time.parse("2025-01-01T09:00", { timeZone: "Europe/Madrid" })`. Parses a strict ISO-like timestamp string into an absolute `Time`. */
  static parse(value: string, options: TimeZoneOptions = {}): Time {
    return new Time(parseTimestampString(value, options));
  }

  /** Example: `new Time(new Date())`. Creates a point-in-time key from a `Date` or millisecond timestamp. */
  constructor(value: TimestampInput) {
    this.timestamp = normalizeTimestamp(value, 'time');
    Object.freeze(this);
  }

  /** Example: `time.type() // "time"`. Returns the key kind. */
  type(): 'time' {
    return this.kind;
  }

  /** Example: `time.begin()`. Returns the inclusive start of the key in milliseconds since epoch. */
  begin(): number {
    return this.timestamp;
  }

  /** Example: `time.end()`. Returns the inclusive end of the key in milliseconds since epoch. */
  end(): number {
    return this.timestamp;
  }

  /** Example: `time.timestampMs()`. Returns the key timestamp in milliseconds since epoch. */
  timestampMs(): number {
    return this.timestamp;
  }

  /** Example: `time.toDate()`. Returns a native `Date` for the key timestamp. */
  toDate(): Date {
    return new Date(this.timestamp);
  }

  /** Example: `Number(time)`. Returns the primitive millisecond timestamp for numeric coercion. */
  valueOf(): number {
    return this.timestamp;
  }

  /** Example: `time.timeRange()`. Returns this point as a zero-width `TimeRange`. */
  timeRange(): TimeRange {
    return new TimeRange({ start: this.timestamp, end: this.timestamp });
  }

  /** Example: `time.duration() // 0`. Returns the temporal duration of the key in milliseconds. */
  duration(): number {
    return 0;
  }

  /** Example: `time.overlaps(range)`. Returns `true` when this point overlaps the supplied temporal value. */
  overlaps(other: TemporalLike): boolean {
    return this.timeRange().overlaps(other);
  }

  /** Example: `time.contains(Date.now())`. Returns `true` when this point fully contains the supplied temporal value. */
  contains(other: TemporalLike): boolean {
    return this.timeRange().contains(other);
  }

  /** Example: `time.isBefore(otherTime)`. Returns `true` when this point ends strictly before the supplied temporal value begins. */
  isBefore(other: TemporalLike): boolean {
    return this.timeRange().isBefore(other);
  }

  /** Example: `time.isAfter(otherTime)`. Returns `true` when this point begins strictly after the supplied temporal value ends. */
  isAfter(other: TemporalLike): boolean {
    return this.timeRange().isAfter(other);
  }

  /** Example: `time.intersection(range)`. Returns the temporal intersection with the supplied value, if any. */
  intersection(other: TemporalLike): TimeRange | undefined {
    return this.timeRange().intersection(other);
  }

  /** Example: `time.trim(range)`. Returns this key when it falls within the supplied temporal value, otherwise `undefined`. */
  trim(other: TemporalLike): Time | undefined {
    return this.overlaps(other) ? this : undefined;
  }

  /** Example: `time.equals(otherTime)`. Returns `true` when the supplied key is the same `Time`. */
  equals(other: EventKey): boolean {
    return other instanceof Time && this.timestamp === other.timestamp;
  }

  /** Example: `time.compare(otherTime)`. Compares this key to another key for ordering. */
  compare(other: EventKey): number {
    return compareEventKeys(this, other);
  }
}
