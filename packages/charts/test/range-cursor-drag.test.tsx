/**
 * `<RangeCursor>` drag — step 3 of the interaction wave (RFC §6 / A4.2), on
 * the single brush recognizer (`brush.tsx`, RFC A1.5 / A2.7).
 *
 * These tests drive the REAL component through pointer events on the plot
 * surface — not just the pure helpers — because twice this wave a defect sat
 * in the wiring above a well-tested draw function. The pure claim-resolver
 * tests at the bottom pin the documented precedence order on its own.
 */
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Sequence, TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { RangeCursor } from '../src/cursors.js';
import { resolveBrushClaim, resolveRangeDrag } from '../src/brush.js';
import {
  ContainerContext,
  type ContainerFrame,
  type CursorEntry,
  type RangeSpan,
} from '../src/context.js';

afterEach(cleanup);

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [500, 5],
      [1000, 9],
    ],
  });

function pointer(
  type: string,
  x: number,
  buttons: number,
  init: PointerEventInit = {},
): Event {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 40,
    buttons,
    ...init,
  });
}

/** Mount a chart (range [0, 1000]) with the given cursor child + extra
 *  container props; return the plot surface and the live frame. */
function mount(cursorEl: ReactNode, props: Record<string, unknown> = {}) {
  let frame: ContainerFrame | null = null;
  const { container } = render(
    <ChartContainer range={[0, 1000]} width={320} {...props}>
      {cursorEl}
      <ChartRow height={120}>
        <YAxis id="a" min={0} max={10} />
        <Layers>
          <LineChart series={series()} column="v" axis="a" />
        </Layers>
      </ChartRow>
      <Capture sink={(f) => (frame = f)} />
    </ChartContainer>,
  );
  const surface = container.querySelector('canvas')!.parentElement!;
  return { surface, container, frame: () => frame! };
}

/** Drag from px `x0` to `x1` (paced: flush between events). */
function drag(
  surface: Element,
  x0: number,
  x1: number,
  init?: PointerEventInit,
) {
  act(() => surface.dispatchEvent(pointer('pointerdown', x0, 1, init)));
  act(() => surface.dispatchEvent(pointer('pointermove', x1, 1, init)));
  act(() => surface.dispatchEvent(pointer('pointerup', x1, 0, init)));
}

describe('<RangeCursor onDragRelease> — the freeform drag', () => {
  it('fires once on release with { x: [lo, hi] } in axis units, y absent', () => {
    const onDragRelease = vi.fn();
    const { surface, frame } = mount(
      <RangeCursor onDragRelease={onDragRelease} />,
    );
    const plotWidth = frame().plotWidth;

    drag(surface, 60, 200);

    expect(onDragRelease).toHaveBeenCalledTimes(1);
    const span = onDragRelease.mock.calls[0]![0] as RangeSpan;
    expect(span.x[0]).toBeCloseTo((60 / plotWidth) * 1000, 6);
    expect(span.x[1]).toBeCloseTo((200 / plotWidth) * 1000, 6);
    // Forward-compat: the 1-D drag carries NO y — not even an undefined key —
    // so the 2-D drag can add it without changing this payload's shape.
    expect('y' in span).toBe(false);
  });

  it('a right-to-left drag still reports lo ≤ hi', () => {
    const onDragRelease = vi.fn();
    const { surface, frame } = mount(
      <RangeCursor onDragRelease={onDragRelease} />,
    );
    const plotWidth = frame().plotWidth;
    drag(surface, 200, 60);
    const span = onDragRelease.mock.calls[0]![0] as RangeSpan;
    expect(span.x[0]).toBeCloseTo((60 / plotWidth) * 1000, 6);
    expect(span.x[1]).toBeCloseTo((200 / plotWidth) * 1000, 6);
  });

  it('the cursor REVERTS on release — the anchor clears, the band does not persist', () => {
    const onDragRelease = vi.fn();
    const { surface, frame, container } = mount(
      <RangeCursor onDragRelease={onDragRelease} />,
    );
    act(() => surface.dispatchEvent(pointer('pointerdown', 60, 1)));
    expect(frame().regionAnchor).not.toBeNull();
    // Mid-drag the freeform band shades the raw span.
    act(() => surface.dispatchEvent(pointer('pointermove', 200, 1)));
    expect(container.querySelector('svg rect')).not.toBeNull();
    act(() => surface.dispatchEvent(pointer('pointerup', 200, 0)));
    expect(frame().regionAnchor).toBeNull();
    // After release + a plain hover, freeform is back to the degenerate line.
    act(() => surface.dispatchEvent(pointer('pointermove', 100, 0)));
    expect(container.querySelector('svg rect')).toBeNull();
  });

  it('a batched down→move→up (no flush between events) still commits (the #508-item-7 discipline)', () => {
    const onDragRelease = vi.fn();
    const { surface, frame } = mount(
      <RangeCursor onDragRelease={onDragRelease} />,
    );
    act(() => {
      surface.dispatchEvent(pointer('pointerdown', 60, 1));
      surface.dispatchEvent(pointer('pointermove', 200, 1));
      surface.dispatchEvent(pointer('pointerup', 200, 0));
    });
    expect(onDragRelease).toHaveBeenCalledTimes(1);
    expect(frame().regionAnchor).toBeNull();
  });
});

