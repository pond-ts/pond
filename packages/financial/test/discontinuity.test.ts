import { describe, it, expect } from 'vitest';
import {
  identityDiscontinuity,
  weekendSkip,
  type DiscontinuityProvider,
} from '../src/index.js';

const DAY = 86_400_000;

// A known UTC frame of reference (all instants are UTC):
//   Fri 2021-01-01, Sat 2021-01-02, Sun 2021-01-03, Mon 2021-01-04.
const FRI = Date.UTC(2021, 0, 1); // 2021-01-01 is a Friday
const SAT = Date.UTC(2021, 0, 2);
const SUN = Date.UTC(2021, 0, 3);
const MON = Date.UTC(2021, 0, 4);
const at = (base: number, hours: number) => base + hours * 3_600_000;

/** Day-stepping brute force: live ms from the Monday anchor, weekends removed. */
function bruteLiveMs(value: number): number {
  const anchor = 4 * DAY; // Monday 1970-01-05
  const dayIndex = Math.floor((value - anchor) / DAY);
  const rem = value - anchor - dayIndex * DAY;
  let liveDays = 0;
  const step = dayIndex >= 0 ? 1 : -1;
  for (let i = 0; i !== dayIndex; i += step) {
    const d = step > 0 ? i : i - 1; // half-open toward 0
    const dow = ((d % 7) + 7) % 7; // 0 = Mon
    if (dow < 5) liveDays += step;
  }
  const dowHere = ((dayIndex % 7) + 7) % 7;
  const isWeekend = dowHere >= 5;
  return liveDays * DAY + (isWeekend ? 0 : rem);
}

describe('identityDiscontinuity', () => {
  const id = identityDiscontinuity();
  it('is a no-op on every method', () => {
    expect(id.clampUp(FRI)).toBe(FRI);
    expect(id.clampDown(FRI)).toBe(FRI);
    expect(id.distance(FRI, MON)).toBe(MON - FRI);
    expect(id.offset(FRI, 5 * DAY)).toBe(FRI + 5 * DAY);
  });
  it('distance is signed and inverts via offset', () => {
    expect(id.distance(MON, FRI)).toBe(-(MON - FRI));
    expect(id.offset(FRI, id.distance(FRI, MON))).toBe(MON);
  });
  it('copy returns a usable provider', () => {
    expect(id.copy().distance(FRI, MON)).toBe(MON - FRI);
  });
});

describe('weekendSkip — distance', () => {
  const wk = weekendSkip();

  it('counts a full weekday span at face value', () => {
    // Mon 00:00 → Fri 00:00 is 4 live days, no weekend between.
    expect(wk.distance(MON, at(FRI, 0) + 7 * DAY)).toBe(4 * DAY);
  });

  it('does not count the weekend between Friday and Monday', () => {
    // Fri 12:00 → Mon 12:00 is 72h wall-clock but only 24h live.
    expect(wk.distance(at(FRI, 12), at(MON, 12))).toBe(DAY);
  });

  it('treats instants inside the weekend as the Saturday-00:00 boundary', () => {
    // Fri 12:00 → Sat 12:00: only the 12h of Friday afternoon is live.
    expect(wk.distance(at(FRI, 12), at(SAT, 12))).toBe(12 * 3_600_000);
    // Sat 12:00 → Sun 12:00: entirely inside the gap → 0 live ms.
    expect(wk.distance(at(SAT, 12), at(SUN, 12))).toBe(0);
  });

  it('is signed and antisymmetric', () => {
    expect(wk.distance(at(MON, 12), at(FRI, 12))).toBe(
      -wk.distance(at(FRI, 12), at(MON, 12)),
    );
  });

  it('matches a day-stepping brute force across a multi-week range, incl. pre-1970', () => {
    // Span both sides of the epoch (negative day indices) and of the Monday
    // anchor, at a sub-day offset that lands mid-morning on live days.
    const start = Date.UTC(1969, 10, 3); // a pre-epoch Monday-ish start
    for (let d = 0; d < 140; d++) {
      const t = start + d * DAY + 37 * 60_000;
      // distance(a, b) === liveMs(b) - liveMs(a); brute-force both endpoints.
      expect(wk.distance(start, t)).toBe(bruteLiveMs(t) - bruteLiveMs(start));
    }
  });

  it('offset is a right-inverse of distance across the same range (incl. pre-1970)', () => {
    // For any live amount, offset(a, amount) must be an instant whose distance
    // back to a is exactly amount — an independent exercise of instantForLiveMs.
    const a = Date.UTC(1969, 11, 1); // pre-epoch weekday
    for (let liveDays = -20; liveDays < 120; liveDays++) {
      const amount = liveDays * DAY + 9 * 3_600_000 + 17 * 60_000;
      expect(wk.distance(a, wk.offset(a, amount))).toBe(amount);
    }
  });

  it('handles a span crossing many weekends additively', () => {
    // 3 full weeks = 15 live days regardless of the 3 weekends inside.
    expect(wk.distance(MON, MON + 3 * 7 * DAY)).toBe(15 * DAY);
  });
});

