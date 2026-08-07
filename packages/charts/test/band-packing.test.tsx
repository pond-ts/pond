import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * [PND-BANDPACK] — cap the slot pitch, then place the block.
 *
 * The friction: a band scale spreads its categories across the full plot, so
 * the same chart in the same panel reads differently depending on how many
 * categories the data returned. Fine for a fixed domain, wrong for a live one
 * where bar width becomes a variable that moves on its own.
 *
 * The property worth pinning is **pitch stability**: the same `maxBandWidth`
 * must give the same slot width whatever `n` is, until the cap stops binding.
 */

const WIDTH = 600;
const AXIS_W = 50;
const PLOT = WIDTH - AXIS_W;

const cats = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `c${i}`, value: i + 1 }));

function mount(n: number, props: Record<string, unknown> = {}) {
  let cf: ContainerFrame | null = null;
  function Capture() {
    const c = useContext(ContainerContext);
    useEffect(() => {
      if (c) cf = c;
    });
    return null;
  }
  const stub = stubCanvasContext();
  try {
    render(
      <ChartContainer width={WIDTH} {...props}>
        <ChartRow height={100}>
          <YAxis id="v" label="" />
          <Layers>
            <BarChart categories={cats(n)} />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const x = cf!.xScale;
  // Slot width in pixels: slot 0 runs [0, 1] in domain units.
  return { frame: cf!, pitch: +x(1) - +x(0), left: +x(0), right: +x(n) };
}

describe('maxBandWidth caps the slot pitch', () => {
  it('holds pitch constant as the category count changes', () => {
    // The whole point: 3 categories and 8 categories give the SAME bar width.
    const a = mount(3, { maxBandWidth: 40 });
    const b = mount(8, { maxBandWidth: 40 });
    expect(a.pitch).toBeCloseTo(40, 6);
    expect(b.pitch).toBeCloseTo(40, 6);
  });

  it('leaves the far side of the plot empty rather than stretching', () => {
    const { left, right } = mount(3, { maxBandWidth: 40 });
    expect(left).toBeCloseTo(0, 6);
    expect(right).toBeCloseTo(120, 6); // 3 × 40, not the full plot
  });

  it('degrades correctly once the cap stops binding', () => {
    // 40 categories × 40px > the plot, so the cap can't apply and the slots
    // fill as before — no clipping, no overflow.
    const { pitch, right } = mount(40, { maxBandWidth: 40 });
    expect(pitch).toBeCloseTo(PLOT / 40, 6);
    expect(right).toBeCloseTo(PLOT, 6);
  });

  it('is the shipped fill behaviour when omitted', () => {
    const capped = mount(3, {});
    expect(capped.pitch).toBeCloseTo(PLOT / 3, 6);
    expect(capped.right).toBeCloseTo(PLOT, 6);
  });

  it('ignores a non-positive cap rather than collapsing the scale', () => {
    const { pitch } = mount(3, { maxBandWidth: 0 });
    expect(pitch).toBeCloseTo(PLOT / 3, 6);
  });
});

describe('bandAlign places the capped block', () => {
  const slack = PLOT - 120; // 3 × 40

  it('packs from the start by default', () => {
    const { left } = mount(3, { maxBandWidth: 40 });
    expect(left).toBeCloseTo(0, 6);
  });

  it('centres on request', () => {
    const { left, right } = mount(3, {
      maxBandWidth: 40,
      bandAlign: 'center',
    });
    expect(left).toBeCloseTo(slack / 2, 6);
    expect(right).toBeCloseTo(slack / 2 + 120, 6);
  });

  it('packs to the end on request', () => {
    const { left, right } = mount(3, { maxBandWidth: 40, bandAlign: 'end' });
    expect(left).toBeCloseTo(slack, 6);
    expect(right).toBeCloseTo(PLOT, 6);
  });

  it('is a no-op when the cap does not bind', () => {
    // No slack to place, so every alignment gives the same scale.
    const s = mount(40, { maxBandWidth: 40, bandAlign: 'start' });
    const c = mount(40, { maxBandWidth: 40, bandAlign: 'center' });
    const e = mount(40, { maxBandWidth: 40, bandAlign: 'end' });
    expect(c.left).toBeCloseTo(s.left, 6);
    expect(e.left).toBeCloseTo(s.left, 6);
  });

  it('is a no-op without maxBandWidth', () => {
    const a = mount(3, {});
    const b = mount(3, { bandAlign: 'end' });
    expect(b.left).toBeCloseTo(a.left, 6);
    expect(b.right).toBeCloseTo(a.right, 6);
  });
});

describe('the offset scale stays coherent', () => {
  it('snaps a pixel inside the block to the right slot centre', () => {
    // `invert` must account for the offset, or the crosshair and the bars
    // disagree about which category the pointer is on — the exact failure the
    // hand-rolled workaround has.
    const { frame } = mount(3, { maxBandWidth: 40, bandAlign: 'center' });
    const x = frame.xScale;
    const mid = +x(1.5); // slot 1's centre, in pixels
    expect(x.invert(mid)).toBeCloseTo(1.5, 6);
  });

  it('clamps a pixel in the empty margin to a real slot', () => {
    const { frame } = mount(3, { maxBandWidth: 40, bandAlign: 'start' });
    const x = frame.xScale;
    // Far right of the block, out in the blank space.
    expect(x.invert(PLOT - 1)).toBeCloseTo(2.5, 6);
  });
});