describe('<RangeCursor sequence> — the drag snaps bucket by bucket', () => {
  const DAY = 86_400_000;
  const D0 = Date.UTC(2026, 0, 5);
  const D1 = D0 + 7 * DAY;

  it('the released span is the union of the anchor and pointer buckets', () => {
    const onDragRelease = vi.fn();
    let frame: ContainerFrame | null = null;
    const { container } = render(
      <ChartContainer range={[D0, D1]} width={320} showAxis={false}>
        <RangeCursor
          sequence={Sequence.calendar('day')}
          onDragRelease={onDragRelease}
        />
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart
              series={
                new TimeSeries({
                  name: 'd',
                  schema: [
                    { name: 'time', kind: 'time' },
                    { name: 'v', kind: 'number' },
                  ] as const,
                  rows: [
                    [D0, 1],
                    [D0 + 3 * DAY, 5],
                  ] as [number, number][],
                })
              }
              column="v"
              axis="a"
            />
          </Layers>
        </ChartRow>
        <Capture sink={(f) => (frame = f)} />
      </ChartContainer>,
    );
    const surface = container.querySelector('canvas')!.parentElement!;
    const plotWidth = frame!.plotWidth;
    const pxAt = (t: number) => ((t - D0) / (D1 - D0)) * plotWidth;

    // Drag from inside day 1 to inside day 3 → the span snaps outward to the
    // covering buckets: [D0+1d, D0+4d).
    drag(surface, pxAt(D0 + 1.2 * DAY), pxAt(D0 + 3.5 * DAY));

    expect(onDragRelease).toHaveBeenCalledTimes(1);
    const span = onDragRelease.mock.calls[0]![0] as RangeSpan;
    expect(span.x[0]).toBe(D0 + 1 * DAY);
    expect(span.x[1]).toBe(D0 + 4 * DAY);
  });
});

describe('enableDrag — the OFF switch', () => {
  it('defaults on when onDragRelease is wired (no enableDrag needed)', () => {
    const onDragRelease = vi.fn();
    const { surface } = mount(<RangeCursor onDragRelease={onDragRelease} />);
    drag(surface, 60, 200);
    expect(onDragRelease).toHaveBeenCalledTimes(1);
  });

  it('enableDrag={false} freezes the gesture without unwiring the callback', () => {
    const onDragRelease = vi.fn();
    const { surface, frame } = mount(
      <RangeCursor onDragRelease={onDragRelease} enableDrag={false} />,
    );
    drag(surface, 60, 200);
    expect(onDragRelease).not.toHaveBeenCalled();
    expect(frame().regionAnchor).toBeNull();
  });

  it('frozen, the plot drag goes back to pan when pan is enabled', () => {
    const onDragRelease = vi.fn();
    const onTimeRangeChange = vi.fn();
    const { surface } = mount(
      <RangeCursor onDragRelease={onDragRelease} enableDrag={false} />,
      { panZoom: 'pan', onTimeRangeChange },
    );
    drag(surface, 200, 60);
    expect(onDragRelease).not.toHaveBeenCalled();
    expect(onTimeRangeChange).toHaveBeenCalled();
  });

  it('frozen also suppresses the LEGACY fallback — the consumer wired the new API', () => {
    const onDragRelease = vi.fn();
    const onRegionSelect = vi.fn();
    const { surface } = mount(
      <RangeCursor onDragRelease={onDragRelease} enableDrag={false} />,
      { onRegionSelect },
    );
    drag(surface, 60, 200);
    expect(onDragRelease).not.toHaveBeenCalled();
    expect(onRegionSelect).not.toHaveBeenCalled();
  });

  it('without onDragRelease there is nothing to fire — no gesture starts', () => {
    const { surface, frame } = mount(<RangeCursor />);
    act(() => surface.dispatchEvent(pointer('pointerdown', 60, 1)));
    expect(frame().regionAnchor).toBeNull();
  });
});

