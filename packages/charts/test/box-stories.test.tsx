import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/Box.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the BoxPlot stories: each must mount without throwing.
 * This exercises the whole layer end-to-end headless — including the value-axis
 * widening (`VolSmile` / `VolSmileWithMid` on a `ValueSeries`), the range-only
 * box (omitted `q1`/`q3`/`median`), and the `offset` pairing (`CallPutPair`).
 */
describe('BoxPlot stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CallPutPair',
      'CursorFlag',
      'Percentiles',
      'Selectable',
      'Solid',
      'Themed',
      'VolSmile',
      'VolSmileWithMid',
      'WithGap',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
