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

describe('formatting (.in / .format — the display edge)', () => {
  it('Distance: dynamic-unit value + labelled string', () => {
    const d = Distance.km(42.195); // marathon
    expect(d.in('km')).toBeCloseTo(42.195, 6);
    expect(d.in('mi')).toBeCloseTo(26.2188, 3);
    expect(d.format('km')).toBe('42.20 km');
    expect(d.format('mi', 1)).toBe('26.2 mi');
  });
  it('Elevation: feet default 0 decimals', () => {
    const e = Elevation.meters(304.8);
    expect(e.in('ft')).toBeCloseTo(1000, 6);
    expect(e.format('ft')).toBe('1000 ft');
    expect(e.format('m', 1)).toBe('304.8 m');
  });
  it('Speed: mph / km/h with label', () => {
    const s = Speed.metersPerSecond(10);
    expect(s.in('metric')).toBeCloseTo(36, 6);
    expect(s.format('metric')).toBe('36.0 km/h');
    expect(s.format('imperial')).toBe('22.4 mph');
  });
  it('Power / HeartRate / Cadence: single-unit strings', () => {
    expect(Power.watts(291.4).format()).toBe('291 W');
    expect(HeartRate.bpm(152).format()).toBe('152 bpm');
    expect(Cadence.rpm(90).format()).toBe('90 rpm');
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
