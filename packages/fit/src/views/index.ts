/**
 * `@pond-ts/fit/views` (RFC §8): activity data shaped for a screen, kept
 * apart from the numbers. `chartData` gives a pond series that
 * `@pond-ts/charts` draws directly, over time or over distance; `mapData`
 * gives a route's line at the detail a map needs.
 */
import type { TimeSeries, ValueSeries } from 'pond-ts';
import { preparedOf, type Section } from '../activity/activity.js';
import { sampleRange } from '../activity/series.js';
import type { LatLng, Route } from '../activity/route.js';
import { simplify, haversineMeters } from '../geo/index.js';

/** What a chart can plot. Pace is seconds per kilometre. */
export type ChartMetric =
  | 'heartRate'
  | 'power'
  | 'cadence'
  | 'speed'
  | 'pace'
  | 'elevation';

/** The columns of a chart series: time, one column per metric, and
 *  distance (metres from the start; empty with no distance). A column has
 *  gaps where nothing was recorded, and is all gaps for a channel the
 *  activity didn't record. Units: bpm, W, rpm, m, m, m/s, s/km. */
export const CHART_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'heartRate', kind: 'number', required: false },
  { name: 'power', kind: 'number', required: false },
  { name: 'cadence', kind: 'number', required: false },
  { name: 'elevation', kind: 'number', required: false },
  { name: 'distance', kind: 'number', required: false },
  { name: 'speed', kind: 'number', required: false },
  { name: 'pace', kind: 'number', required: false },
] as const;

export type ChartSeries = TimeSeries<typeof CHART_SCHEMA>;

export interface ChartDataOptions {
  /** `'time'` (the default) keys by the sample's instant; `'distance'` by
   *  metres from the start. */
  x?: 'time' | 'distance';
  /** The metrics to draw, as listed in the result's `metrics`. The series
   *  carries every channel either way. Default: every one the activity
   *  recorded. */
  metrics?: readonly ChartMetric[];
}

export interface ChartData<X> {
  series: X;
  /** The metrics that have values, in the order asked for. */
  metrics: ChartMetric[];
}

/** Below this speed a pace is no pace (standing still). */
const MIN_PACE_SPEED = 0.5;

/**
 * The samples of a section (or a whole activity) as one series for a chart.
 * Throws a `RangeError` for a recording with no timestamps, or for
 * `x: 'distance'` on one with no distance.
 */
export function chartData(
  section: Section,
  options: ChartDataOptions & { x: 'distance' },
): ChartData<ValueSeries<any>>;
export function chartData(
  section: Section,
  options?: ChartDataOptions & { x?: 'time' },
): ChartData<ChartSeries>;
export function chartData(
  section: Section,
  options: ChartDataOptions = {},
): ChartData<ChartSeries | ValueSeries<any>> {
  const s = section.series;
  const t = s.distance ?? s.heartRate ?? s.power ?? s.cadence ?? s.elevation;
  if (!t) throw new RangeError('chartData: the recording has no timestamps');
  const x = options.x ?? 'time';
  if (x === 'distance' && !s.distance)
    throw new RangeError('chartData: the recording has no distance');
  const prep = preparedOf(section);
  const [lo, hi] = sampleRange(prep, section);
  const n = hi - lo;
  const empty = () => new Float64Array(n).fill(NaN);
  const speed = s.speed ? prep.speed.subarray(lo, hi) : empty();
  const pace = speed.map((v) => (v >= MIN_PACE_SPEED ? 1000 / v : NaN));
  const has: Record<ChartMetric, boolean> = {
    heartRate: !!s.heartRate,
    power: !!s.power,
    cadence: !!s.cadence,
    speed: !!s.speed,
    pace: pace.some(Number.isFinite),
    elevation: !!s.elevation,
  };
  const all: ChartMetric[] = [
    'heartRate',
    'power',
    'cadence',
    'speed',
    'pace',
    'elevation',
  ];
  const metrics = (options.metrics ?? all).filter((m) => has[m]);
  // The recorded channels are the activity's own pond columns, sliced to
  // the section: a view, nothing copied. Distance, speed and pace are
  // worked out from the samples, so they are attached as columns (NaN is a
  // gap); distance and speed share the activity's arrays too.
  const series = prep.track
    .slice(lo, hi)
    .select('hr', 'power', 'cadence', 'ele')
    .rename({ hr: 'heartRate', ele: 'elevation' })
    .withColumn('distance', s.distance ? prep.cum.subarray(lo, hi) : empty())
    .withColumn('speed', speed)
    .withColumn('pace', pace) as unknown as ChartSeries;
  return {
    series: x === 'distance' ? series.byValue('distance') : series,
    metrics,
  };
}

export interface MapDataOptions {
  /** `'full'` (the default) every point; `'thumbnail'` a line simplified
   *  to about 1/200 of the route's size, for a small map; or a tolerance in
   *  metres. */
  detail?: 'full' | 'thumbnail' | number;
}

export interface MapData {
  points: LatLng[];
  bounds: { southWest: LatLng; northEast: LatLng };
}

/** A route's line at the detail a map needs, and its bounds. */
export function mapData(route: Route, options: MapDataOptions = {}): MapData {
  const detail = options.detail ?? 'full';
  const pts = route.points as ReadonlyArray<[number, number]>;
  const { southWest: sw, northEast: ne } = route.bounds;
  let tol = 0;
  if (detail === 'thumbnail')
    tol = haversineMeters(sw[0], sw[1], ne[0], ne[1]) / 200;
  else if (typeof detail === 'number') {
    if (!(detail >= 0)) throw new RangeError('mapData: detail must be ≥ 0');
    tol = detail;
  }
  return {
    points: tol > 0 ? simplify(pts, tol) : pts.map((p) => [p[0], p[1]]),
    bounds: route.bounds,
  };
}
