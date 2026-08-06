import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/BarThresholds.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the threshold-banding stories ([PND-BANDBAR2]) — the
 * per-prop fan-out required of any feature axis. Each must mount without
 * throwing, which exercises the ladder resolution (`bandColors` → theme role),
 * both draw paths (single-series and the transposed stacked one), both
 * orientations, and the conflict cases.
 *
 * `console.warn` is silenced: two of these stories exist precisely to show a
 * dev warning firing (the `binColors` conflict), and an unsilenced warn would
 * make the suite noisy rather than failing anything.
 */
describe('BarThresholds stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'Default',
      'FiveBands',
      'FromTheme',
      'Horizontal',
      'PerRoleLadder',
      'Selectable',
      'Signed',
      'SingleThreshold',
      'TimeSeriesBars',
      'UnsortedThresholds',
      'YieldsToBinColors',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
      warn.mockRestore();
    });
  }
});
