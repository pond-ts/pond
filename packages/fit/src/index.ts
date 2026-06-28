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
export {
  Activity,
  Section,
  ProfiledActivity,
  ProfiledSection,
} from './activity/index.js';
export type { Sample, SectionMetrics } from './activity/index.js';

export * as geo from './geo/index.js';
export {
  polylineCumulative,
  interpolateAtDistance,
  polylineSlice,
  boundsOf,
  bestEffortsByDistance,
  segmentsInRange,
} from './geo/index.js';
export type { Segment } from './geo/index.js';
export * as power from './power/index.js';
export { computePower, powerBestEfforts } from './power/index.js';
export type {
  PowerBin,
  PowerZone,
  PowerCurvePoint,
  PowerSummary,
  PowerEffort,
} from './power/index.js';

export * as profile from './profile/index.js';
export {
  Profile,
  hydrateProfile,
  profileAsOf,
  hrZonesFrom,
  paceZonesFrom,
  powerZonesFrom,
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

export * as zones from './zones/index.js';
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
