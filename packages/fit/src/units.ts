/** Display-edge unit conversion. The model stores SI; UI converts here. */

export const METERS_PER_MILE = 1609.344;
export const METERS_PER_FOOT = 0.3048;

export const metersToMiles = (m: number): number => m / METERS_PER_MILE;
export const metersToFeet = (m: number): number => m / METERS_PER_FOOT;

/** Seconds → "h:mm:ss" or "m:ss". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ── Per-quantity unit preferences ───────────────────────────────────────────
// Four independent axes. Distance and elevation are decoupled on purpose:
// trail runners often think in miles but climb in metres. Speed and pace share
// one axis (imperial ⇒ mph + min/mi; metric ⇒ km/h + min/km) since they're the
// same measurement shown two ways.

export type DistanceUnit = 'mi' | 'km';
export type ElevationUnit = 'ft' | 'm';
export type TemperatureUnit = 'F' | 'C';
export type SpeedPaceUnit = 'imperial' | 'metric';

export interface UnitPreferences {
  distance: DistanceUnit;
  elevation: ElevationUnit;
  temperature: TemperatureUnit;
  speedPace: SpeedPaceUnit;
}

/** US defaults — the archive's origin. Each axis is independently overridable. */
export const DEFAULT_UNITS: UnitPreferences = {
  distance: 'mi',
  elevation: 'ft',
  temperature: 'F',
  speedPace: 'imperial',
};

/** Distance: metres → display number in the chosen unit. */
export function convertDistance(meters: number, unit: DistanceUnit): number {
  return unit === 'km' ? meters / 1000 : metersToMiles(meters);
}

/** Elevation: metres → display number in the chosen unit. */
export function convertElevation(meters: number, unit: ElevationUnit): number {
  return unit === 'm' ? meters : metersToFeet(meters);
}

/** Temperature: °C → display number in the chosen unit. */
export function convertTemperature(
  celsius: number,
  unit: TemperatureUnit,
): number {
  return unit === 'F' ? celsius * 1.8 + 32 : celsius;
}

/** Speed: m/s → display number (mph or km/h). */
export function convertSpeed(
  metersPerSecond: number,
  unit: SpeedPaceUnit,
): number {
  return unit === 'metric' ? metersPerSecond * 3.6 : metersPerSecond * 2.236936;
}

/** The label shown next to a converted value, e.g. for axis ticks / stat tiles. */
export function distanceUnitLabel(unit: DistanceUnit): string {
  return unit;
}
export function elevationUnitLabel(unit: ElevationUnit): string {
  return unit;
}
export function temperatureUnitLabel(unit: TemperatureUnit): string {
  return unit === 'F' ? '°F' : '°C';
}
export function speedUnitLabel(unit: SpeedPaceUnit): string {
  return unit === 'metric' ? 'km/h' : 'mph';
}
export function paceUnitLabel(unit: SpeedPaceUnit): string {
  return unit === 'metric' ? '/km' : '/mi';
}

/**
 * Seconds-per-kilometre → "m:ss/km" (default) or "m:ss/mi" when `unit` is
 * imperial. Rounds total seconds *first* then splits, so a pace rounding up to
 * a full minute carries (119.88 → "2:00/km", never "1:60/km"). Same
 * round-then-split discipline as {@link formatDuration}.
 */
export function formatPace(
  secondsPerKm: number,
  unit: SpeedPaceUnit = 'metric',
): string {
  const perUnit =
    unit === 'imperial'
      ? secondsPerKm * (METERS_PER_MILE / 1000)
      : secondsPerKm;
  const s = Math.round(perUnit);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}${paceUnitLabel(unit)}`;
}
