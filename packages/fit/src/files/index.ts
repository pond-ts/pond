/**
 * `@pond-ts/fit/files` — read activity files: FIT (binary, via
 * `fit-file-parser`), GPX and TCX (regex, no DOM) into an
 * {@link ImportedActivity}, ready for `Activity.fromStreams`. A separate entry
 * so the FIT decoder only ships to consumers that read files.
 */
export {
  parseFit,
  fitSport,
  fitSubSport,
  fitLocalStart,
  fitSwim,
} from './fit.js';
export { parseGpx } from './gpx.js';
export { parseTcx } from './tcx.js';
export {
  fitRecovery,
  fitRecoveryFromBytes,
  recoveryFromFitReadings,
  RECOVERY_MAX_SECONDS,
} from './recovery.js';
export { parseFitBytes } from './fitParser.js';
export type { FitData, FitRecord, FitLap } from './fitParser.js';
export type { ReadOptions } from './options.js';
