import { useMemo } from 'react';
import { TimeSeries } from 'pond-ts';
import type {
  SeriesSchema,
  TimeSeriesJsonInput,
  TimeZoneOptions,
} from 'pond-ts';

/**
 * Memoized `TimeSeries.fromJSON(...)` for static or fetched data.
 *
 * Re-parses only when `key` changes. If no `key` is provided, the input is
 * serialized via `JSON.stringify` as the cache key — fine for small to
 * moderate payloads. For large datasets, pass an explicit `key` (e.g. a fetch
 * URL or ETag) to avoid the serialization cost.
 *
 * The schema generic `S` is inferred directly from `input.schema` (a plain
 * structural position), so an `as const` schema narrows the returned
 * `TimeSeries<S>` fully — `result.column('cpu')` resolves to `Float64Column`,
 * `result.at(i)!.get('cpu')` to `number | undefined`, etc. An earlier
 * two-generic `<S, I extends Parameters<...>[0]>` shape lost `S` through the
 * input-wrapper generic and collapsed schema-narrowed accessors to `never`
 * (the loose `.get(string)` path masked it); the column API surfaced it. The
 * accepted input type is unchanged — `Parameters<fromJSON<S>>[0]` already
 * resolved to `TimeSeriesJsonInput<S> & { parse? }` — so this is purely an
 * inference fix, not a surface change.
 */
export function useTimeSeries<S extends SeriesSchema>(
  input: TimeSeriesJsonInput<S> & { parse?: TimeZoneOptions },
  key?: string,
): TimeSeries<S> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cacheKey = key ?? JSON.stringify(input);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => TimeSeries.fromJSON<S>(input), [cacheKey]);
}
