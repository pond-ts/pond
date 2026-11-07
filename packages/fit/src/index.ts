export type {
  GeoPoint,
  ActivitySource,
  ActivityStreams,
  ActivityMeta,
  Lap,
  ImportedActivity,
  SwimData,
  SwimLength,
  HeartRateRecovery,
  FileCreator,
} from './types.js';
export { swimMovingSeconds } from './swim.js';

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
  meters,
  km,
  miles,
  yards,
  seconds,
  minutes,
  hours,
} from './quantities.js';
export {
  Activity,
  Section,
  LapSection,
  Sections,
  PoolSwim,
  LengthSection,
  RestSection,
  RepeatSection,
  RecoverySection,
  Analysis,
  PowerEfforts,
  PaceEfforts,
  Aerobic,
  Measured,
  Route,
  sportOf,
} from './activity/index.js';
export type {
  Sport,
  MovingRule,
  Pool,
  SwimSegment,
  RepeatSource,
  Stats,
  StatsOptions,
  TimeBasis,
  Clocks,
  SectionBounds,
  SectionRange,
  SectionKind,
  AnalyzeOptions,
  AthleteInput,
  PowerAnalysis,
  Load,
  ZoneAnalysis,
  PowerBestEffort,
  PaceBestEffort,
  AerobicOutput,
  EfficiencyOptions,
  Efficiency,
  DecouplingOptions,
  Decoupling,
  DecouplingCaution,
  DistributionChannel,
  DistributionOptions,
  DistributionBin,
  Distribution,
  Coasting,
  RunningDynamics,
  RunningDynamicsStats,
  DynamicsChannel,
  DynamicsSource,
  ActivitySeries,
  SeriesChannel,
  SeriesPoint,
  LatLng,
  ActivityEdit,
  EditChange,
  Explainable,
  Explanation,
} from './activity/index.js';
export { Track } from './track/index.js';

// Curated flat surface — the four operator modules (geo / power / zones /
// profile) are NOT re-exported as blanket `export * as <module>` namespaces.
// Those published each module's entire internal surface (readColumns, raw
// schemas, friction-probe helpers) by accident and had no shipping consumer.
// The named exports below are the deliberate public API. Quantities, the
// Activity/Section model, Track, Profile, and the units helpers are kept by
// intent — the library's headline surface plus the façade's return-type
// closure — not because any single consumer imports them today.
export {
  polylineCumulative,
  interpolateAtDistance,
  polylineSlice,
  boundsOf,
  bestEffortsByDistance,
  segmentsInRange,
  lineDistanceAt,
  lineRange,
  haversineMeters,
  elevationGainLoss,
  movingTimeSeconds,
  MOVING_SPEED_MPS,
  CLIMB_THRESHOLD_METERS,
} from './geo/index.js';
export type { Segment, GpsSpan } from './geo/index.js';
export {
  computePower,
  powerBestEfforts,
  normalizedPower,
} from './power/index.js';
export {
  sectionStats,
  sectionGroupStats,
  bestAveragePower,
  movingClock,
  STAT_CHANNELS,
} from './stats/index.js';
export type {
  Span,
  StatChannel,
  ChannelStats,
  SectionStats,
  GroupChannelStats,
  SectionGroupStats,
  MovingClock,
} from './stats/index.js';
export type {
  PowerBin,
  PowerZone,
  PowerCurvePoint,
  PowerSummary,
  PowerEffort,
  ComputePowerOptions,
} from './power/index.js';

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
  trackLine,
  buildTrackFromStreams,
  type ActivitySummary,
  type ActivitySummaryOptions,
  type PreparedActivity,
  type WindowChannelOptions,
  type ChannelKey,
  type ChannelProfile,
  type ChannelSample,
} from './summary/index.js';
export {
  findBreaks,
  slowCutOff,
  pastBreaks,
  breakTrend,
  trendRefBpm,
  BREAK_OFFSETS,
  BREAKS_VERSION,
  TREND_DAYS,
  TREND_MIN_BREAKS,
  recoveryAt,
  recoveryFromReadings,
  recoverySummary,
  twoMinuteDrop,
  RECOVERY_MAX_SECONDS,
  COMPARE_SECONDS,
} from './recovery/index.js';
export type {
  BreakKind,
  RunBreak,
  BreakStreams,
  PastBreak,
  BreakTrend,
  BreakTrendPoint,
  RecoveryReading,
} from './recovery/index.js';

export {
  editRecording,
  isEmptyEdit,
  recordingSeconds,
  lapStartSeconds,
  editedLapStarts,
  type RecordingEdit,
} from './edit/index.js';

export {
  trackShape,
  trackStart,
  isUsableFix,
  simplifyToPoints,
  trackLevels,
  levelFor,
  encodePolyline,
  decodePolyline,
  OUTLINE_POINTS,
  LEVEL_METRES,
  type TrackShape,
  type TrackLevel,
} from './outline/index.js';
export {
  groupLaps,
  hasLapGroups,
  summarizeLaps,
  lapSpeed,
  lapExtremes,
} from './laps/groups.js';
export type {
  GroupLap,
  LapGroup,
  LapAverages,
  LapsSummary,
  LapExtremes,
} from './laps/groups.js';
