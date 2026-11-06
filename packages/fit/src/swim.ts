import type { Lap } from './types.js';

/** A swim's time spent swimming from its laps: the summed timer time of the
 *  laps that covered distance (rests between sets have none). `undefined`
 *  when no lap covered distance. */
export function swimMovingSeconds(laps: readonly Lap[]): number | undefined {
  let total = 0;
  let any = false;
  for (const l of laps)
    if (l.distanceMeters > 0) {
      total += l.movingSeconds;
      any = true;
    }
  return any ? total : undefined;
}
