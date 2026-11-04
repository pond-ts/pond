/**
 * The slice of `fit-file-parser` the FIT reader uses, typed locally so the
 * published types don't depend on the parser's own (its fields are `any`).
 */
import FitParser from 'fit-file-parser';

export interface FitRecord {
  timestamp?: Date | string;
  position_lat?: number;
  position_long?: number;
  altitude?: number;
  enhanced_altitude?: number;
  heart_rate?: number;
  cadence?: number;
  power?: number;
  temperature?: number;
  distance?: number;
  speed?: number;
  [key: string]: unknown;
}

/** A recorded lap (auto-lap or button press). Units follow the parser
 *  options below (m/s, m, celsius); work is joules, calories kcal. */
export interface FitLap {
  start_time?: Date | string;
  timestamp?: Date | string;
  total_elapsed_time?: number;
  total_timer_time?: number;
  total_distance?: number;
  avg_speed?: number;
  max_speed?: number;
  avg_power?: number;
  max_power?: number;
  avg_heart_rate?: number;
  max_heart_rate?: number;
  total_work?: number;
  total_calories?: number;
  total_ascent?: number;
  [key: string]: unknown;
}

/** A decoded FIT file, in the parser's `list` mode. */
export interface FitData {
  records?: FitRecord[];
  laps?: FitLap[];
  [key: string]: unknown;
}

/** Decode FIT bytes (the parser's callback runs synchronously). Throws when
 *  the bytes don't decode. */
export function parseFitBytes(buffer: ArrayBuffer | Uint8Array): FitData {
  const fp = new FitParser({
    speedUnit: 'm/s',
    lengthUnit: 'm',
    temperatureUnit: 'celsius',
    mode: 'list',
  });
  let data: FitData | undefined;
  let error: unknown = null;
  fp.parse(buffer as ArrayBuffer, (err: unknown, d: unknown) => {
    error = err;
    data = d as FitData;
  });
  if (error || !data)
    throw new Error(`FIT parse failed: ${String(error ?? 'no data')}`);
  return data;
}
