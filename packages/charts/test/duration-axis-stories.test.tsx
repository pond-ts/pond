import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/DurationAxis.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the duration-axis stories: each must mount without
 * throwing. Cheap coverage of every grain the duration formatter picks (millis
 * → whole days), both origin kinds, the value axis, and the format overrides —
 * the shapes that are otherwise only eyeballed in Storybook.
 */
describe('DurationAxis stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CrosshairReadout',
      'CustomFormat',
      'DayGrain',
      'Default',
      'ExplicitOrigin',
      'HoursGrain',
      'MarkerIndicator',
      'MillisGrain',
      'MultiDay',
      'PanZoom',
      'SecondsGrain',
      'ValueAxis',
      'WallClock',
      'WallClockUnderDuration',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
