import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  type ContainerFrame,
  type SelectInfo,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **Hover dedupes on a mark's full identity, not on `id + key`.**
 *
 * `setHovered` suppresses repeats so the data canvas repaints only when the
 * hovered mark actually changes — every pointer move would otherwise force a
 * redraw. The question is what counts as "the same mark".
 *
 * `key` is the mark's position on the **bin axis**, so it is only unique for a
 * layer with one mark per bin. A stacked bar or a `<HeatMap>` column stacks
 * several, and deduping on `id + key` alone silently swallows every move
 * *within* a bin — which on a heat map presents as the hover being stuck:
 * dragging straight down a column never changes the reported cell.
 */

function mount(onHover: (hit: SelectInfo | null) => void) {
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
      <ChartContainer range={[0, 3]} width={300} onHover={onHover}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} label="" />
          <Layers>
            <Capture />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  return cf!;
}

const cell = (label: string, extra: Partial<SelectInfo> = {}): SelectInfo => ({
  id: 'grid',
  key: 100,
  value: 1,
  color: '#abc',
  label,
  ...extra,
});

describe('hover dedupe', () => {
  it('reports a move to another row in the SAME bin', () => {
    // The bug: same `id`, same `key` (one x column), different row. Moving the
    // pointer vertically down a heat-map column must report each cell.
    const onHover = vi.fn();
    const c = mount(onHover);
    c.setHovered(cell('y1997'));
    c.setHovered(cell('y2015'));
    c.setHovered(cell('y2026'));
    expect(onHover.mock.calls.map((a) => (a[0] as SelectInfo).label)).toEqual([
      'y1997',
      'y2015',
      'y2026',
    ]);
  });

  it('still swallows a genuine repeat of the same cell', () => {
    // The dedupe has to keep doing its job — every pointer move inside one cell
    // arrives here, and each one would otherwise repaint the data canvas.
    const onHover = vi.fn();
    const c = mount(onHover);
    c.setHovered(cell('y1997'));
    c.setHovered(cell('y1997'));
    c.setHovered(cell('y1997'));
    expect(onHover).toHaveBeenCalledTimes(1);
  });

  it('distinguishes marks that differ only by `mark`', () => {
    // `mark` is the reorder-stable identity ([PND-BARMARK]); two marks can share
    // a key and a label across a re-sort.
    const onHover = vi.fn();
    const c = mount(onHover);
    c.setHovered(cell('row', { mark: 'a' }));
    c.setHovered(cell('row', { mark: 'b' }));
    expect(onHover).toHaveBeenCalledTimes(2);
  });

  it('still fires on leaving the plot, and only once', () => {
    const onHover = vi.fn();
    const c = mount(onHover);
    c.setHovered(cell('y1997'));
    c.setHovered(null);
    c.setHovered(null);
    expect(onHover.mock.calls.map((a) => a[0])).toEqual([
      expect.objectContaining({ label: 'y1997' }),
      null,
    ]);
  });

  it('still distinguishes bins, which is what it always did', () => {
    const onHover = vi.fn();
    const c = mount(onHover);
    c.setHovered(cell('row', { key: 100 }));
    c.setHovered(cell('row', { key: 200 }));
    expect(onHover).toHaveBeenCalledTimes(2);
  });
});
