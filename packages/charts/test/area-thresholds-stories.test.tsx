import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/AreaThresholds.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the area threshold-banding stories ([PND-BANDAREA]) —
 * the per-prop fan-out required of any feature axis. Each must mount without
 * throwing, which exercises the shared ladder resolution (`bandColors` →
 * theme role), the banded gradient on both axis kinds (linear and log), the
 * signed mirror, and the curve / gap compositions.
 *
 * `console.warn` is silenced so a story that legitimately warns can't make
 * the suite noisy without failing anything.
 */
describe('AreaThresholds stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'BandColors',
      'Default',
      'FiveBands',
      'LogAxis',
      'MonotoneCurve',
      'Selectable',
      'Signed',
      'SingleThreshold',
      'UnsortedThresholds',
      'WithGaps',
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
