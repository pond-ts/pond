import { describe, expect, it } from 'vitest';
import * as fit from '../src/index.js';

// [PND-FITPUB] — the first-publish export decision, pinned. Each geo
// analytic below has a deliberate answer; widening the barrel later is a
// decision too, and should arrive by editing this test, not by accident.
describe('@pond-ts/fit public surface', () => {
  it('gives simplify a façade door rather than a bare export', () => {
    expect('simplify' in fit).toBe(false);
    expect(typeof fit.Track.prototype.simplify).toBe('function');
  });

  it('keeps the distance-profile operators behind the summary', () => {
    // Reachable as `summary().channels` / `activity.windowChannels(…)`,
    // whose samples carry the median line and both band pairs.
    for (const name of [
      'elevationProfile',
      'profileByDistance',
      'profileByDistanceWindow',
      'rollingSpread',
    ]) {
      expect(name in fit, name).toBe(false);
    }
  });

  it('keeps the unit-preference system in fit, off Profile', () => {
    expect(fit.DEFAULT_UNITS).toEqual({
      distance: 'mi',
      elevation: 'ft',
      temperature: 'F',
      speedPace: 'imperial',
    });
    expect('units' in fit.Profile.prototype).toBe(false);
  });
});
