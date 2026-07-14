import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import {
  Region,
  Marker,
  Baseline,
  computeLabelLanes,
  orderRegion,
  moveRegionByPixels,
  snapToGuides,
} from '../src/annotations.js';
import type { ContainerFrame } from '../src/context.js';
import type { DiscontinuityProvider } from '../src/tradingTimeScale.js';
import type { AnnotationSpec } from '../src/context.js';

afterEach(cleanup);

const series = new TimeSeries({
  name: 't',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [
    [0, 1],
    [1, 5],
    [2, 9],
    [3, 4],
    [4, 7],
  ] as [number, number][],
});

/** The en dash the region auto-label joins its bounds with (`from–to`). */
const EN = '–';

/**
 * Render one annotation in a minimal time-axis container and report whether a
 * chip with `text` is present. `showAxis={false}` drops the time axis and
 * `timeFormat={() => 'X'}` makes every x format to the sentinel `'X'`, so the
 * *only* `'X'` on screen is a mark's auto-label — never an axis tick. The y axis
 * is `[0,100]` (ticks 0,10,…,100), so a baseline value of 37 auto-labels to a
 * `'37'` no tick collides with.
 *
 * The query is scoped to *this* render's `container` (and the tree is unmounted
 * after) so successive calls in one test don't see each other's chips — RTL's
 * top-level queries are bound to `document.body`, which accumulates renders.
 */
function hasChip(child: ReactNode, text: string): boolean {
  const { container, unmount } = render(
    <ChartContainer
      range={[0, 4]}
      width={300}
      showAxis={false}
      timeFormat={() => 'X'}
    >
      <ChartRow height={120}>
        <YAxis id="a" min={0} max={100} />
        <Layers>
          <LineChart series={series} column="v" axis="a" />
          {child}
        </Layers>
      </ChartRow>
    </ChartContainer>,
  );
  const found = within(container).queryByText(text) !== null;
  unmount();
  return found;
}

/**
 * `label={false}` (and `label=""`) suppress the chip entirely — the label-less
 * mode for inert background marks (estela's `highlightRanges`) — while omitting
 * `label` still auto-labels off the axis, and a real string still renders.
 */
describe('annotation label opt-out (label={false} / "")', () => {
  it('Region: omit → auto-label span; false / "" → no chip; string → chip', () => {
    expect(hasChip(<Region from={1} to={3} />, `X${EN}X`)).toBe(true);
    expect(hasChip(<Region from={1} to={3} label={false} />, `X${EN}X`)).toBe(
      false,
    );
    expect(hasChip(<Region from={1} to={3} label="" />, `X${EN}X`)).toBe(false);
    expect(hasChip(<Region from={1} to={3} label="zone" />, 'zone')).toBe(true);
  });

  it('Marker: omit → auto-label; false / "" → no chip; string → chip', () => {
    expect(hasChip(<Marker at={2} />, 'X')).toBe(true);
    expect(hasChip(<Marker at={2} label={false} />, 'X')).toBe(false);
    expect(hasChip(<Marker at={2} label="" />, 'X')).toBe(false);
    expect(hasChip(<Marker at={2} label="lap 3" />, 'lap 3')).toBe(true);
  });

  it('culls a marker chip whose pole has panned off-plot', () => {
    // The staff is SVG-clipped; the DOM chip must not float in the gutter.
    expect(hasChip(<Marker at={-2} label="mark" />, 'mark')).toBe(false);
    expect(hasChip(<Marker at={9} label="mark" />, 'mark')).toBe(false);
    expect(hasChip(<Marker at={2} label="mark" />, 'mark')).toBe(true);
  });

  it('clamps a partially visible region chip to the plot edge; culls fully off-plot', () => {
    // Fully off-plot (either side) → no chip.
    expect(hasChip(<Region from={-4} to={-1} label="zone" />, 'zone')).toBe(
      false,
    );
    expect(hasChip(<Region from={6} to={9} label="zone" />, 'zone')).toBe(
      false,
    );
    // Left edge off-plot but the region still visible → chip present, anchored
    // at the plot's left edge (x clamped to 0 → left = FLAG_GAP px).
    const { container, unmount } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        showAxis={false}
        timeFormat={() => 'X'}
      >
        <ChartRow height={80}>
          <YAxis id="v" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="v" />
          </Layers>
          <Region from={-2} to={2} label="zone" />
        </ChartRow>
      </ChartContainer>,
    );
    const chip = within(container).getByText('zone');
    expect(chip.style.left).toBe('4px'); // FLAG_GAP right of the clamped pole
    unmount();
  });

  it('Baseline: omit → auto-label value; false / "" → no chip; string → chip', () => {
    expect(hasChip(<Baseline value={37} />, '37')).toBe(true);
    expect(hasChip(<Baseline value={37} label={false} />, '37')).toBe(false);
    expect(hasChip(<Baseline value={37} label="" />, '37')).toBe(false);
    expect(
      hasChip(<Baseline value={37} label="threshold" />, 'threshold'),
    ).toBe(true);
  });
});

