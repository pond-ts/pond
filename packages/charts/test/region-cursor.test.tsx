import { useContext, useEffect, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BoundedSequence, Interval, Sequence, TimeSeries } from 'pond-ts';
import type { StoryObj } from '@storybook/react-vite';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';
import * as regionStories from '../src/CursorsRegion.stories.js';

afterEach(cleanup);

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

function frameOf(props: Record<string, unknown>): ContainerFrame {
  let frame: ContainerFrame | null = null;
  render(
    <ChartContainer width={320} {...props}>
      <Capture sink={(f) => (frame = f)} />
    </ChartContainer>,
  );
  return frame!;
}

const H = 3_600_000;
// A view starting *inside* the first week (Mon 2026-01-05 09:30 UTC).
const D0 = Date.UTC(2026, 0, 5) + 9.5 * H;
const D1 = Date.UTC(2026, 0, 14) + 16 * H;

describe('cursor="region" bucket realization', () => {
  it('a Sequence includes the bucket containing the view start (leading partial)', () => {
    // `Sequence.bounded` (sample 'begin') alone would drop the first week — its
    // Monday-midnight start precedes D0 — so the region band would go blank at
    // the left. The container widens the realized range back by one bucket.
    const f = frameOf({
      range: [D0, D1],
      cursor: 'region',
      cursorSequence: Sequence.calendar('week'),
    });
    const buckets = f.cursorBuckets!;
    expect(buckets).not.toBeUndefined();
    // The bucket covering D0 is present (begin ≤ D0 < end).
    const covering = buckets.find((b) => b.begin() <= D0 && D0 < b.end());
    expect(covering).toBeDefined();
    // Both trading weeks in view are represented.
    expect(buckets.length).toBeGreaterThanOrEqual(2);
  });

  it('a BoundedSequence is used as-is (its own intervals)', () => {
    const bs = new BoundedSequence([
      new Interval({ value: D0, start: D0, end: D0 + 6 * H }),
      new Interval({
        value: D0 + 24 * H,
        start: D0 + 24 * H,
        end: D0 + 30 * H,
      }),
    ]);
    const f = frameOf({
      range: [D0, D1],
      cursor: 'region',
      cursorSequence: bs,
    });
    expect(f.cursorBuckets).toEqual(bs.intervals());
  });

  it('no cursorSequence ⇒ cursorBuckets is undefined', () => {
    const f = frameOf({ range: [D0, D1], cursor: 'region' });
    expect(f.cursorBuckets).toBeUndefined();
  });

  it('bucket snapping is gated off a value axis, but the region cursor stays freeform-active', () => {
    // A value-keyed (distance) row makes this a value axis; a time cursorSequence
    // realized over a value domain would otherwise shade the whole plot — so the
    // *buckets* are gated off (snapping is time-only). The region cursor itself is
    // NOT gated: it falls back to the freeform raw-span drag on a value axis, and
    // onRegionSelect fires the neutral `[lo, hi]` in value units.
    const rideByDistance = new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'hr', kind: 'number' },
      ] as const,
      rows: [
        [0, 0, 120],
        [1000, 500, 130],
        [2000, 1200, 140],
      ],
    }).byValue('cumDist');

    let frame: ContainerFrame | null = null;
    render(
      <ChartContainer
        width={320}
        cursor="region"
        cursorSequence={Sequence.daily()}
      >
        <ChartRow height={100}>
          <YAxis id="a" min={100} max={160} />
          <Layers>
            <LineChart series={rideByDistance} column="hr" axis="a" />
          </Layers>
          <Capture sink={(f) => (frame = f)} />
        </ChartRow>
      </ChartContainer>,
    );
    expect(frame!.xKind).toBe('value');
    expect(frame!.cursorBuckets).toBeUndefined(); // gated off
  });
});

