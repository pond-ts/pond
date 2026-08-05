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
 * maps zero (and anything below it) to `NaN`, and the failure mode is usually a
 * non-finite coordinate silently poisoning a path rather than an exception. So
 * the stories that deliberately involve zero — `ZeroInData`, `AreaBaseline`,
 * `WithBars`, `StackedOnLog` — are the ones carrying weight here; the
 * arithmetic itself is pinned in `y-axis-log.test.tsx`, and what each drawn
 * layer emits in `log-axis-layers.test.ts`.
 *
 * The bar is no longer *only* "mounts without throwing", either: the canvas
 * double now enforces the platform's own argument validation, so a story that
 * reaches `createLinearGradient(0, NaN, …)` — as `AreaBaseline` did before this
 * round — fails here rather than passing green and breaking in a browser.
 */
describe('Log-scale axis stories render', () => {
  beforeEach(() => {
    stubCanvasContext();
    // A few stories warn by design (a refused bound, negative data); keep the
    // suite output clean without suppressing a warning that a different story
    // might raise unexpectedly.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'AreaBaseline',
      'BandFromZero',
      'DecadeTicks',
      'ExplicitDomain',
      'ExplicitMaxBelowData',
      'Linear',
      'Log',
      'LogAndLinearTogether',
      'NegativeInData',
      'NiceAutoDomain',
      'NoGrid',
      'NonPositiveMaxRefused',
      'NonPositiveMinRefused',
      'Padded',
      'StackedOnLog',
      'WithBars',
      'ZeroInData',
      'ZeroInDataArea',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
