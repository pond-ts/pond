import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { defaultTheme } from '../src/theme.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';
import { type DiscontinuityProvider } from '../src/tradingTimeScale.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

/** Two live spans [0,100) and [200,300) with a dead gap between (100..200). */
const provider: DiscontinuityProvider = (() => {
  const liveMs = (t: number): number =>
    t <= 0 ? 0 : t >= 300 ? 200 : t < 100 ? t : t < 200 ? 100 : 100 + (t - 200);
  const instantFor = (L: number): number =>
    L <= 0 ? 0 : L >= 200 ? 300 : L < 100 ? L : 200 + (L - 100);
  const self: DiscontinuityProvider = {
    distance: (a, b) => liveMs(b) - liveMs(a),
    offset: (v, amt) => instantFor(liveMs(v) + amt),
    clampUp: (t) => t,
    clampDown: (t) => t,
    copy: () => self,
    // One collapse point, at the start of the second span (200).
    boundaries: (from, to) => (from < 200 && to > 200 ? [200] : []),
  };
  return self;
})();

function frameOf(props: Record<string, unknown>): ContainerFrame {
  let frame: ContainerFrame | null = null;
  render(
    <ChartContainer range={[0, 300]} width={320} {...props}>
      <Capture sink={(f) => (frame = f)} />
    </ChartContainer>,
  );
  return frame!;
}

describe('ChartContainer discontinuities → trading-time axis', () => {
  it('selects a trading-time scale that collapses the gap', () => {
    const f = frameOf({ discontinuities: provider });
    expect(f.discontinuities).toBe(provider);
    expect(f.xKind).toBe('time');

    // Session-0 end (100) and session-1 start (200) map to the same pixel —
    // the dead gap between them has collapsed.
    expect(Math.abs(f.xScale(100) - f.xScale(200))).toBeLessThan(1);
    // Proportional within each session.
    expect(f.xScale(50)).toBeGreaterThan(f.xScale(0));
    expect(f.xScale(50)).toBeLessThan(f.xScale(100));
    expect(f.xScale(250)).toBeGreaterThan(f.xScale(200));
    expect(f.xScale(250)).toBeLessThan(f.xScale(300));
    // The two sessions get equal pixel width (each is half the trading time).
    const w0 = f.xScale(100) - f.xScale(0);
    const w1 = f.xScale(300) - f.xScale(200);
    expect(Math.abs(w0 - w1)).toBeLessThan(0.001);
  });

  it('without the prop, a plain time scale keeps the gap open (control)', () => {
    const f = frameOf({});
    expect(f.discontinuities).toBeUndefined();
    // On a continuous scale the 100..200 gap occupies real width — 100/300 of it.
    const gapPx = f.xScale(200) - f.xScale(100);
    expect(gapPx).toBeGreaterThan(50);
  });

  it('drops the provider on a value axis so pan/zoom stay continuous (Codex P1)', () => {
    // A value-keyed (distance) row makes this a value axis; the trading provider
    // must be gated off the frame so interactions use continuous value math.
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
      <ChartContainer discontinuities={provider} width={320}>
        <ChartRow height={100}>
          <YAxis id="a" min={100} max={160} />
          <Layers>
            <LineChart series={rideByDistance} column="hr" axis="a" />
          </Layers>
          <Capture sink={(f) => (frame = f)} />
        </ChartRow>
      </ChartContainer>,
    );
    const f = frame!;
    expect(f.xKind).toBe('value');
    expect(f.discontinuities).toBeUndefined(); // gated off on a value axis
  });

  it('draws a session divider at each boundary (strokes the divider color)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const;
    const series = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [10, 1],
        [250, 2],
      ] as [number, number][],
    });
    const tree = (props: Record<string, unknown>) => (
      <ChartContainer range={[0, 300]} width={320} {...props}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={5} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
    const dividerColor = defaultTheme.axis.sessionDivider!;

    const withStub = stubCanvasContext();
    try {
      render(tree({ discontinuities: provider }));
      const stroked = withStub.calls.some(
        (c) =>
          c.type === 'set' &&
          c.name === 'strokeStyle' &&
          c.args[0] === dividerColor,
      );
      expect(stroked).toBe(true); // the divider was drawn
    } finally {
      withStub.restore();
    }
    cleanup();

    // Control: no provider → no divider color stroked.
    const noStub = stubCanvasContext();
    try {
      render(tree({}));
      const stroked = noStub.calls.some(
        (c) =>
          c.type === 'set' &&
          c.name === 'strokeStyle' &&
          c.args[0] === dividerColor,
      );
      expect(stroked).toBe(false);
    } finally {
      noStub.restore();
    }
  });
});
