export type {
  GeoPoint,
  ActivitySource,
  ActivityStreams,
  ActivityMeta,
  Lap,
  ImportedActivity,
} from './types.js';

export {
  metersToMiles,
  metersToFeet,
  formatDuration,
  formatPace,
  DEFAULT_UNITS,
  convertDistance,
  convertElevation,
  convertTemperature,
  convertSpeed,
  distanceUnitLabel,
  elevationUnitLabel,
  temperatureUnitLabel,
  speedUnitLabel,
  paceUnitLabel,
} from './units.js';
export type {
  UnitPreferences,
  DistanceUnit,
  ElevationUnit,
  TemperatureUnit,
  SpeedPaceUnit,
} from './units.js';
export {
  Distance,
  Elevation,
  Duration,
  Speed,
  Pace,
  Power,
  HeartRate,
  Cadence,
} from './quantities.js';
export { Activity, Section } from './activity/index.js';
export type { Sample, SectionMetrics } from './activity/index.js';

// Curated flat surface — the four operator modules (geo / power / zones /
// profile) are NOT re-exported as blanket `export * as <module>` namespaces.
// Those published each module's entire internal surface (readColumns, raw
// schemas, friction-probe helpers) by accident and had no shipping consumer.
// The named exports below are the deliberate public API. Quantities, the
// Activity/Section façade, and the units helpers are kept by intent — the
// library's headline surface plus the façade's return-type closure — not
// because any single consumer imports them today.
export {
  polylineCumulative,
  interpolateAtDistance,
  polylineSlice,
  boundsOf,
  bestEffortsByDistance,
  segmentsInRange,
} from './geo/index.js';
export type { Segment } from './geo/index.js';
export { computePower, powerBestEfforts } from './power/index.js';
export type {
  PowerBin,
  PowerZone,
  PowerCurvePoint,
  PowerSummary,
  PowerEffort,
} from './power/index.js';

export {
  hydrateProfile,
  profileAsOf,
  hrZonesFrom,
  paceZonesFrom,
} from './profile/index.js';
export type {
  AthleteProfileJson,
  ScalarEntry,
  HrZoneEntry,
  PaceThresholdEntry,
  ZoneDef,
  ResolvedProfile,
  HydratedProfile,
} from './profile/index.js';

export {
  zoneDistributionByValue,
  hrZoneDistribution,
  paceZoneDistribution,
} from './zones/index.js';
export type { ZoneTime } from './zones/index.js';
export type {
  TrackSeries,
  TrackPoint,
  TrackColumns,
  Split,
  ProfilePoint,
  ProfileSample,
  DistanceEffort,
} from './geo/index.js';
export {
  computeActivitySummary,
  prepareActivity,
  summaryFromPrepared,
  windowChannels,
  buildTrackFromStreams,
  type ActivitySummary,
  type ActivitySummaryOptions,
  type PreparedActivity,
  type WindowChannelOptions,
  type ChannelKey,
  type ChannelProfile,
  type ChannelSample,
} from './summary/index.js';
