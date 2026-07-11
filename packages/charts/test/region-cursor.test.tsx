import { useContext, useEffect, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BoundedSequence, Interval, Sequence, TimeSeries } from 'pond-ts';
import type { StoryObj } from '@storybook/react-vite';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
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

  it('is gated off a value axis (a time bucket is meaningless there)', () => {
    // A value-keyed (distance) row makes this a value axis; a time cursorSequence
    // realized over a value domain would otherwise shade the whole plot.
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
      'PanAndSelect',
      'Sessions',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