/** Build an `AnnotationSpec` with sensible defaults for the lane-packing test. */
function spec(
  over: Partial<AnnotationSpec> & Pick<AnnotationSpec, 'label'>,
): AnnotationSpec {
  return {
    key: Symbol('ann'),
    id: undefined,
    kind: 'marker',
    rowKey: Symbol('row'),
    xs: [1],
    selected: false,
    editing: false,
    selectable: true,
    indicator: false,
    ...over,
  };
}

/**
 * `computeLabelLanes` already filters on `label.length > 0`, so a label-less mark
 * (the `label={false}`/`''` case, registered as `''`) claims no lane — it can't
 * push a labelled neighbour down a lane it doesn't occupy.
 */
describe('computeLabelLanes — empty labels claim no lane', () => {
  it('skips empty-label marks entirely', () => {
    const lanes = computeLabelLanes(
      [spec({ label: '' }), spec({ kind: 'region', xs: [2, 3], label: '' })],
      (x) => x * 10,
    );
    expect(lanes.size).toBe(0);
  });

  it('MERGES coincident markers (same x, same row) into one chip', () => {
    // Two labelled markers at the *same* x, same row → one merged chip on the
    // representative (the first), the other folded in (label: null); both lane 0.
    const row = Symbol('row');
    const a = Symbol('a');
    const b = Symbol('b');
    const lanes = computeLabelLanes(
      [
        spec({ label: 'z1', rowKey: row, key: a, xs: [1] }),
        spec({ label: 'z2', rowKey: row, key: b, xs: [1] }),
      ],
      (x) => x * 10,
    );
    expect(lanes.get(a)).toEqual({ lane: 0, label: 'z1, z2' });
    expect(lanes.get(b)).toEqual({ lane: 0, label: null });
  });

  it('stacks overlapping marks at DIFFERENT x in the same row', () => {
    // Close but not coincident (x 1 vs 2 → 10px vs 20px, labels ~37px wide) →
    // they overlap but don't merge, so the second drops to lane 1.
    const row = Symbol('row');
    const lanes = computeLabelLanes(
      [
        spec({ label: 'one', rowKey: row, xs: [1] }),
        spec({ label: 'two', rowKey: row, xs: [2] }),
      ],
      (x) => x * 10,
    );
    expect([...lanes.values()].map((p) => p.lane).sort()).toEqual([0, 1]);
  });

  it('does NOT stack labels in DIFFERENT rows (per-row spaces)', () => {
    // Same x but different rows → each in its own row's top space (lane 0).
    const lanes = computeLabelLanes(
      [spec({ label: 'top' }), spec({ label: 'bottom' })],
      (x) => x * 10,
    );
    expect([...lanes.values()].map((p) => p.lane)).toEqual([0, 0]);
  });

  it('excludes the dragged mark from packing (pinned to lane 0, own label)', () => {
    // Different x so they'd otherwise stack; the dragged one is excluded so the
    // static one keeps lane 0, and the dragged shows its own label at lane 0.
    const row = Symbol('row');
    const dragged = Symbol('dragged');
    const lanes = computeLabelLanes(
      [
        spec({ label: 'static', rowKey: row, xs: [1] }),
        spec({ label: 'dragged', rowKey: row, key: dragged, xs: [2] }),
      ],
      (x) => x * 10,
      dragged,
    );
    expect(lanes.get(dragged)).toEqual({ lane: 0, label: 'dragged' });
    expect([...lanes.values()].map((p) => p.lane)).toEqual([0, 0]);
  });
});

