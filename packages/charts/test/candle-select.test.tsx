import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { Candlestick } from '../src/Candlestick.js';
import { YAxis } from '../src/YAxis.js';
import { defaultTheme } from '../src/theme.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
  type SelectInfo,
} from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';
import { ohlcFromTimeSeries } from '../src/data.js';

afterEach(cleanup);

/**
 * `<Candlestick>` selection — the id-gated contract the other marks carry, and
 * the one place it has to differ.
 *
 * A bar swaps its fill and a box rotates its tint ladder, because on those
 * marks hue is free. **A candle's hue is its meaning** — rising vs falling is
 * the first thing read off it — so the state cues here are everything *but*
 * colour: an outline around the slot, a heavier wick, and the field receding
 * by opacity. These tests exist mostly to pin that the direction colours
 * survive every state.
 */

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 0, 5);

/** Four candles: up, down, up, down — so both direction colours are always on
 *  screen and a state that flattened them would be visible here. */
const bars = () =>
  new TimeSeries({
    name: 'ohlc',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'open', kind: 'number' },
      { name: 'high', kind: 'number' },
      { name: 'low', kind: 'number' },
      { name: 'close', kind: 'number' },
    ] as const,
    rows: [
      [D0, 100, 106, 99, 105],
      [D0 + DAY, 105, 106, 99, 100],
      [D0 + 2 * DAY, 100, 106, 99, 105],
      [D0 + 3 * DAY, 105, 106, 99, 100],
    ] as [number, number, number, number, number][],
  });

function mount(props: Record<string, unknown> = {}, id: string | null = 'c') {
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
      <ChartContainer
        range={[D0 - DAY / 2, D0 + 3.5 * DAY]}
        width={400}
        showAxis={false}
        {...props}
      >
        <ChartRow height={200}>
          <YAxis id="v" min={95} max={110} />
          <Layers>
            <Candlestick
              series={bars()}
              axis="v"
              {...(id !== null ? { id } : {})}
            />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const { ctx, calls } = recordingContext();
  const layer = rf!.layers[0]!.layer;
  layer.draw(ctx, cf!.xScale, rf!.yScales.get('v')!);
  const setsOf = (name: string) =>
    calls
      .filter((c) => c.type === 'set' && c.name === name)
      .map((c) => c.args[0]);
  return {
    layer,
    frame: cf!,
    yScale: rf!.yScales.get('v')!,
    strokes: setsOf('strokeStyle').map(String),
    fills: setsOf('fillStyle').map(String),
    widths: setsOf('lineWidth') as number[],
    alphas: setsOf('globalAlpha') as number[],
  };
}

const candle = defaultTheme.candle.default;

/**
 * A candle's key is its **slot begin**, and on a point-keyed series that is a
 * neighbour-spaced edge (`t − halfGap`), not the sample time — the same
 * derived geometry `<BoxPlot>`'s keys have. Read them from the very reader the
 * layer uses rather than assuming the timestamps.
 */
const KEYS = (() => {
  const o = ohlcFromTimeSeries(bars(), {
    open: 'open',
    high: 'high',
    low: 'low',
    close: 'close',
  });
  return { x: Array.from(o.x), xEnd: Array.from(o.xEnd) };
})();

const mark = (i: number): SelectInfo => ({
  id: 'c',
  key: KEYS.x[i]!,
  value: 0,
  color: '#000',
  label: 'close',
});