describe('weekendSkip — clamp', () => {
  const wk = weekendSkip();
  it('clampUp pushes weekend instants to the following Monday 00:00', () => {
    expect(wk.clampUp(at(SAT, 5))).toBe(MON);
    expect(wk.clampUp(at(SUN, 23))).toBe(MON);
  });
  it('clampDown pulls weekend instants back to Saturday 00:00', () => {
    expect(wk.clampDown(at(SAT, 5))).toBe(SAT);
    expect(wk.clampDown(at(SUN, 23))).toBe(SAT);
  });
  it('leaves weekday instants untouched', () => {
    expect(wk.clampUp(at(FRI, 9))).toBe(at(FRI, 9));
    expect(wk.clampDown(at(MON, 9))).toBe(at(MON, 9));
  });
});

describe('weekendSkip — offset', () => {
  const wk = weekendSkip();

  it('inverts distance for live endpoints', () => {
    const a = at(FRI, 10);
    const b = at(MON, 15);
    expect(wk.offset(a, wk.distance(a, b))).toBe(b);
  });

  it('skips the weekend when advancing past Friday close', () => {
    // Fri 22:00 + 4 live hours → Mon 02:00 (2h Fri left, 2h into Monday).
    expect(wk.offset(at(FRI, 22), 4 * 3_600_000)).toBe(at(MON, 2));
  });

  it('advancing by 0 from inside the weekend lands on the next Monday', () => {
    // A weekend instant has no live position of its own; offset 0 resolves it
    // forward to the first live instant (documented asymmetry).
    expect(wk.offset(at(SAT, 12), 0)).toBe(MON);
  });

  it('round-trips a large multi-week offset', () => {
    const a = at(MON, 9);
    const amount = 12 * DAY + 5 * 3_600_000; // 12 live days + 5h
    expect(wk.distance(a, wk.offset(a, amount))).toBe(amount);
  });
});

describe('weekendSkip — boundaries', () => {
  const wk = weekendSkip();
  it('lists the Mondays (weekend-gap ends) strictly inside the range', () => {
    // Window spanning Fri 2021-01-01 → Fri 2021-01-15: Mondays 04 and 11.
    const b = wk.boundaries!(FRI, Date.UTC(2021, 0, 15));
    expect(b).toEqual([MON, Date.UTC(2021, 0, 11)]);
  });
  it('excludes a Monday exactly at the range start (strict)', () => {
    expect(wk.boundaries!(MON, Date.UTC(2021, 0, 11))).toEqual([]);
  });
});

describe('DiscontinuityProvider — structural interface', () => {
  it('both providers satisfy the same shape', () => {
    const providers: DiscontinuityProvider[] = [
      identityDiscontinuity(),
      weekendSkip(),
    ];
    for (const p of providers) {
      expect(typeof p.clampUp).toBe('function');
      expect(typeof p.clampDown).toBe('function');
      expect(typeof p.distance).toBe('function');
      expect(typeof p.offset).toBe('function');
      expect(typeof p.copy).toBe('function');
    }
  });
});