/**
 * Region edge resize pivots around the fixed opposite edge ({@link orderRegion}),
 * so it never emits an inverted `{ from > to }` (the Codex-found P0). Dragging the
 * edge *past* the pivot collapses to zero width then re-opens the region the other
 * way — a drag either direction resizes.
 */
describe('orderRegion — edge resize never inverts (pivot clamp)', () => {
  it('orders the dragged value against the pivot on either side', () => {
    expect(orderRegion(15, 20)).toEqual({ from: 15, to: 20 }); // dragged toward pivot
    expect(orderRegion(20, 20)).toEqual({ from: 20, to: 20 }); // edges meet, zero width
    expect(orderRegion(25, 20)).toEqual({ from: 20, to: 25 }); // crossed past → re-opens
    expect(orderRegion(5, 20)).toEqual({ from: 5, to: 20 }); // dragged the other way
  });
});

/**
 * A region **body move** must translate rigidly in *pixel* space so the box holds
 * its shape across a collapsed gap on a discontinuous (trading-time) axis — the
 * old shared value-delta drifted the two edges apart there. {@link moveRegionByPixels}
 * shifts each edge the same pixels through the scale.
 */
describe('moveRegionByPixels — rigid pixel move across a collapsed gap', () => {
  // A deliberately discontinuous scale with two *different* value→pixel rates:
  //   segment 1: value [0,100)   → pixel [0,100)   (rate 1 px/value)
  //   (collapsed gap)
  //   segment 2: value [200,240) → pixel [100,200) (rate 2.5 px/value)
  const scale = Object.assign(
    (v: number): number => (v <= 100 ? v : 100 + (v - 200) * 2.5),
    {
      invert: (px: number): number => (px <= 100 ? px : 200 + (px - 100) / 2.5),
    },
  );

  it('shifts both edges by equal PIXELS (unequal value), preserving pixel width', () => {
    // Box from 50 (px 50, seg 1) to 220 (px 150, seg 2) — a 100px-wide box that
    // straddles the gap. Move +30px.
    const m = moveRegionByPixels(scale, 50, 220, 30);
    // Each edge advanced exactly 30px:
    expect(scale(m.from)).toBeCloseTo(80, 6);
    expect(scale(m.to)).toBeCloseTo(180, 6);
    // …so the PIXEL width is preserved (rigid), not distorted:
    expect(scale(m.to) - scale(m.from)).toBeCloseTo(100, 6);
    // The value shifts are UNEQUAL — proof it moved in pixel space, not value:
    expect(m.from - 50).toBeCloseTo(30, 6); // +30 value in the rate-1 segment
    expect(m.to - 220).toBeCloseTo(12, 6); //  +12 value in the rate-2.5 segment
  });

  it('is the identity move on a continuous (affine) scale', () => {
    const lin = Object.assign((v: number): number => v * 2 + 5, {
      invert: (px: number): number => (px - 5) / 2,
    });
    // +8px = +4 value everywhere on this scale → both edges advance 4.
    const m = moveRegionByPixels(lin, 10, 40, 8);
    expect(m.from).toBeCloseTo(14, 9);
    expect(m.to).toBeCloseTo(44, 9);
  });
});

/**
 * On a trading-time axis a session **close** and the next **open** collapse to
 * the same pixel, so a boundary is one snap target with two instants;
 * `snapToGuides` picks the one on the side of the boundary the pointer is on.
 */
