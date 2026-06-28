import { describe, it, expect } from 'vitest';
import {
  metersToMiles,
  metersToFeet,
  formatDuration,
  formatPace,
  convertDistance,
  convertElevation,
  convertTemperature,
  convertSpeed,
  speedUnitLabel,
  temperatureUnitLabel,
} from '../src/units.js';

describe('units', () => {
  it('converts meters to miles and feet', () => {
    expect(metersToMiles(1609.344)).toBeCloseTo(1, 6);
    expect(metersToFeet(0.3048)).toBeCloseTo(1, 6);
    expect(metersToMiles(0)).toBe(0);
  });

  it('formats durations as h:mm:ss or m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(2783)).toBe('46:23'); // 46m 23s
    expect(formatDuration(6545)).toBe('1:49:05'); // 1h 49m 05s
  });

  it('formats pace as m:ss/km and carries the :60 rollover', () => {
    expect(formatPace(307)).toBe('5:07/km');
    expect(formatPace(146)).toBe('2:26/km');
    // the bug that shipped: 119.88 s/km must round to 2:00, never 1:60
    expect(formatPace(119.88)).toBe('2:00/km');
    expect(formatPace(59.6)).toBe('1:00/km');
    expect(formatPace(0)).toBe('0:00/km');
  });

  it('formats pace in /mi when imperial (and still carries the rollover)', () => {
    // 300 s/km × 1.609344 km/mi = 482.8 s/mi → 8:03/mi
    expect(formatPace(300, 'imperial')).toBe('8:03/mi');
    expect(formatPace(300, 'metric')).toBe('5:00/km');
    // rollover holds after the mile scaling too
    expect(formatPace(372.84, 'imperial')).toBe('10:00/mi'); // 372.84×1.609344 = 599.98
  });

  it('converts per-quantity to the chosen unit', () => {
    expect(convertDistance(1609.344, 'mi')).toBeCloseTo(1, 6);
    expect(convertDistance(1000, 'km')).toBeCloseTo(1, 6);
    expect(convertElevation(0.3048, 'ft')).toBeCloseTo(1, 6);
    expect(convertElevation(100, 'm')).toBe(100);
    expect(convertTemperature(0, 'F')).toBeCloseTo(32, 6);
    expect(convertTemperature(100, 'F')).toBeCloseTo(212, 6);
    expect(convertTemperature(20, 'C')).toBe(20);
    expect(convertSpeed(10, 'metric')).toBeCloseTo(36, 6); // 10 m/s = 36 km/h
    expect(convertSpeed(10, 'imperial')).toBeCloseTo(22.369, 2); // 10 m/s ≈ 22.37 mph
    expect(speedUnitLabel('metric')).toBe('km/h');
    expect(temperatureUnitLabel('C')).toBe('°C');
  });
});
