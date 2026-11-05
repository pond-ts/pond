/** The sport families the library tells apart. The file's own label is kept
 *  beside it ({@link Activity.sportType}). */
export type Sport = 'run' | 'ride' | 'swim' | 'walk' | 'hike' | 'other';

const FAMILIES: readonly [Sport, RegExp][] = [
  ['swim', /swim/i],
  ['ride', /ride|cycl|bik/i],
  ['hike', /hike/i],
  ['walk', /walk/i],
  ['run', /run/i],
];

/** The sport family of a Strava-style label (`"TrailRun"` → `'run'`,
 *  `"VirtualRide"` → `'ride'`); `'other'` when none fits. */
export function sportOf(label: string): Sport {
  for (const [sport, re] of FAMILIES) if (re.test(label)) return sport;
  return 'other';
}