describe('snapToGuides — disjoint boundary side heuristic', () => {
  // Live spans [0,100) and [200,300); the gap [100,200) collapses so both 100
  // (close) and 200 (open) map to pixel 100.
  const provider: DiscontinuityProvider = {
    clampDown: (t) => (t >= 100 && t < 200 ? 100 : t), // in the gap → the close
    clampUp: (t) => (t > 100 && t <= 200 ? 200 : t),
    distance: (a, b) => b - a,
    offset: (v, amt) => v + amt,
    copy: () => provider,
    boundaries: () => [200], // one collapse point, at the open (200)
  };
  const xScale = (v: number): number =>
    v <= 100 ? v : v < 200 ? 100 : 100 + (v - 200); // collapse the gap onto px 100
  const frame = {
    snap: true,
    annotations: [],
    xScale,
    timeRange: [0, 300] as const,
    discontinuities: provider,
  } as unknown as ContainerFrame;

  it('snaps to the close (pre-gap) when the pointer is left of the boundary', () => {
    // px 98 is left of the boundary pixel (100) → the previous session's close.
    expect(snapToGuides(frame, Symbol(), 98)).toBe(100);
  });

  it('snaps to the open (post-gap) when the pointer is at/right of the boundary', () => {
    // px 103 is right of the boundary pixel → the next session's open.
    expect(snapToGuides(frame, Symbol(), 103)).toBe(200);
  });

  it('does not snap beyond SNAP_PX', () => {
    expect(snapToGuides(frame, Symbol(), 120)).toBeNull(); // 20px away
  });

  it('exactly on the boundary pixel resolves to the open (post-gap)', () => {
    // px === bpx: `px < bpx` is false → the post-gap open, not the close.
    expect(snapToGuides(frame, Symbol(), 100)).toBe(200);
  });

  it('respects the snap toggle', () => {
    expect(snapToGuides({ ...frame, snap: false }, Symbol(), 98)).toBeNull();
  });

  it('is a no-op boundary-wise on a plain axis (no discontinuities)', () => {
    // No provider → only annotation guidelines snap; here there are none.
    const plain = {
      ...frame,
      discontinuities: undefined,
    } as unknown as ContainerFrame;
    expect(snapToGuides(plain, Symbol(), 98)).toBeNull();
  });
});

/** Render one annotation in the minimal container and return its `container`. */
function renderAnn(child: ReactNode) {
  return render(
    <ChartContainer range={[0, 4]} width={300} showAxis={false}>
      <ChartRow height={120}>
        <YAxis id="a" min={0} max={100} />
        <Layers>
          <LineChart series={series} column="v" axis="a" />
          {child}
        </Layers>
      </ChartRow>
    </ChartContainer>,
  );
}

describe('Baseline label placement', () => {
  const chip = (child: ReactNode) => {
    const { container, unmount } = renderAnn(child);
    const el = within(container).queryByText('lvl') as HTMLElement | null;
    const style = el
      ? {
          left: el.style.left,
          right: el.style.right,
          transform: el.style.transform,
        }
      : null;
    unmount();
    return style;
  };

  it('labelSide right/left anchors the chip to that edge', () => {
    expect(
      chip(<Baseline value={50} axis="a" label="lvl" labelSide="right" />),
    ).toEqual({
      left: '',
      right: '2px',
      transform: 'translateY(-50%)',
    });
    expect(chip(<Baseline value={50} axis="a" label="lvl" />)).toEqual({
      left: '2px',
      right: '',
      transform: 'translateY(-50%)',
    });
  });

  it('labelPosition="above" sits the chip on top of the line (-100%)', () => {
    expect(
      chip(<Baseline value={50} axis="a" label="lvl" labelPosition="above" />)
        ?.transform,
    ).toBe('translateY(-100%)');
  });
});

describe('Region edges', () => {
  const edgeCount = (child: ReactNode) => {
    const { container, unmount } = renderAnn(child);
    const n = container.querySelectorAll('svg line').length;
    unmount();
    return n;
  };

  it('draws two side outlines by default, none with edges={false}', () => {
    expect(edgeCount(<Region from={1} to={3} label={false} />)).toBe(2);
    expect(
      edgeCount(<Region from={1} to={3} label={false} edges={false} />),
    ).toBe(0);
  });
});