describe('cursor="region" snaps to a histogram\'s bins', () => {
  const HIST = [
    { start: 0, end: 20, secs: 5 },
    { start: 20, end: 40, secs: 12 },
    { start: 40, end: 60, secs: 8 },
  ];
  const render_ = (
    extra: ReactElement,
    props: Record<string, unknown> = {},
  ) => {
    let frame: ContainerFrame | null = null;
    render(
      <ChartContainer width={320} cursor="region" {...props}>
        <ChartRow height={100}>
          <YAxis id="s" min={0} />
          <Layers>{extra}</Layers>
          <Capture sink={(f) => (frame = f)} />
        </ChartRow>
      </ChartContainer>,
    );
    return frame!;
  };

  it('a vertical histogram publishes its bins as the region snap buckets', () => {
    const f = render_(<BarChart bins={HIST} column="secs" />);
    expect(f.xKind).toBe('value');
    // The bins become the cursor buckets — no cursorSequence needed.
    expect((f.cursorBuckets ?? []).map((b) => [b.begin(), b.end()])).toEqual([
      [0, 20],
      [20, 40],
      [40, 60],
    ]);
  });

  it('a horizontal histogram does NOT snap (value/count is on x, not bins)', () => {
    // Horizontal puts the count on x; snapping the region cursor to count-bins is
    // meaningless, so no buckets are published — the cursor stays freeform.
    const f = render_(
      <BarChart bins={HIST} column="secs" orientation="horizontal" ordinal />,
    );
    expect(f.cursorBuckets).toBeUndefined();
  });

  it('an explicit cursorSequence still wins on a time-axis histogram', () => {
    // A time-keyed bar chart + an explicit cursorSequence: the sequence is the
    // author's intent and takes precedence over the auto bin buckets.
    const byHour = new TimeSeries({
      name: 'events',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'n', kind: 'number' },
      ] as const,
      rows: [
        [D0, 3],
        [D0 + H, 5],
        [D0 + 2 * H, 2],
      ],
    });
    const f = render_(<BarChart series={byHour} column="n" />, {
      range: [D0, D0 + 3 * H],
      cursorSequence: Sequence.calendar('week'),
    });
    expect(f.xKind).toBe('time');
    // Weekly buckets (from the sequence), not the per-hour bar bins.
    const widths = (f.cursorBuckets ?? []).map((b) => b.end() - b.begin());
    expect(widths.every((w) => w >= 5 * 24 * H)).toBe(true);
  });

  it('a time-axis histogram with NO sequence snaps to its own bars', () => {
    // The bin-fallback isn't value-axis-only: a time-keyed bar chart with no
    // cursorSequence snaps to the bars it draws (one bucket per bar).
    const byHour = new TimeSeries({
      name: 'events',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'n', kind: 'number' },
      ] as const,
      rows: [
        [D0, 3],
        [D0 + H, 5],
        [D0 + 2 * H, 2],
      ],
    });
    const f = render_(<BarChart series={byHour} column="n" />, {
      range: [D0, D0 + 3 * H],
    });
    expect(f.xKind).toBe('time');
    const buckets = f.cursorBuckets ?? [];
    expect(buckets.length).toBe(3); // one snap bucket per bar
    // Point-keyed bars derive their span from neighbour spacing (centred on the
    // event), so exact edges aren't D0-aligned — but the buckets are ascending,
    // non-overlapping, and span the hourly events.
    expect(
      buckets.every((b, i) => i === 0 || b.begin() >= buckets[i - 1]!.end()),
    ).toBe(true);
    expect(buckets[0]!.begin()).toBeLessThanOrEqual(D0 + H);
    expect(buckets[2]!.end()).toBeGreaterThanOrEqual(D0 + 2 * H);
  });

  it('a non-bar row on a value axis stays freeform (no bins to snap to)', () => {
    const ride = new TimeSeries({
      name: 'ride',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cumDist', kind: 'number' },
        { name: 'hr', kind: 'number' },
      ] as const,
      rows: [
        [0, 0, 120],
        [1000, 500, 130],
      ],
    }).byValue('cumDist');
    const f = render_(<LineChart series={ride} column="hr" axis="s" />);
    expect(f.xKind).toBe('value');
    expect(f.cursorBuckets).toBeUndefined();
  });
});

describe('Charts/Cursors/Region stories render', () => {
  const entries = Object.entries(regionStories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected region-cursor stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'AggregationAligned',
      'CroppedToSessions',
      'Default',
      'DragToSelect',
      'Freeform',
      'HistogramBins',
      'PanAndSelect',
      'Sessions',
      'ValueAxisSelect',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
