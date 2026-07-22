import { useContext } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  CursorContext,
  type ContainerFrame,
  type CursorFrame,
} from '../src/context.js';

afterEach(cleanup);

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;
const series = new TimeSeries({
  name: 's',
  schema,
  rows: [
    [0, 1],
    [1, 2],
    [2, 3],
  ] as [number, number][],
});

/**
 * The [PND-HOVCTX] invariant: cursor position lives in {@link CursorContext},
 * not {@link ContainerFrame}, so a cursor move (a `setHoverX` — what the row's
 * pointer surface calls) must NOT re-render {@link ContainerContext}-only
 * consumers (`YAxis`, `Bar`, `Box`, …) — only the frame stays identity-stable
 * across the hover, while the cursor context updates. Regressing this (adding a
 * per-move field back to the frame) would silently restore the whole-subtree
 * re-render cascade the split removed.
 */
describe('[PND-HOVCTX] hover does not re-render container-context consumers', () => {
  it('a setHoverX keeps the frame identity stable but updates the cursor context', () => {
    let containerRenders = 0;
    let cursorRenders = 0;
    let frame: ContainerFrame | null = null;
    let cursor: CursorFrame | null = null;

    // Reads ONLY the container frame (the position of every config consumer —
    // YAxis / Legend / Bar). Records its render count + the frame it saw.
    function ContainerProbe() {
      const c = useContext(ContainerContext);
      containerRenders += 1;
      frame = c;
      return null;
    }
    // Reads the cursor context (the position of the overlay / crosshair pill).
    function CursorProbe() {
      const cur = useContext(CursorContext);
      cursorRenders += 1;
      cursor = cur;
      return null;
    }

    render(
      <ChartContainer range={[0, 3]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={5} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
          <ContainerProbe />
          <CursorProbe />
        </ChartRow>
      </ChartContainer>,
    );

    expect(frame).not.toBeNull();
    const frameBefore = frame!;
    const containerRendersBefore = containerRenders;
    const cursorRendersBefore = cursorRenders;
    expect(cursor!.cursorX).toBeNull();

    // A cursor move — exactly what the row's pointer surface calls on hover.
    act(() => frameBefore.setHoverX(42));

    // The frame the container consumer reads is the SAME object — so React
    // bailed it out of re-rendering (config consumers stay put on hover).
    expect(containerRenders).toBe(containerRendersBefore);
    // ...and specifically the frame identity did not change.
    expect(frame).toBe(frameBefore);

    // The cursor consumer, by contrast, re-rendered and sees the new position.
    expect(cursorRenders).toBeGreaterThan(cursorRendersBefore);
    expect(cursor!.cursorX).toBe(42);
  });

  it('clearing the cursor (setHoverX(null)) likewise spares the frame', () => {
    let containerRenders = 0;
    let frame: ContainerFrame | null = null;
    let cursor: CursorFrame | null = null;

    function ContainerProbe() {
      useContext(ContainerContext);
      containerRenders += 1;
      return null;
    }
    function CursorProbe() {
      cursor = useContext(CursorContext);
      return null;
    }
    function FrameProbe() {
      frame = useContext(ContainerContext);
      return null;
    }

    render(
      <ChartContainer range={[0, 3]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={5} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
          <ContainerProbe />
          <CursorProbe />
          <FrameProbe />
        </ChartRow>
      </ChartContainer>,
    );

    act(() => frame!.setHoverX(10));
    expect(cursor!.cursorX).toBe(10);
    const stable = frame!;
    const rendersAfterHover = containerRenders;

    act(() => stable.setHoverX(null));
    expect(cursor!.cursorX).toBeNull();
    expect(frame).toBe(stable); // frame identity survives the clear too
    expect(containerRenders).toBe(rendersAfterHover);
  });
});