describe('dragModifier="shift" — only enforced while pan is enabled', () => {
  it('with pan ON: a plain drag pans, a shift-drag releases the span', () => {
    const onDragRelease = vi.fn();
    const onTimeRangeChange = vi.fn();
    const { surface } = mount(
      <RangeCursor onDragRelease={onDragRelease} dragModifier="shift" />,
      { panZoom: 'pan', onTimeRangeChange },
    );
    // Plain drag → pan, no release.
    drag(surface, 200, 60);
    expect(onDragRelease).not.toHaveBeenCalled();
    expect(onTimeRangeChange).toHaveBeenCalled();
    // Shift-drag → release, no (further) pan.
    onTimeRangeChange.mockClear();
    drag(surface, 60, 200, { shiftKey: true });
    expect(onDragRelease).toHaveBeenCalledTimes(1);
    expect(onTimeRangeChange).not.toHaveBeenCalled();
  });

  it('with pan OFF: the modifier is not enforced — a plain drag still releases', () => {
    const onDragRelease = vi.fn();
    const { surface } = mount(
      <RangeCursor onDragRelease={onDragRelease} dragModifier="shift" />,
    );
    drag(surface, 60, 200);
    expect(onDragRelease).toHaveBeenCalledTimes(1);
  });

  it('with NO modifier and pan on, the drag preempts pan', () => {
    const onDragRelease = vi.fn();
    const onTimeRangeChange = vi.fn();
    const { surface } = mount(<RangeCursor onDragRelease={onDragRelease} />, {
      panZoom: 'pan',
      onTimeRangeChange,
    });
    drag(surface, 200, 60);
    expect(onDragRelease).toHaveBeenCalledTimes(1);
    expect(onTimeRangeChange).not.toHaveBeenCalled();
  });
});

describe('the legacy path keeps working underneath (deprecation window)', () => {
  it('cursor="region" + onRegionSelect still fires the bare pair', () => {
    const onRegionSelect = vi.fn();
    const { surface, frame } = mount(null, {
      cursor: 'region',
      onRegionSelect,
    });
    const plotWidth = frame().plotWidth;
    drag(surface, 60, 200);
    expect(onRegionSelect).toHaveBeenCalledTimes(1);
    const pair = onRegionSelect.mock.calls[0]![0] as [number, number];
    expect(Array.isArray(pair)).toBe(true);
    expect(pair[0]).toBeCloseTo((60 / plotWidth) * 1000, 6);
    expect(pair[1]).toBeCloseTo((200 / plotWidth) * 1000, 6);
  });

  it('a mounted <RangeCursor> WITHOUT drag props leaves the legacy drag live (step-2 compat)', () => {
    const onRegionSelect = vi.fn();
    const { surface } = mount(<RangeCursor />, {
      cursor: 'region',
      onRegionSelect,
    });
    drag(surface, 60, 200);
    expect(onRegionSelect).toHaveBeenCalledTimes(1);
  });

  it('a mounted <RangeCursor onDragRelease> takes the gesture over the legacy props', () => {
    const onRegionSelect = vi.fn();
    const onDragRelease = vi.fn();
    const { surface } = mount(<RangeCursor onDragRelease={onDragRelease} />, {
      cursor: 'region',
      onRegionSelect,
    });
    drag(surface, 60, 200);
    expect(onDragRelease).toHaveBeenCalledTimes(1);
    expect(onRegionSelect).not.toHaveBeenCalled();
  });

  it('onRegionSelect / regionSelectModifier dev-warn, naming the replacement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mount(null, {
        cursor: 'region',
        onRegionSelect: () => {},
        regionSelectModifier: 'shift',
      });
      const dep = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('deprecated cursor props'));
      expect(dep.length).toBe(1);
      expect(dep[0]).toContain('onRegionSelect → <RangeCursor onDragRelease>');
      expect(dep[0]).toContain(
        'regionSelectModifier → <RangeCursor dragModifier>',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('the new props do NOT warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mount(<RangeCursor onDragRelease={() => {}} dragModifier="shift" />);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('drag-to-zoom — the payload feeds ChartContainer.range directly', () => {
  it('onDragRelease={(s) => setRange(s.x)} zooms the view to the span', () => {
    function Zoomable() {
      const [range, setRange] = useState<readonly [number, number]>([0, 1000]);
      return (
        <ChartContainer range={range} width={320}>
          <RangeCursor onDragRelease={(s) => setRange(s.x)} />
          <ChartRow height={120}>
            <YAxis id="a" min={0} max={10} />
            <Layers>
              <LineChart series={series()} column="v" axis="a" />
            </Layers>
          </ChartRow>
          <Capture sink={(f) => (frame = f)} />
        </ChartContainer>
      );
    }
    let frame: ContainerFrame | null = null;
    const { container } = render(<Zoomable />);
    const surface = container.querySelector('canvas')!.parentElement!;
    const plotWidth = frame!.plotWidth;
    drag(surface, 60, 200);
    const [lo, hi] = frame!.timeRange;
    expect(lo).toBeCloseTo((60 / plotWidth) * 1000, 6);
    expect(hi).toBeCloseTo((200 / plotWidth) * 1000, 6);
  });
});

