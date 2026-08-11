import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/AxesSymlogScale.stories.js';
import type { StoryObj } from '@storybook/react-vite';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * Render smoke test for the symlog-axis stories ([PND-SYMLOG]). Each must mount
 * without throwing, which exercises the scale construction, the domain-relative
 * knee, and the tick ladder through a real row.
 *
 * The list assertion is deliberate — it fails when a story is added without
 * being named, keeping the fan-out a reviewable set.
 */
describe('Symlog axis stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'DefaultWindow',
      'LinearVsSymlog',
      'NarrowWindow',
      'OneSidedDomain',
      'WideWindow',
      'WindowSwallowsDomain',
    ]);
  });

  it.each(entries)('%s mounts without throwing', (_name, story) => {
    const stub = stubCanvasContext();
    try {
      expect(() =>
        render((story.render as () => ReactElement)()),
      ).not.toThrow();
    } finally {
      stub.restore();
    }
  });
});
