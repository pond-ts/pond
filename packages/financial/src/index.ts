export type {
  DiscontinuityProvider,
  LiveSegment,
} from './calendar/discontinuity.js';
export {
  identityDiscontinuity,
  weekendSkip,
  segmentDiscontinuity,
} from './calendar/discontinuity.js';

export type { Session, SessionBreak } from './calendar/session.js';
export { normalizeSessions } from './calendar/session.js';
export type { SessionRules, DateRange } from './calendar/rules.js';
export { generateSessions } from './calendar/rules.js';
export type {
  InstantRange,
  TaggedSchema,
} from './calendar/trading-calendar.js';
export { TradingCalendar } from './calendar/trading-calendar.js';

// --- Market analytics: studies (batch, TimeSeries → TimeSeries + columns) ---
export type { OhlcvColumns } from './contract/columns.js';
export { DEFAULT_OHLCV, DEFAULT_SOURCE } from './contract/columns.js';
export type { RollingReducer } from './kernels/rolling.js';
export type { MovingAverageOptions } from './studies/moving-average.js';
export { sma, ema } from './studies/moving-average.js';
export type { BollingerOptions } from './studies/bollinger.js';
export { bollinger } from './studies/bollinger.js';
export type {
  RollingStatOptions,
  RollingPercentileOptions,
} from './studies/rolling-stat.js';
export {
  rollingStdev,
  rollingMin,
  rollingMax,
  rollingPercentile,
} from './studies/rolling-stat.js';
export type { ZScoreOptions } from './studies/z-score.js';
export { zScore } from './studies/z-score.js';
export type { EnvelopeOptions } from './studies/envelope.js';
export { envelope } from './studies/envelope.js';
export type { PercentChangeOptions } from './studies/percent-change.js';
export { percentChange } from './studies/percent-change.js';
