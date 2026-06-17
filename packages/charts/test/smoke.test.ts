import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

// M0 plumbing smoke test: confirms the package builds, resolves, and runs under
// vitest. Replaced by real rendering-spine tests in M1.
describe('@pond-ts/charts skeleton', () => {
  it('exposes its package identity', () => {
    expect(PACKAGE_NAME).toBe('@pond-ts/charts');
  });
});
