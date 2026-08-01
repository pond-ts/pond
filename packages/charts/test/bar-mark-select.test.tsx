import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
  type SelectInfo,
} from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/** Point-keyed: the bar spans are neighbour-derived, so `begin` is NOT the
 *  sample's key (t=1 sits in a bar spanning [0.5, 1.5]). */
const points = () =>
  new TimeSeries({
    name: 'b',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [1, 2],
      [2, 3],
    ] as [number, number][],
  });

/** Interval-keyed: the key already carries the span, so `begin` is the key. */
const buckets = () =>
  new TimeSeries({
    name: 'iv',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [[0, 1], 1],
      [[1, 2], 2],
      [[2, 3], 3],
    ] as [[number, number], number][],
  });

/**
 * Mount a single-series `<BarChart>` and hand back its registered layer plus the
 * row's scales, so a test can drive `hitTest` / `draw` directly — one
 * deterministic pass, rather than counting across the several the mount itself
 * issues while the plot width settles.
 */
function mount<S extends SeriesSchema>(
  series: TimeSeries<S>,
  selected: SelectInfo | null = null,
) {
  let cf: ContainerFrame | null = null;
  let rf: RowFrame | null = null;
  function Capture() {
    const c = useContext(ContainerContext);
    const r = useContext(RowContext);
    useEffect(() => {
      if (c) cf = c;
      if (r) rf = r;
    });
    return null;
  }
  const stub = stubCanvasContext();
  try {
    render(
      <ChartContainer range={[0, 3]} width={300} selected={selected}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={5} />
          <Layers>
            <BarChart series={series} column="v" axis="a" id="v" />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const c = cf!;
  const r = rf!;
  const layer = r.layers.find((l) => l.layer.hitTest !== undefined)!.layer;
  const yScale = r.yScales.get('a')!;
  return {
    hitAt: (t: number, v: number) =>
      layer.hitTest!(+c.xScale(t), yScale(v), c.xScale, yScale),
    /** The rects the selection highlight outlined in one draw pass. */
    outlines: () => {
      const { ctx, calls } = recordingContext();
      layer.draw(ctx, c.xScale, yScale);
      return calls.filter((x) => x.name === 'strokeRect').map((x) => x.args);
    },
  };
}

/**
 * The single-series bar's stable per-mark identity — the mechanism the
 * categorical stack already had, mirrored onto `<BarChart series column>`.
 * `hitTest` echoes the bar's own axis key as `SelectInfo.mark`, so a consumer
 * that owns the sample (estela's split centres) can pin a selection without
 * re-deriving the neighbour-spaced span the chart drew.
 */
describe('<BarChart> single-series hitTest — mark echo', () => {
  it('reports the sample’s own timestamp as the mark (point-keyed)', () => {
    const hit = mount(points()).hitAt(1, 1);
    // `key` stays the bar's begin edge (click provenance, unchanged)…
    expect(hit?.key).toBe(0.5);
    // …while `mark` is the sample's own key — the centre estela already owns.
    expect(hit?.mark).toBe('1');
  });

  it('reports the bucket’s own begin as the mark (interval-keyed)', () => {
    const hit = mount(buckets()).hitAt(1.5, 1);
    expect(hit?.key).toBe(1);
    expect(hit?.mark).toBe('1'); // the key IS the span here — they agree
  });

  it('keeps the series label as the readout label (the mark is not a label)', () => {
    // The stacked path swaps in the mark because its group name is a
    // placeholder ('value'); a single series' own label is meaningful, and its
    // mark is a stringified axis key — useless in a readout pill.
    expect(mount(points()).hitAt(1, 1)?.label).toBe('v');
  });

  it('misses cleanly outside every bar (no mark, no hit)', () => {
    expect(mount(points()).hitAt(1, 4.5)).toBeNull(); // above the bar's top
  });
});

/**
 * The other half of the pair: a **controlled** `selected` carrying a `mark`
 * must reach the canvas and outline exactly that bar — without the app knowing
 * the derived `begin` edge. (The match rules themselves are unit-tested in
 * `bars.test.ts`; this pins the container → layer → `drawBars` wiring.)
 */
describe('<BarChart> controlled selection by mark — render', () => {
  const pin = (over: Partial<SelectInfo>): SelectInfo => ({
    id: 'v',
    key: NaN,
    value: 2,
    color: '#000',
    label: 'v',
    ...over,
  });

  it('outlines exactly the bar whose sample key matches the mark', () => {
    // t=1's bar spans [0.5, 1.5] — the app pins '1' and never computes 0.5.
    expect(mount(points(), pin({ mark: '1' })).outlines()).toHaveLength(1);
  });

  it('outlines the SAME rect a key-pinned selection would (mark ≡ key)', () => {
    // The two channels resolve to one bar: pinning the sample (mark '1') and
    // pinning its derived edge (key 0.5) paint the identical outline.
    expect(mount(points(), pin({ mark: '1' })).outlines()).toEqual(
      mount(points(), pin({ key: 0.5 })).outlines(),
    );
  });

  it('outlines nothing for a mark no sample carries', () => {
    // The begin edge is emphatically NOT the mark — that's the whole point.
    expect(mount(points(), pin({ mark: '0.5' })).outlines()).toEqual([]);
  });

  it('still outlines a key-pinned selection with no mark (shipped path)', () => {
    expect(mount(points(), pin({ key: 0.5 })).outlines()).toHaveLength(1);
  });

  it('outlines nothing when nothing is selected', () => {
    expect(mount(points()).outlines()).toEqual([]);
  });
});