describe('<Candlestick id> — the id gate', () => {
  it('wires hitTest + beginSweep only with an `id`', () => {
    expect(mount().layer.hitTest).toBeDefined();
    expect(mount().layer.beginSweep).toBeDefined();
    expect(mount({}, null).layer.hitTest).toBeUndefined();
    expect(mount({}, null).layer.beginSweep).toBeUndefined();
  });

  it('publishes its slots as snap buckets, like every other column mark', () => {
    const bins = mount().layer.binIntervals?.();
    expect(bins).toHaveLength(4);
    expect(+bins![0]!.begin()).toBe(KEYS.x[0]);
    expect(+bins![0]!.end()).toBe(KEYS.xEnd[0]);
  });

  it('hit-tests the slot, reporting key = x and value = close', () => {
    const { layer, frame, yScale } = mount();
    const hit = layer.hitTest!(
      +frame.xScale(D0),
      yScale(102),
      frame.xScale,
      yScale,
      { mode: 'select' } as never,
    );
    expect(hit).not.toBeNull();
    expect(hit!.key).toBe(KEYS.x[0]);
    expect(hit!.value).toBe(105); // candle 0's close
  });

  it('sweeps a contiguous run of columns', () => {
    const session = mount().layer.beginSweep!(
      (v: number) => v,
      (v: number) => v,
    )!;
    session.update(KEYS.x[0]!, KEYS.xEnd[1]!);
    expect(session.hits().map((h) => h.key)).toEqual([KEYS.x[0], KEYS.x[1]]);
    expect(session.extent()).toEqual([KEYS.x[0], KEYS.xEnd[1]]);
  });
});

describe('a candle carries state in weight and alpha — never in hue', () => {
  it('introduces no new colour at all, in any state', () => {
    // The whole point. Candle 0 rises and candle 1 falls; a state that painted
    // either in a selection colour would stop the chart saying which way the
    // price went — so the only colours on the canvas are the direction ones.
    const palette = new Set([
      candle.rising.body,
      candle.rising.wick,
      candle.falling.body,
      candle.falling.wick,
      candle.neutral!.body,
      candle.neutral!.wick,
    ]);
    for (const props of [{ selected: [mark(0)] }, { hovered: [mark(2)] }, {}]) {
      const { fills, strokes } = mount(props);
      for (const c of [...fills, ...strokes]) expect(palette).toContain(c);
    }
  });

  it('GROWS a live candle — its body stroked in its own colour', () => {
    // Not an outline around the slot: that redraws the mark's whole footprint
    // and invents a rectangle the chart never otherwise shows. The body is
    // stroked in the colour it is already filled with, so the mark just gets
    // a little heavier.
    const rest = mount();
    const sel = mount({ selected: [mark(0)] });
    // Candle 0 rises, so the growth stroke is the rising body colour.
    expect(sel.strokes).toContain(candle.rising.body);
    expect(sel.widths).toContain(candle.liveWickWidth);
    // …and a resting chart strokes no body at all (only wicks).
    expect(sel.strokes.length).toBeGreaterThan(rest.strokes.length);
  });

  it('thickens on HOVER too — a candle has no ladder to move instead', () => {
    // The one place this differs from `<BoxPlot>`, where only selection bumps
    // the weight because hover is carried by the tint ladder.
    const rest = mount().widths;
    expect(new Set(rest)).toEqual(new Set([candle.wickWidth]));
    expect(mount({ hovered: [mark(2)] }).widths).toContain(
      candle.liveWickWidth,
    );
  });

  it('recedes the unselected field by opacity — direction hue intact', () => {
    const { alphas, fills } = mount({ selected: [mark(0)] });
    expect(alphas).toContain(candle.dimmedOpacity);
    // Receded candles keep their own colour; only the alpha moved.
    expect(fills).toContain(candle.falling.body);
  });

  it('does NOT dim the field on hover — that is what separates the two', () => {
    // Hover and selection look identical on the lit mark; the difference is
    // entirely in what happens to the others.
    expect(mount({ hovered: [mark(2)] }).alphas).not.toContain(
      candle.dimmedOpacity,
    );
  });

  it('draws nothing extra when no selection exists', () => {
    // A display-only candle must be byte-identical to before the state work.
    const { widths, alphas } = mount();
    expect(new Set(widths)).toEqual(new Set([candle.wickWidth]));
    expect(alphas).not.toContain(candle.dimmedOpacity);
  });
});
