/**
 * `@pond-ts/fit/views` (RFC §8): activity data shaped for a screen, kept
 * apart from the numbers. `chartData` gives a pond series that
 * `@pond-ts/charts` draws directly, over time or over distance; `mapData`
 * gives a route's line at the detail a map needs.
 */
import { TimeSeries, type ValueSeries } from 'pond-ts';
import type { Section } from '../activity/activity.js';
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

/** The columns of a chart series: time, distance (metres from the start;
 *  empty with no distance)
 *  and one column per metric, each with gaps where nothing was recorded.
 *  Units: bpm, W, rpm, m/s, s/km, m. */
export const CHART_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'distance', kind: 'number', required: false },
  { name: 'heartRate', kind: 'number', required: false },
  { name: 'power', kind: 'number', required: false },
  { name: 'cadence', kind: 'number', required: false },
  { name: 'speed', kind: 'number', required: false },
  { name: 'pace', kind: 'number', required: false },
  { name: 'elevation', kind: 'number', required: false },
] as const;

export type ChartSeries = TimeSeries<typeof CHART_SCHEMA>;

export interface ChartDataOptions {
  /** `'time'` (the default) keys by the sample's instant; `'distance'` by
   *  metres from the start. */
  x?: 'time' | 'distance';
  /** The metrics to fill; the rest stay empty. Default: every one the
   *  activity recorded. */
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
  const speed = s.speed?.values();
  const cols: Record<ChartMetric, Float64Array | undefined> = {
    heartRate: s.heartRate?.values(),
    power: s.power?.values(),
    cadence: s.cadence?.values(),
    speed,
    pace: speed?.map((v) => (v >= MIN_PACE_SPEED ? 1000 / v : NaN)),
    elevation: s.elevation?.values(),
  };
  const all: ChartMetric[] = [
    'heartRate',
    'power',
    'cadence',
    'speed',
    'pace',
    'elevation',
  ];
  const asked = options.metrics ?? all;
  const metrics = asked.filter((m) => cols[m]?.some(Number.isFinite));
  const n = t.length;
  const empty = () => new Float64Array(n).fill(NaN);
  // one column per field, handed to pond as is: a NaN is a missing cell
  const series = TimeSeries.fromColumns({
    name: 'chart',
    schema: CHART_SCHEMA,
    columns: {
      time: t.instants(),
      distance: s.distance?.values() ?? empty(),
      heartRate: empty(),
      power: empty(),
      cadence: empty(),
      speed: empty(),
      pace: empty(),
      elevation: empty(),
      ...Object.fromEntries(metrics.map((m) => [m, cols[m]!])),
    },
  });
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
