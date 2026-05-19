/**
 * JSON ↔ typed-row conversion primitives.
 *
 * Used by `TimeSeries.{toJSON,fromJSON}`, `LiveSeries.{toJSON,fromJSON,pushJson}`,
 * and `Event.{toJsonRow}`. Extracted into its own module so `Event`
 * can import the serialization helpers without depending on
 * `TimeSeries` (which depends on `Event`, creating a cycle).
 */
import { Interval } from '../core/interval.js';
import { Time } from '../core/time.js';
import { TimeRange } from '../core/time-range.js';
import { parseTimestampString } from '../core/calendar.js';
import type { TimeZoneOptions } from '../core/calendar.js';
import type { EventKey } from '../core/temporal.js';
import type {
  FirstColKind,
  JsonObjectRowForSchema,
  JsonRowForSchema,
  JsonRowFormat,
  JsonValueForKind,
  SeriesSchema,
  TimeSeriesInput,
  TimeSeriesJsonInput,
} from '../types.js';

/**
 * Detects the object-shape variant of a JSON row.
 */
export function isJsonObjectRow<S extends SeriesSchema>(
  value: JsonRowForSchema<S> | JsonObjectRowForSchema<S>,
): value is JsonObjectRowForSchema<S> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonTimestamp(
  value: unknown,
  options: TimeZoneOptions = {},
): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('expected finite timestamp');
    }
    return value;
  }
  if (typeof value === 'string') {
    return parseTimestampString(value, options);
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  throw new TypeError('expected timestamp as number or string');
}

/**
 * Translate a JSON-shape key into a typed `EventKey` instance.
 * Mirrors `TimeSeries.fromJSON`'s parsing rules: numeric/string/Date
 * for time keys; tuple or object form for timeRange/interval.
 */
export function parseJsonKey(
  kind: FirstColKind,
  value: unknown,
  options: TimeZoneOptions = {},
): EventKey {
  if (
    value instanceof Time ||
    value instanceof TimeRange ||
    value instanceof Interval
  ) {
    return value;
  }

  switch (kind) {
    case 'time':
      return new Time(parseJsonTimestamp(value, options));
    case 'timeRange':
      if (Array.isArray(value) && value.length === 2) {
        return new TimeRange({
          start: parseJsonTimestamp(value[0], options),
          end: parseJsonTimestamp(value[1], options),
        });
      }
      if (
        typeof value === 'object' &&
        value !== null &&
        'start' in value &&
        'end' in value &&
        !('value' in value)
      ) {
        return new TimeRange({
          start: parseJsonTimestamp(
            (value as { start: unknown }).start,
            options,
          ),
          end: parseJsonTimestamp((value as { end: unknown }).end, options),
        });
      }
      throw new TypeError(
        'expected timeRange as [start, end] or { start, end }',
      );
    case 'interval':
      if (Array.isArray(value) && value.length === 3) {
        return new Interval({
          value: value[0] as string | number,
          start: parseJsonTimestamp(value[1], options),
          end: parseJsonTimestamp(value[2], options),
        });
      }
      if (
        typeof value === 'object' &&
        value !== null &&
        'value' in value &&
        'start' in value &&
        'end' in value
      ) {
        return new Interval({
          value: (value as { value: string | number }).value,
          start: parseJsonTimestamp(
            (value as { start: unknown }).start,
            options,
          ),
          end: parseJsonTimestamp((value as { end: unknown }).end, options),
        });
      }
      throw new TypeError(
        'expected interval as [value, start, end] or { value, start, end }',
      );
    default:
      throw new TypeError(`unsupported first-column kind '${kind}'`);
  }
}

/**
 * Translate one JSON-shape row (array or object form) into a typed
 * row tuple. Nulls become `undefined`; the key is parsed via
 * {@link parseJsonKey}.
 */
export function parseJsonRow<S extends SeriesSchema>(
  schema: S,
  row: JsonRowForSchema<S> | JsonObjectRowForSchema<S>,
  options: TimeZoneOptions = {},
): TimeSeriesInput<S>['rows'][number] {
  const values = isJsonObjectRow(row)
    ? schema.map((column) => row[column.name as keyof typeof row])
    : row;

  return Object.freeze(
    values.map((value, index) => {
      if (value === null) {
        return undefined;
      }
      const column = schema[index]!;
      if (index === 0) {
        return parseJsonKey(column.kind as FirstColKind, value, options);
      }
      return value;
    }),
  ) as TimeSeriesInput<S>['rows'][number];
}

/**
 * Translate an array of JSON-shape rows into typed rows.
 */
export function parseJsonRows<S extends SeriesSchema>(
  schema: S,
  rows: TimeSeriesJsonInput<S>['rows'],
  options: TimeZoneOptions = {},
): TimeSeriesInput<S>['rows'] {
  return rows.map((row) =>
    parseJsonRow(schema, row, options),
  ) as TimeSeriesInput<S>['rows'];
}

/**
 * Serialize an `EventKey` into the JSON-shape representation used
 * on the wire.
 */
export function serializeJsonKey(
  kind: FirstColKind,
  key: EventKey,
  rowFormat: JsonRowFormat,
): JsonValueForKind<FirstColKind> {
  if (kind === 'time') {
    return key.begin();
  }

  if (kind === 'timeRange') {
    return rowFormat === 'object'
      ? { start: key.begin(), end: key.end() }
      : [key.begin(), key.end()];
  }

  const interval = key as Interval;
  return rowFormat === 'object'
    ? { value: interval.value, start: interval.begin(), end: interval.end() }
    : [interval.value, interval.begin(), interval.end()];
}

/**
 * Translate a column cell to its JSON-shape representation:
 * `undefined` becomes `null` so wire messages round-trip through
 * `JSON.stringify`.
 */
export function serializeJsonValue(value: unknown): unknown {
  return value === undefined ? null : value;
}
