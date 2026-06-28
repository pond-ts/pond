/**
 * Fitness quantity types — the ergonomic, unit-safe value layer of the activity
 * domain.
 *
 * Each is an immutable value object holding ONE canonical SI number, with
 * unit-named constructors in / accessors out — so a function returns a `Speed`
 * and the caller asks it `.asMinsPerMile()`, never juggling "is this m or mi?".
 * Conversion math + formatting reuse `units.ts` (one source of truth); these
 * types are the fluent face over it. Fitness-relevant set only — not a general
 * dimensional-analysis system.
 */
import {
  METERS_PER_MILE,
  METERS_PER_FOOT,
  formatDuration,
  formatPace,
  type SpeedPaceUnit,
} from './units.js';

/** A length — canonical metres. */
export class Distance {
  private constructor(readonly meters: number) {}
  static meters(m: number): Distance {
    return new Distance(m);
  }
  static km(km: number): Distance {
    return new Distance(km * 1000);
  }
  static miles(mi: number): Distance {
    return new Distance(mi * METERS_PER_MILE);
  }
  get km(): number {
    return this.meters / 1000;
  }
  get miles(): number {
    return this.meters / METERS_PER_MILE;
  }
}

/** A climb/altitude — canonical metres, shown in feet or metres (a separate type
 *  from {@link Distance} because elevation reads in ft/m, not mi/km). */
export class Elevation {
  private constructor(readonly meters: number) {}
  static meters(m: number): Elevation {
    return new Elevation(m);
  }
  static feet(ft: number): Elevation {
    return new Elevation(ft * METERS_PER_FOOT);
  }
  get feet(): number {
    return this.meters / METERS_PER_FOOT;
  }
}

/** An elapsed time — canonical seconds. */
export class Duration {
  private constructor(readonly seconds: number) {}
  static seconds(s: number): Duration {
    return new Duration(s);
  }
  static minutes(m: number): Duration {
    return new Duration(m * 60);
  }
  static hours(h: number): Duration {
    return new Duration(h * 3600);
  }
  get minutes(): number {
    return this.seconds / 60;
  }
  get hours(): number {
    return this.seconds / 3600;
  }
  /** "h:mm:ss" / "m:ss". */
  format(): string {
    return formatDuration(this.seconds);
  }
}

/** A speed — canonical metres/second. The inverse view is {@link Pace}. */
export class Speed {
  private constructor(readonly metersPerSecond: number) {}
  static metersPerSecond(v: number): Speed {
    return new Speed(v);
  }
  static kmh(v: number): Speed {
    return new Speed(v / 3.6);
  }
  static mph(v: number): Speed {
    return new Speed(v / 2.236936);
  }
  get kmh(): number {
    return this.metersPerSecond * 3.6;
  }
  get mph(): number {
    return this.metersPerSecond * 2.236936;
  }
  /** As pace (time per distance) — the same measurement, shown the other way. */
  pace(): Pace {
    return Pace.secondsPerKm(
      this.metersPerSecond > 0 ? 1000 / this.metersPerSecond : Infinity,
    );
  }
  asMinsPerMile(): string {
    return this.pace().format('imperial');
  }
  asMinsPerKm(): string {
    return this.pace().format('metric');
  }
}

/** A pace — canonical seconds per kilometre. The inverse view is {@link Speed}. */
export class Pace {
  private constructor(readonly secondsPerKm: number) {}
  static secondsPerKm(s: number): Pace {
    return new Pace(s);
  }
  static secondsPerMile(s: number): Pace {
    return new Pace(s / (METERS_PER_MILE / 1000));
  }
  get secondsPerMile(): number {
    return this.secondsPerKm * (METERS_PER_MILE / 1000);
  }
  speed(): Speed {
    const s = this.secondsPerKm;
    // 0 pace = infinitely fast; ∞ pace (stopped) = 0; garbage (negative/NaN) = 0.
    const mps = s > 0 && Number.isFinite(s) ? 1000 / s : s === 0 ? Infinity : 0;
    return Speed.metersPerSecond(mps);
  }
  /** "m:ss/km" (metric, default) or "m:ss/mi" (imperial). */
  format(unit: SpeedPaceUnit = 'metric'): string {
    return formatPace(this.secondsPerKm, unit);
  }
}

/** Mechanical power — canonical watts. */
export class Power {
  private constructor(readonly watts: number) {}
  static watts(w: number): Power {
    return new Power(w);
  }
  /** Power-to-weight (W/kg) given a body weight; NaN for a non-positive weight. */
  perKg(weightKg: number): number {
    return weightKg > 0 ? this.watts / weightKg : NaN;
  }
}

/** Heart rate — canonical beats/minute. */
export class HeartRate {
  private constructor(readonly bpm: number) {}
  static bpm(b: number): HeartRate {
    return new HeartRate(b);
  }
}

/** Cadence — canonical revolutions/minute (pedal strokes, run steps/min, …). */
export class Cadence {
  private constructor(readonly rpm: number) {}
  static rpm(r: number): Cadence {
    return new Cadence(r);
  }
}
