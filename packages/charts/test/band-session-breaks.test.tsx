import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BandChart } from '../src/BandChart.js';
import { YAxis } from '../src/YAxis.js';
import type { DiscontinuityProvider } from '../src/tradingTimeScale.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * `<BandChart sessionBreaks>` consults the container's discontinuity provider
 * for the break instants inside the band's own span — the component-level
 * wiring above the `drawBand` geometry tests in `band.test.ts`. Two live spans
 * [0,100) and [200,300) with one collapse point at 200; the provider records
 * every `boundaries` call so the test can tell the band's lookup (its data
 * span, 10 → 290) apart from any the axis itself makes over the range.
 */
function spyProvider(): {
  provider: DiscontinuityProvider;
  calls: Array<[number, number]>;
} {
  const calls: Array<[number, number]> = [];
  const liveMs = (t: number): number =>
    t <= 0 ? 0 : t >= 300 ? 200 : t < 100 ? t : t < 200 ? 100 : 100 + (t - 200);
  const instantFor = (L: number): number =>
    L <= 0 ? 0 : L >= 200 ? 300 : L < 100 ? L : 200 + (L - 100);
  const provider: DiscontinuityProvider = {
    distance: (a, b) => liveMs(b) - liveMs(a),
    offset: (v, amt) => instantFor(liveMs(v) + amt),
    clampUp: (t) => t,
    clampDown: (t) => t,
    copy: () => provider,
    boundaries: (from, to) => {
      calls.push([from, to]);
      return from < 200 && to > 200 ? [200] : [];
    },
  };
  return { provider, calls };
}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'lo', kind: 'number' },
  { name: 'hi', kind: 'number' },
] as const;
const band = () =>
  new TimeSeries({
    name: 'band',
    schema,
    rows: [10, 50, 90, 210, 250, 290].map(
      (t) => [t, 1, 3] as [number, number, number],
    ),
  });

function mount(sessionBreaks: boolean): Array<[number, number]> {
  const stub = stubCanvasContext();
  const { provider, calls } = spyProvider();
  try {
    render(
      <ChartContainer range={[0, 300]} width={320} discontinuities={provider}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={5} />
          <Layers>
            <BandChart
              series={band()}
              lower="lo"
              upper="hi"
              axis="a"
              sessionBreaks={sessionBreaks}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  return calls;
}

describe('<BandChart sessionBreaks> — provider wiring', () => {
  it('asks the provider for the breaks inside the band’s own span when opted in', () => {
    const calls = mount(true);
    expect(calls).toContainEqual([10, 290]);
  });

  it('never consults the provider for the band when omitted (default false)', () => {
    const calls = mount(false);
    expect(calls).not.toContainEqual([10, 290]);
  });
});