// ── The pure recognizer: the documented precedence order ────────────────────

const noopDrag = { release: () => {}, modifier: undefined } as const;

describe('resolveBrushClaim — the drag-claim precedence (RFC A1.5 / A2.7)', () => {
  it('annotation-create outranks everything', () => {
    expect(
      resolveBrushClaim({
        creating: true,
        drag: noopDrag,
        shiftKey: false,
        panEnabled: true,
        canPan: true,
      }).kind,
    ).toBe('create');
  });

  it('the range drag outranks pan when no modifier is declared', () => {
    expect(
      resolveBrushClaim({
        creating: false,
        drag: noopDrag,
        shiftKey: false,
        panEnabled: true,
        canPan: true,
      }).kind,
    ).toBe('range');
  });

  it('a declared modifier gates the drag behind the key — only while pan is on', () => {
    const drag = { release: () => {}, modifier: 'shift' } as const;
    const base = { creating: false, drag, canPan: true };
    // Pan on, no shift → pan claims.
    expect(
      resolveBrushClaim({ ...base, shiftKey: false, panEnabled: true }).kind,
    ).toBe('pan');
    // Pan on, shift held → range claims.
    expect(
      resolveBrushClaim({ ...base, shiftKey: true, panEnabled: true }).kind,
    ).toBe('range');
    // Pan off → the modifier is not enforced.
    expect(
      resolveBrushClaim({
        ...base,
        shiftKey: false,
        panEnabled: false,
        canPan: false,
      }).kind,
    ).toBe('range');
  });

  it('no claimant ⇒ none (the press is a potential click)', () => {
    expect(
      resolveBrushClaim({
        creating: false,
        drag: null,
        shiftKey: false,
        panEnabled: false,
        canPan: false,
      }).kind,
    ).toBe('none');
  });
});

describe('resolveRangeDrag — who gets the released span', () => {
  const legacyFree = {
    cursor: 'line',
    onRegionSelect: undefined,
    regionSelectModifier: undefined,
    xKind: 'time',
  } as const;
  const entry = (over: Partial<CursorEntry>): CursorEntry => ({
    spec: {},
    rowKey: null,
    legacy: false,
    ownsGesture: true,
    wants: {
      samples: false,
      flags: false,
      band: false,
      pointer: false,
      time: false,
    },
    ...over,
  });

  it('a drag-enabled component owner wins and wraps the { x } payload', () => {
    const seen: RangeSpan[] = [];
    const d = resolveRangeDrag(
      legacyFree,
      entry({ onDragRelease: (s) => seen.push(s), enableDrag: true }),
    );
    expect(d).not.toBeNull();
    d!.release(3, 7);
    expect(seen).toEqual([{ x: [3, 7] }]);
  });

  it('a frozen owner (enableDrag false) blocks BOTH paths', () => {
    const d = resolveRangeDrag(
      {
        ...legacyFree,
        cursor: 'region',
        onRegionSelect: () => {},
      },
      entry({ onDragRelease: () => {}, enableDrag: false }),
    );
    expect(d).toBeNull();
  });

  it('an owner without onDragRelease falls through to the legacy props', () => {
    const pairs: (readonly [number, number])[] = [];
    const d = resolveRangeDrag(
      {
        ...legacyFree,
        cursor: 'region',
        onRegionSelect: (r) => pairs.push(r),
        regionSelectModifier: 'shift',
      },
      entry({}),
    );
    expect(d).not.toBeNull();
    expect(d!.modifier).toBe('shift');
    d!.release(1, 2);
    expect(pairs).toEqual([[1, 2]]);
  });

  it('a LEGACY-shim owner never claims the component path', () => {
    const d = resolveRangeDrag(
      legacyFree,
      entry({ legacy: true, onDragRelease: () => {}, enableDrag: true }),
    );
    expect(d).toBeNull();
  });

  it('a category axis has no span to drag — both paths gate off', () => {
    const d = resolveRangeDrag(
      {
        cursor: 'region',
        onRegionSelect: () => {},
        regionSelectModifier: undefined,
        xKind: 'category',
      },
      entry({ onDragRelease: () => {}, enableDrag: true }),
    );
    expect(d).toBeNull();
  });
});
