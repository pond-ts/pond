import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/TradingTimeAxis.stories.js';
import * as interactions from '../src/TradingTimeAxisInteractions.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

const storyEntries = (mod: Record<string, unknown>) =>
  Object.entries(mod).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

/**
 * Render smoke test for the trading-time-axis stories: each must mount without
 * throwing (Candlestick/LineChart over interval-keyed bars on the discontinuous
 * scale). Guards the story pipeline — inline provider + session bucketing +
 * aggregate → candles — the way Storybook would, but headless.
 */
describe('TradingTimeAxis stories render', () => {
  const entries = storyEntries(stories);

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

/**
 * The interaction stories (cursors, annotations across gaps, pan/zoom) mount the
 * same way — several are function components (`useState`), so this also exercises
 * the annotation/cursor pipeline on the discontinuous scale headless.
 */
describe('TradingTimeAxis interaction stories render', () => {
  const entries = storyEntries(interactions);

  it('exposes the expected interaction stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CrosshairFree',
      'CrosshairSnap',
      'EditableRegion',
      'FlagOnCandles',
      'PanZoom',
      'RegionAcrossSessions',
      'RegionCursorSession',
      'RegionCursorWeek',
      'Snapping',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
