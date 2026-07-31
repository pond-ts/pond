import { TimeSeries } from 'pond-ts';
import { RIDE_ELEVATION_M, RIDE_WATTS } from './ride-samples';

/**
 * A real ride, as a pond `TimeSeries` — the Getting-started worked example's
 * data. See `ride-samples.ts` for provenance: 1 Hz power and altitude from a
 * Garmin head unit, gaps and coasting zeros left intact.
 *
 * The samples are already columnar (one array per channel, one value per
 * elapsed second), so this takes `fromColumns` rather than building row tuples
 * — the same struct-of-arrays door the page's ingest tip points at.
 */

/** Functional threshold power, watts — the rider's own setting on the head unit. */
export const RIDE_FTP = 200;

/** Elapsed seconds covered by the samples (including the recorder's dropouts). */
export const RIDE_ELAPSED_S = RIDE_WATTS.length - 1;

/** Ride start, 20 July 2016 13:30:44 UTC. */
export const RIDE_START_MS = Date.UTC(2016, 6, 20, 13, 30, 44);

export const RIDE_SCHEMA = [
  { name: 'time', kind: 'time' },
  // Optional: the recorder's dropouts ride as gaps rather than as zeros, which
  // would be a lie — 0 W means coasting, and this ride does plenty of that.
  { name: 'watts', kind: 'number', required: false },
  { name: 'elevation', kind: 'number', required: false },
] as const;

export function ride(): TimeSeries<typeof RIDE_SCHEMA> {
  return TimeSeries.fromColumns({
    name: 'ride',
    schema: RIDE_SCHEMA,
    columns: {
      time: RIDE_WATTS.map((_, i) => RIDE_START_MS + i * 1000),
      watts: RIDE_WATTS,
      elevation: RIDE_ELEVATION_M,
    },
  });
}
