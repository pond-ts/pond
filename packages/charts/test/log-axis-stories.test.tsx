import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/AxesLogScale.stories.js';
import type { StoryObj } from '@storybook/react-vite';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * Render smoke test for the log-scale axis stories: each must mount without
 * throwing. That is a lower bar than it sounds for this feature — a log scale
 * maps zero (and anything below it) to `-Infinity`, and the failure mode is a
 * non-finite coordinate silently poisoning a path rather than an exception. So
 * the stories that deliberately involve zero — `ZeroInData`, `AreaBaseline`,
 * `WithBars` — are the ones carrying weight here; the arithmetic itself is
 * pinned in `y-axis-log.test.tsx`.
 */
describe('Log-scale axis stories render', () => {
  beforeEach(() => {
    stubCanvasContext();
    // `ZeroInData` warns by design; keep the suite output clean without
    // suppressing a warning that a different story might raise unexpectedly.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'AreaBaseline',
      'DecadeTicks',
      'ExplicitDomain',
      'Linear',
      'Log',
      'LogAndLinearTogether',
      'NoGrid',
      'NonPositiveMinRefused',
      'Padded',
      'WithBars',
      'ZeroInData',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
