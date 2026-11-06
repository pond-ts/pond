/**
 * Heart rate recovery: how fast heart rate falls once an activity stops, and
 * in the stops and walk breaks inside a run ({@link findBreaks}).
 *
 * After the stop, a recovery is the heart rate at the stop plus readings in
 * the minutes after ({@link HeartRateRecovery}). A Garmin FIT file carries
 * one reading two minutes after (read by `@pond-ts/fit/files`); a watch that
 * keeps recording heart rate after the end gives a whole line
 * ({@link recoveryFromReadings}). Ported from Estela.
 */
import type { HeartRateRecovery } from '../types.js';

export * from './breaks.js';

/** One heart rate reading after the stop. */
export type RecoveryReading = HeartRateRecovery['after'][number];

/** Readings further than this after the stop are left out. */
export const RECOVERY_MAX_SECONDS = 300;
/** The last reading before the stop counts as "at the stop" only this close
 *  to it. */
const AT_STOP_SECONDS = 30;

/** The moment activities are compared at: two minutes after the stop, the
 *  one reading Garmin watches save. */
export const COMPARE_SECONDS = 120;

/** The reading nearest `sec` seconds after the stop, within `within`
 *  seconds; undefined when there is none that close. */
export function recoveryAt(
  r: HeartRateRecovery,
  sec: number,
  within = 10,
): RecoveryReading | undefined {
  let best: RecoveryReading | undefined;
  for (const x of r.after)
    if (
      Math.abs(x.sec - sec) <= within &&
      (!best || Math.abs(x.sec - sec) < Math.abs(best.sec - sec))
    )
      best = x;
  return best;
}

/**
 * A recovery from heart rate readings around the end of an activity:
 * `readings` are `[time, bpm]` on any clock, `endTime` is the stop on the
 * same clock. The last reading up to 30 seconds before the stop is the heart
 * rate at the stop; readings up to 5 minutes after are the line (seconds
 * rounded, at least 1). Values outside 25–250 bpm are left out. Undefined when there is
 * no reading after the stop.
 */
export function recoveryFromReadings(
  readings: readonly (readonly [number, number])[],
  endTime: number,
): HeartRateRecovery | undefined {
  const sorted = [...readings].sort((a, b) => a[0] - b[0]);
  const after: RecoveryReading[] = [];
  let atStopBpm: number | undefined;
  for (const [t, bpm] of sorted) {
    if (!(bpm >= 25 && bpm <= 250)) continue; // not a heart rate
    const sec = t - endTime;
    if (sec <= 0) {
      if (sec >= -AT_STOP_SECONDS) atStopBpm = bpm;
    } else if (sec <= RECOVERY_MAX_SECONDS)
      after.push({ sec: Math.max(1, Math.round(sec)), bpm });
  }
  if (after.length === 0) return undefined;
  return { ...(atStopBpm !== undefined ? { atStopBpm } : {}), after };
}

/**
 * A recovery cut down to keep with an activity's record: the heart rate at
 * the stop and the readings nearest 1, 2 and 3 minutes after. Any other
 * fields on `r` are kept as they are.
 */
export function recoverySummary<R extends HeartRateRecovery>(r: R): R {
  const after = [60, 120, 180]
    .map((sec) => recoveryAt(r, sec))
    .filter((x): x is RecoveryReading => !!x);
  return { ...r, after };
}

/** The two-minute drop of a recovery, when it has both the heart rate at the
 *  stop and a reading near two minutes. */
export function twoMinuteDrop(
  r: HeartRateRecovery | undefined,
): { atStopBpm: number; bpm: number; dropBpm: number } | undefined {
  if (!r || r.atStopBpm === undefined) return undefined;
  const at = recoveryAt(r, COMPARE_SECONDS);
  return at
    ? { atStopBpm: r.atStopBpm, bpm: at.bpm, dropBpm: r.atStopBpm - at.bpm }
    : undefined;
}
