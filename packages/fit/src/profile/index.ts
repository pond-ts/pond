/**
 * The athlete profile — the **time-varying** settings an activity is read
 * against: body weight (for W/kg), FTP (power zones), the HR-zone basis (max HR
 * or custom bounds), and a threshold 5 k time (pace zones). Each quantity is a
 * sparse, effective-dated series: "from this date, my FTP was 250 W."
 *
 * Modeled as pond `TimeSeries` keyed by the effective date and resolved with
 * `series.atOrBefore(activityDate)` — the value in force on the day of the
 * activity. A natural pond fit: an irregular, step-function config series with an
 * as-of query. {@link hydrateProfile} lifts the persisted profile JSON into the
 * series, {@link profileAsOf} resolves a date.
 */
import { TimeSeries, Time } from 'pond-ts';

// ── On-disk JSON shape (the vault's profile/athlete.json) ───────────────────

/** One effective-dated scalar entry: "from `at`, the value was `value`." */
export interface ScalarEntry {
  /** ISO 8601 date (or datetime) the value took effect. */
  at: string;
  value: number;
}

/** HR-zone basis: either a max HR (zones derived from %s) or explicit bounds
 *  (the four Z1/Z2, Z2/Z3, Z3/Z4, Z4/Z5 boundaries in bpm). */
export type HrZoneEntry =
  | { at: string; maxHr: number }
  | { at: string; bounds: [number, number, number, number] };

/** Pace-zone basis: a recent 5 k time in seconds (zones are relative to it). */
export interface PaceThresholdEntry {
  at: string;
  fiveKSeconds: number;
}

/** The whole athlete profile as stored in the vault. Every series is optional —
 *  a fresh vault has none, and each fills in as the athlete records it. */
export interface AthleteProfileJson {
  weightKg?: ScalarEntry[];
  ftpWatts?: ScalarEntry[];
  hrZone?: HrZoneEntry[];
  paceThreshold?: PaceThresholdEntry[];
}

// ── Zone definitions (what the distribution + UI consume) ───────────────────

/**
 * A zone scheme over a value axis: ascending `edges` (length = nZones + 1, the
 * last a large sentinel for the open top) and the `labels` per zone (Z1 first).
 * The axis is bpm for HR and **m/s for pace** (we bucket speed, not pace, so a
 * stop doesn't blow the reciprocal up — Z1 = slowest). Power reuses the same
 * shape over watts.
 */
export interface ZoneDef {
  edges: number[];
  labels: string[];
}

/** Resolved athlete settings for one activity date — `undefined` where the
 *  athlete hasn't recorded that series yet. */
export interface ResolvedProfile {
  weightKg?: number;
  ftpWatts?: number;
  hrZones?: ZoneDef;
  paceZones?: ZoneDef;
}

const SENTINEL = 1e9; // open-top edge (pond/byColumn require finite edges)

/** HR zones (5), Z1→Z5. Strava's max-HR defaults: Z1≤65%, Z2≤81%, Z3≤89%,
 *  Z4≤97%, Z5 above (e.g. max 198 → 129/160/176/192). */
const HR_ZONE_LABELS = [
  'Recovery',
  'Endurance',
  'Tempo',
  'Threshold',
  'Anaerobic',
];
const HR_MAX_FRACTIONS = [0.65, 0.81, 0.89, 0.97]; // Z1/Z2 … Z4/Z5 upper bounds

/** Pace zones (6), Z1→Z6. Boundaries as multiples of 5 k pace (slower = lower
 *  zone), approximating Strava's 5 k-time model: Z1 Recovery (slowest) →
 *  Z6 Anaerobic (fastest). */
const PACE_ZONE_LABELS = [
  'Recovery',
  'Endurance',
  'Tempo',
  'Threshold',
  'VO2 Max',
  'Anaerobic',
];
const PACE_PACE_MULTIPLES = [1.33, 1.15, 1.03, 0.96, 0.9]; // of 5 k pace, slow→fast boundaries

/** HR zone scheme (bpm axis) from a max HR or explicit bounds. */
export function hrZonesFrom(
  basis: { maxHr: number } | { bounds: number[] },
): ZoneDef {
  const bounds =
    'bounds' in basis
      ? basis.bounds.slice(0, 4)
      : HR_MAX_FRACTIONS.map((f) => Math.round(f * basis.maxHr));
  return { edges: [0, ...bounds, SENTINEL], labels: HR_ZONE_LABELS };
}

/**
 * Pace zone scheme over the **speed** axis (m/s, ascending) from a 5 k time.
 * 5 k pace → boundary paces (× multiples) → boundary speeds (= dist/pace).
 * Edges ascend in speed, so bin 0 is the slowest (Z1 Recovery) and the top bin
 * the fastest (Z6 Anaerobic) — the labels are ordered to match.
 */
