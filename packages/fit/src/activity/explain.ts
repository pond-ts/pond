/**
 * `run.explain('distance')` (RFC §9): where a number comes from, how it was
 * worked out, how much of the recording backs it, and what edits it went
 * through. Numbers stay plain; this is the detail behind them.
 */
import type { PreparedActivity } from '../summary/index.js';
import type { EditChange } from './editing.js';

/** What can be explained. */
export type Explainable =
  | 'distance'
  | 'elapsed'
  | 'moving'
  | 'timer'
  | 'heartRate'
  | 'power'
  | 'cadence'
  | 'elevation'
  | 'speed';

/** Where one number of an activity comes from. */
export interface Explanation {
  quantity: Explainable;
  /** A short name for the source: `'gps'`, `'device'`, `'pool-lengths'`,
   *  `'samples'`, `'file'`, `'recorded'`, `'derived'`, … or `'none'` when the
   *  activity doesn't have it. */
  source: string;
  /** How it is worked out, in a sentence. */
  method: string;
  /** The share of samples (0 to 1) that carry the value it rests on; null
   *  where samples don't come into it. */
  coverage: number | null;
  /** The edits the activity went through (empty when unedited). */
  edits: EditChange[];
}

function share(a: ArrayLike<number> | undefined, n: number): number | null {
  if (!a || !n) return null;
  let k = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(a[i]!)) k++;
  return k / n;
}

/** @internal */
export function explainOf(
  prep: PreparedActivity,
  quantity: Explainable,
  timer: number | undefined,
  edits: EditChange[],
): Explanation {
  const n = prep.n;
  const out = (source: string, method: string, coverage: number | null) => ({
    quantity,
    source,
    method,
    coverage,
    edits,
  });
  switch (quantity) {
    case 'distance':
      switch (prep.distanceSource) {
        case 'pool-lengths':
          return out(
            'pool-lengths',
            'The pool length times the lengths swum; a length cut by a section counts its share.',
            null,
          );
        case 'gps':
          return out(
            'gps',
            'Measured along the GPS line between fixes.',
            share(prep.cols.lat, n),
          );
        case 'device':
          return out(
            'device',
            "The device's own distance, held so it never goes back.",
            share(prep.cols.distance, n),
          );
        default:
          return out('none', 'The recording has no distance.', null);
      }
    case 'elapsed':
      if (!prep.hasClock)
        return out('none', 'The recording has no timestamps.', null);
      return out(
        prep.hasTime ? 'samples' : 'pool-segments',
        prep.hasTime
          ? "From the activity's start (or an earlier sample) to its last sample, or to a pool swim's last length or rest."
          : "From the pool swim's first timed length or rest to its last.",
        null,
      );
    case 'moving':
      switch (prep.movingRule) {
        case 'pool-lengths':
          return out(
            'pool-lengths',
            'The time spent swimming lengths; rests at the wall are stopped time.',
            null,
          );
        case 'pool-laps':
          return out(
            'pool-laps',
            'The time in laps that covered distance; laps with none are rests.',
            null,
          );
        case 'swim-time':
          return out(
            'file',
            "The watch's own swim time, for the whole swim only.",
            null,
          );
        default:
          return prep.hasTime
            ? out(
                'speed',
                'The time between samples at 0.5 m/s or faster.',
                share(prep.speed, n),
              )
            : out('none', 'The recording has no timestamps.', null);
      }
    case 'timer':
      return timer !== undefined
        ? out('file', "The device's timer, as the file records it.", null)
        : out('none', 'The file records no timer.', null);
    case 'speed':
      return prep.hasTime && prep.distanceSource !== 'none'
        ? out(
            'derived',
            'Distance over time between samples; the averages are distance over the time basis.',
            share(prep.speed, n),
          )
        : out('none', 'Needs both distance and timestamps.', null);
    default: {
      const col = {
        heartRate: prep.cols.hr,
        power: prep.cols.power,
        cadence: prep.cols.cadence,
        elevation: prep.cols.ele,
      }[quantity];
      const c = share(col, n);
      return c
        ? out('recorded', 'As the device recorded it; gaps stay gaps.', c)
        : out('none', 'Not recorded.', null);
    }
  }
}
