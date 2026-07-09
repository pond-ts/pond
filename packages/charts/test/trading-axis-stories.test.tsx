import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/TradingTimeAxis.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the trading-time-axis stories: each must mount without
 * throwing (Candlestick/LineChart over interval-keyed bars on the discontinuous
 * scale). Guards the story pipeline — inline provider + session bucketing +
 * aggregate → candles — the way Storybook would, but headless.
 */
describe('TradingTimeAxis stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected feature-axis stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'ContinuousVsTrading',
      'DailyMonths',
      'HalfDay',
      'HolidayGap',
      'IntradaySessions',
      'SpacingProportionalVsUniform',
      'WeekendSkip',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
