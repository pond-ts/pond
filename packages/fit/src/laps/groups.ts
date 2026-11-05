/**
 * Lap groups: once laps carry types or names (warm-up, "400m" reps, "200m"
 * jogs), the laps of the same type and name read as one group ("Active ·
 * 400m: 6 laps"). Ported from Estela's lap summary.
 *
 * The grouping is separate from the numbers: {@link groupLaps} says which
 * laps go together and in what order; {@link summarizeLaps} combines laps'
 * own averages (for laps with no samples behind them, such as logged laps);
 * for laps with samples, `sectionGroupStats` reads the recording instead.
 */

/** One lap as grouping reads it. */
export interface GroupLap {
  /** The lap's id in the result; defaults to its position (from 0). */
  id?: number | undefined;
  /** The lap's type (`'active'`, `'recovery'`, a user's own); undefined or
   *  `''` for none. */
  type?: string | undefined;
  /** The lap's name; undefined or `''` for none. */
  name?: string | undefined;
  /** Distance, metres: orders a type's names shortest first. */
  meters?: number | undefined;
}

/** One group, or a heading over a type whose laps carry several names. */
export interface LapGroup {
  /** Unique within the result, for list keys: the type and, under a
   *  heading, the name, as JSON (`'["active"]'`, `'["active","400m"]'`,
   *  `'[null]'` for laps with no type). */
  key: string;
  /** The type; undefined for laps with none. */
  type?: string;
  /** The laps' shared name (`''` for none); absent on a heading. */
  name?: string;
  /** 0 for a type, 1 for a name under its type's heading. */
  depth: 0 | 1;
  /** A type split by name: it has no numbers of its own. */
  heading?: boolean;
  /** The laps in it, by id. */
  laps: number[];
}

const nonNegative = (v: number | undefined | null): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;
const pos = (v: number | undefined | null): v is number =>
  v != null && Number.isFinite(v) && v > 0;

const typeOf = (l: GroupLap) => (l.type ? l.type : undefined);

/** Whether any lap carries a type or a name (the groups mean something). */
export function hasLapGroups(laps: readonly GroupLap[]): boolean {
  return laps.some((l) => !!l.type || !!l.name);
}

/**
 * The laps grouped by type, then name; null when no lap has a type or a
 * name. Types come in the order the session first reaches them (warm-up,
 * reps and recoveries, cool-down), laps with no type last. A type whose laps
 * share one name is one group carrying that name; one with several names
 * gets a heading and a group per name, shortest laps first (first-seen order
 * when any name's laps have no distance). Throws a RangeError when two laps
 * end up with the same id.
 */
export function groupLaps(laps: readonly GroupLap[]): LapGroup[] | null {
  if (!hasLapGroups(laps)) return null;
  const indexed = laps.map((l, at) => ({ l, id: l.id ?? at, type: typeOf(l) }));
  const seen = new Set<number>();
  for (const { id } of indexed) {
    if (seen.has(id)) throw new RangeError(`groupLaps: lap id ${id} repeats`);
    seen.add(id);
  }
  const types: (string | undefined)[] = [];
  for (const { type } of indexed)
    if (type !== undefined && !types.includes(type)) types.push(type);
  types.push(undefined);
  const out: LapGroup[] = [];
  for (const type of types) {
    const ofType = indexed.filter((x) => x.type === type);
    if (!ofType.length) continue;
    const key = JSON.stringify([type ?? null]);
    const t = type !== undefined ? { type } : {};
    const names: string[] = [];
    for (const { l } of ofType) {
      const n = l.name ?? '';
      if (!names.includes(n)) names.push(n);
    }
    const lapsNamed = (n: string) =>
      ofType.filter((x) => (x.l.name ?? '') === n);
    if (names.length === 1) {
      out.push({
        key,
        ...t,
        name: names[0]!,
        depth: 0,
        laps: ofType.map((x) => x.id),
      });
      continue;
    }
    const meanMeters = (n: string) => {
      const ms = lapsNamed(n)
        .map((x) => x.l.meters)
        .filter(pos);
      return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : undefined;
    };
    const sized = names.every((n) => meanMeters(n) !== undefined);
    const ordered = sized
      ? [...names].sort((a, b) => meanMeters(a)! - meanMeters(b)!)
      : names;
    out.push({
      key,
      ...t,
      depth: 0,
      heading: true,
      laps: ofType.map((x) => x.id),
    });
    for (const n of ordered)
      out.push({
        key: JSON.stringify([type ?? null, n]),
        ...t,
        name: n,
        depth: 1,
        laps: lapsNamed(n).map((x) => x.id),
      });
  }
  return out;
}

