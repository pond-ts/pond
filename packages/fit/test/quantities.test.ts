import { describe, it, expect } from 'vitest';
import {
  Distance,
  Elevation,
  Duration,
  Speed,
  Pace,
  Power,
  HeartRate,
  Cadence,
} from '../src/index.js';

describe('Distance', () => {
  it('round-trips metres / km / miles', () => {
    expect(Distance.meters(1609.344).miles).toBeCloseTo(1, 9);
    expect(Distance.miles(1).meters).toBeCloseTo(1609.344, 6);
    expect(Distance.km(5).meters).toBe(5000);
    expect(Distance.km(5).miles).toBeCloseTo(3.10686, 4);
    expect(Distance.miles(26.2188).km).toBeCloseTo(42.195, 3); // marathon
  });
});

describe('Elevation', () => {
  it('round-trips metres / feet (not mi/km)', () => {
    expect(Elevation.feet(1000).meters).toBeCloseTo(304.8, 6);
    expect(Elevation.meters(304.8).feet).toBeCloseTo(1000, 6);
  });
});

describe('Duration', () => {
  it('round-trips + formats h:mm:ss / m:ss', () => {
    expect(Duration.minutes(90).seconds).toBe(5400);
    expect(Duration.hours(1).minutes).toBe(60);
    expect(Duration.minutes(90).format()).toBe('1:30:00');
    expect(Duration.seconds(125).format()).toBe('2:05');
  });
});

describe('Speed / Pace (inverse views)', () => {
  it('round-trips m/s / km/h / mph', () => {
    expect(Speed.kmh(36).metersPerSecond).toBeCloseTo(10, 9);
    expect(Speed.metersPerSecond(10).kmh).toBeCloseTo(36, 9);
    expect(Speed.mph(10).metersPerSecond).toBeCloseTo(4.4704, 4);
    expect(Speed.metersPerSecond(4.4704).mph).toBeCloseTo(10, 4);
  });
  it('speed ↔ pace are consistent', () => {
    // 10 km/h = 2.7778 m/s → 6:00/km
    const pace = Speed.kmh(10).pace();
    expect(pace.secondsPerKm).toBeCloseTo(360, 3);
    expect(pace.format('metric')).toBe('6:00/km');
    expect(pace.speed().kmh).toBeCloseTo(10, 6); // round-trips back
  });
  it('formats pace per mile / km off a speed', () => {
    // 1 mile in 8:00 → 8:00/mi
    const speed = Pace.secondsPerMile(480).speed();
    expect(speed.asMinsPerMile()).toBe('8:00/mi');
  });
  it('Pace round-trips secondsPerMile / secondsPerKm', () => {
    expect(Pace.secondsPerMile(480).secondsPerMile).toBeCloseTo(480, 6);
    expect(Pace.secondsPerKm(300).secondsPerMile).toBeCloseTo(482.803, 2);
  });
  it('guards the zero/∞ edges symmetrically', () => {
    expect(Speed.metersPerSecond(0).pace().secondsPerKm).toBe(Infinity); // stopped → ∞ pace
    expect(Pace.secondsPerKm(Infinity).speed().metersPerSecond).toBe(0); // ∞ pace → stopped
    expect(Pace.secondsPerKm(0).speed().metersPerSecond).toBe(Infinity); // 0 pace → ∞ fast
  });
});

describe('Power / HeartRate / Cadence', () => {
  it('Power carries watts + W/kg', () => {
    expect(Power.watts(280).watts).toBe(280);
    expect(Power.watts(280).perKg(70)).toBeCloseTo(4, 9);
    expect(Number.isNaN(Power.watts(280).perKg(0))).toBe(true);
  });
  it('HeartRate / Cadence are thin bpm / rpm wrappers', () => {
    expect(HeartRate.bpm(154).bpm).toBe(154);
    expect(Cadence.rpm(90).rpm).toBe(90);
  });
});
