import { describe, it, expect } from 'vitest';
import { normalizeSessions, type Session } from '../src/index.js';

const s = (
  date: string,
  open: number,
  close: number,
  breaks?: Session['breaks'],
): Session => (breaks ? { date, open, close, breaks } : { date, open, close });

describe('normalizeSessions', () => {
  it('sorts by open and returns canonical form', () => {
    const out = normalizeSessions([
      s('2021-01-05', 200, 300),
      s('2021-01-04', 0, 100),
    ]);
    expect(out.map((x) => x.date)).toEqual(['2021-01-04', '2021-01-05']);
  });

  it('rejects close <= open', () => {
    expect(() => normalizeSessions([s('2021-01-04', 100, 100)])).toThrow(
      /close/,
    );
    expect(() => normalizeSessions([s('2021-01-04', 100, 50)])).toThrow(
      /close/,
    );
  });

  it('rejects overlapping sessions', () => {
    expect(() =>
      normalizeSessions([s('2021-01-04', 0, 100), s('2021-01-05', 50, 150)]),
    ).toThrow(/overlap/);
  });

  it('allows sessions that abut exactly (open === prev close)', () => {
    expect(() =>
      normalizeSessions([s('2021-01-04', 0, 100), s('2021-01-05', 100, 200)]),
    ).not.toThrow();
  });

  it('rejects duplicate dates', () => {
    expect(() =>
      normalizeSessions([s('2021-01-04', 0, 100), s('2021-01-04', 200, 300)]),
    ).toThrow(/duplicate/);
  });

  it('rejects malformed date strings', () => {
    expect(() => normalizeSessions([s('01/04/2021', 0, 100)])).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('validates breaks are within (open, close), sorted, non-overlapping', () => {
    expect(() =>
      normalizeSessions([s('2021-01-04', 0, 100, [{ start: 40, end: 60 }])]),
    ).not.toThrow();
    // break past close
    expect(() =>
      normalizeSessions([s('2021-01-04', 0, 100, [{ start: 90, end: 110 }])]),
    ).toThrow(/within/);
    // breaks out of order / overlapping
    expect(() =>
      normalizeSessions([
        s('2021-01-04', 0, 100, [
          { start: 60, end: 70 },
          { start: 40, end: 50 },
        ]),
      ]),
    ).toThrow(/sorted/);
  });

  it('rejects non-finite bounds', () => {
    expect(() => normalizeSessions([s('2021-01-04', NaN, 100)])).toThrow(
      /finite/,
    );
  });

  it('rejects date labels that disagree with open order', () => {
    // '2021-01-05' opens first but is labelled later than '2021-01-04'.
    expect(() =>
      normalizeSessions([s('2021-01-05', 0, 100), s('2021-01-04', 200, 300)]),
    ).toThrow(/date order/);
  });
});