/** A lap's own numbers, as a device or a log keeps them. SI. */
export interface LapAverages {
  meters?: number | undefined;
  /** Moving time where kept, else elapsed. */
  seconds?: number | undefined;
  /** The lap's own average speed when the device kept one; else distance
   *  over time. */
  speedMps?: number | undefined;
  avgHr?: number | undefined;
  avgWatts?: number | undefined;
  npWatts?: number | undefined;
}

/** Laps' averages combined. The lap extremes are the lowest and highest
 *  lap's own average, never a moment inside a lap, and need two laps. */
export interface LapsSummary {
  /** Total distance over total time. */
  speedMps?: number;
  slowestLapMps?: number;
  fastestLapMps?: number;
  /** Time-weighted. */
  avgHr?: number;
  highestLapHr?: number;
  /** Time-weighted. */
  avgWatts?: number;
  highestLapWatts?: number;
  /** Each lap's NP combined as NP is made: the time-weighted mean of the
   *  4th powers, 4th-rooted. */
  npWatts?: number;
}

/** A lap's own speed: the device's when kept, else distance over time. */
export function lapSpeed(l: LapAverages): number | undefined {
  if (pos(l.speedMps)) return l.speedMps;
  return pos(l.meters) && pos(l.seconds) ? l.meters / l.seconds : undefined;
}

/**
 * Combine laps' own averages. Speed is the whole distance over the whole
 * time (a short lap doesn't count as much as a long one); heart rate and
 * power are weighted by each lap's time (equally when a lap has none).
 */
export function summarizeLaps(laps: readonly LapAverages[]): LapsSummary {
  const out: LapsSummary = {};
  let m = 0;
  let s = 0;
  // a lap that stood still (0 m over a known time) still counts its time
  for (const l of laps)
    if (nonNegative(l.meters) && pos(l.seconds)) {
      m += l.meters;
      s += l.seconds;
    }
  // all zero: likely no distance recorded (indoors), so no speed
  if (m > 0 && s > 0) out.speedMps = m / s;
  const weighted = (
    f: (l: LapAverages) => number | undefined,
    power = 1,
    keep: (v: number | undefined) => v is number = pos,
  ) => {
    let sum = 0;
    let w = 0;
    for (const l of laps) {
      const v = f(l);
      if (!keep(v)) continue;
      const t = pos(l.seconds) ? l.seconds : 1;
      sum += v ** power * t;
      w += t;
    }
    return w > 0 ? (sum / w) ** (1 / power) : undefined;
  };
  const range = (f: (l: LapAverages) => number | undefined) => {
    const vs = laps.map(f).filter(pos);
    return vs.length > 1
      ? { lo: Math.min(...vs), hi: Math.max(...vs) }
      : undefined;
  };
  const speeds = range(lapSpeed);
  if (speeds) {
    out.slowestLapMps = speeds.lo;
    out.fastestLapMps = speeds.hi;
  }
  const put = <K extends keyof LapsSummary>(k: K, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) out[k] = v;
  };
  put(
    'avgHr',
    weighted((l) => l.avgHr),
  );
  put('highestLapHr', range((l) => l.avgHr)?.hi);
  put(
    'avgWatts',
    // 0 W is a real reading (coasting), unlike 0 bpm
    weighted((l) => l.avgWatts, 1, nonNegative),
  );
  put('highestLapWatts', range((l) => l.avgWatts)?.hi);
  put(
    'npWatts',
    weighted((l) => l.npWatts, 4, nonNegative),
  );
  return out;
}

/** A group's lowest and highest lap by some number (see {@link lapExtremes}). */
export interface LapExtremes {
  lowest: number;
  lowestLap: number;
  highest: number;
  highestLap: number;
}

/**
 * The laps of a group with the lowest and highest of a number, for marking
 * them on a chart; null with fewer than two laps that have a finite value,
 * or when they tie. Ties go to the earlier lap. Every finite value counts,
 * so return undefined from `value` for a lap that has none (as
 * {@link lapSpeed} does).
 */
export function lapExtremes(
  lapIds: readonly number[],
  value: (lap: number) => number | undefined,
): LapExtremes | null {
  const vals = lapIds.flatMap((lap) => {
    const v = value(lap);
    return v !== undefined && Number.isFinite(v) ? [{ lap, value: v }] : [];
  });
  if (vals.length < 2) return null;
  let hi = vals[0]!;
  let lo = vals[0]!;
  for (const v of vals) {
    if (v.value > hi.value) hi = v;
    if (v.value < lo.value) lo = v;
  }
  return hi.lap === lo.lap
    ? null
    : {
        lowest: lo.value,
        lowestLap: lo.lap,
        highest: hi.value,
        highestLap: hi.lap,
      };
}