export function paceZonesFrom(fiveKSeconds: number): ZoneDef {
  const fiveKSpeed = fiveKSeconds > 0 ? 5000 / fiveKSeconds : 0; // m/s at 5 k pace
  // pace multiple m → speed = fiveKSpeed / m; larger pace multiple = slower.
  // Build ascending speed edges from the slow→fast pace multiples.
  const speedEdges = PACE_PACE_MULTIPLES.map((m) => fiveKSpeed / m);
  return { edges: [0, ...speedEdges, SENTINEL], labels: PACE_ZONE_LABELS };
}

// ── Resolution (pond atOrBefore) ────────────────────────────────────────────

/** A hydrated, date-keyed view of one series, answering "value as of date D". */
interface AsOf<T> {
  at(dateUtc: string): T | undefined;
}

/** Date key + a throwaway seq column (pond wants ≥1 value column); the rich
 *  payload rides in the key→entry map, not these columns. */
const AS_OF_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'seq', kind: 'number' },
] as const;

/**
 * Build a pond `TimeSeries` keyed by each entry's effective date and return an
 * as-of resolver. pond owns the date axis + the `atOrBefore` search (exactly
 * the effective-dated lookup — no hand-rolled binary search); the rich/union
 * payload rides in a key→entry map and is read back by the event's key, which
 * keeps optional/union fields out of pond's scalar columns. Distinct dates win
 * last (a same-day re-edit supersedes); empty → always `undefined`.
 */
function asOfSeries<T extends { at: string }>(
  name: string,
  entries: T[],
): AsOf<T> {
  if (entries.length === 0) return { at: () => undefined };
  // dedupe by ms (last wins), then sort ascending — pond requires non-decreasing keys.
  const byMs = new Map<number, T>();
  for (const e of entries) {
    const ms = Date.parse(e.at);
    if (Number.isFinite(ms)) byMs.set(ms, e);
  }
  const sorted = [...byMs.keys()].sort((a, b) => a - b);
  if (sorted.length === 0) return { at: () => undefined };
  const series = new TimeSeries({
    name,
    schema: AS_OF_SCHEMA,
    rows: sorted.map((ms, i): [number, number] => [ms, i]),
  });
  return {
    at(dateUtc: string): T | undefined {
      const ms = Date.parse(dateUtc);
      if (!Number.isFinite(ms)) return undefined;
      const ev = series.atOrBefore(new Time(ms));
      return ev ? byMs.get(ev.begin()) : undefined;
    },
  };
}

/** A profile hydrated into as-of resolvers — built once per activity render. */
export interface HydratedProfile {
  weightKg: AsOf<ScalarEntry>;
  ftpWatts: AsOf<ScalarEntry>;
  hrZone: AsOf<HrZoneEntry>;
  paceThreshold: AsOf<PaceThresholdEntry>;
}

/** Lift the vault JSON into pond-backed as-of resolvers. */
export function hydrateProfile(json: AthleteProfileJson): HydratedProfile {
  return {
    weightKg: asOfSeries('weightKg', json.weightKg ?? []),
    ftpWatts: asOfSeries('ftpWatts', json.ftpWatts ?? []),
    hrZone: asOfSeries('hrZone', json.hrZone ?? []),
    paceThreshold: asOfSeries('paceThreshold', json.paceThreshold ?? []),
  };
}

/** Resolve every series to the values in force on `activityDateUtc`, deriving
 *  the HR + pace zone schemes. The one call the analytics layer makes.
 *  Note: bare-date entries (`"2026-03-01"`) parse to UTC midnight, so an
 *  activity timestamped late on the prior day in a positive UTC offset can pick
 *  up a same-dated change a local day "early". Immaterial for a step-function
 *  config series; use full datetimes in `at` if you need finer alignment. */
export function profileAsOf(
  json: AthleteProfileJson,
  activityDateUtc: string,
): ResolvedProfile {
  const h = hydrateProfile(json);
  const weight = h.weightKg.at(activityDateUtc)?.value;
  const ftp = h.ftpWatts.at(activityDateUtc)?.value;
  const hr = h.hrZone.at(activityDateUtc);
  const pace = h.paceThreshold.at(activityDateUtc);
  const resolved: ResolvedProfile = {};
  if (typeof weight === 'number') resolved.weightKg = weight;
  if (typeof ftp === 'number') resolved.ftpWatts = ftp;
  if (hr) {
    if ('bounds' in hr) resolved.hrZones = hrZonesFrom({ bounds: hr.bounds });
    else if (typeof hr.maxHr === 'number')
      resolved.hrZones = hrZonesFrom({ maxHr: hr.maxHr });
  }
  if (pace && typeof pace.fiveKSeconds === 'number')
    resolved.paceZones = paceZonesFrom(pace.fiveKSeconds);
  return resolved;
}
