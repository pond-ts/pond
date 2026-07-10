import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/Histogram.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the histogram stories: each must mount without throwing.
 * This exercises the *whole* feature end-to-end the way Storybook would, but
 * headless — pond's own data generation (`partitionBy().aggregate().toMap()`,
 * `byColumn`, `withColumn`) feeding the extended `<BarChart>` (stacked `Map`,
 * value-band `bins`, `horizontal` orientation), through layer registration,
 * extent resolution, and the canvas draw path.
 */
describe('Histogram stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected feature-axis stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'HeartRateZones',
      'HeartRateZonesColored',
      'HorizontalSingle',
      'HoverSelect',
      'IncidentsStacked',
      'PowerDistribution',
      'RiskBands',
      'RiskBandsThemeRoles',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
