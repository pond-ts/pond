import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/TradingTimeAxis.stories.js';
import * as interactions from '../src/TradingTimeAxisInteractions.stories.js';
import * as ladder from '../src/TimeAxisTicks.stories.js';
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
      'DateStyleDaily',
      'DateStyleIntraday',
      'DateStylePanZoom',
      'HalfDay',
      'HolidayGap',
      'IntradaySessions',
      'SessionBreaks',
      'SpacingProportionalVsUniform',
      'WeekendSkip',
      'YearDaily',
      'YearDailyNarrow',
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

/**
 * The tick-ladder matrix (`TimeAxisTicks.stories.tsx`) — one story per grain
 * rung across trading and plain-continuous axes. Smoke-mounted the same way;
 * the grain/format behavior itself is pinned in `tickLadder.test.ts` and
 * `tradingTimeScale.test.ts` (story widths are only *typical* for a grain —
 * the exact rung can vary with the runner's time zone).
 */
describe('TimeAxisTicks (tick-ladder) stories render', () => {
  const entries = storyEntries(ladder);

  it('exposes the expected ladder-matrix stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'ContinuousIntraday',
      'ContinuousYear',
      'IntradayHourly',
      'IntradayThreeHour',
      'MultiWeekDaily',
      'MultiYearNarrow',
      'MultiYearQuarterly',
      'QuarterDaily',
      'WeekDaily',
      'YearMonthly',
      'YearMonthlyNarrow',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
