import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BarChart } from '../src/BarChart.js';
import { CategoryAxis } from '../src/CategoryAxis.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import { Marker } from '../src/annotations.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const MINUTE = 60_000;

/** A ten-minute ride starting at a deliberately un-round wall clock, so a
 *  duration axis and a wall-clock axis can never be confused. */
const t0 = Date.UTC(2026, 0, 15, 10, 33, 17);
const ride = () =>
  new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows: [
      [t0, 120],
      [t0 + 5 * MINUTE, 140],
      [t0 + 10 * MINUTE, 150],
    ],
  });

/** The same ride re-keyed onto cumulative distance — a value x axis that does
 *  not start at zero (where an offset axis actually says something). */
const rideByDistance = () =>
  new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cumDist', kind: 'number' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows: [
      [t0, 1200, 120],
      [t0 + 5 * MINUTE, 3000, 140],
      [t0 + 10 * MINUTE, 5300, 150],
    ],
  }).byValue('cumDist');

/** Every leaf label the axis strip rendered, in DOM order. */
const labels = (dom: HTMLElement): string[] =>
  Array.from(dom.querySelectorAll('div'))
    .filter((el) => el.childElementCount === 0)
    .map((el) => (el.textContent ?? '').trim())
    .filter((t) => t !== '');

/** The plot-pixel x of each rendered tick mark (the 1px rules `<XAxis>` drops
 *  from the axis line), rounded to compare against the canvas gridlines. */
const tickMarkXs = (dom: HTMLElement): number[] =>
  Array.from(dom.querySelectorAll('div'))
    .filter((el) => (el as HTMLElement).style.width === '1px')
    .map((el) => Math.round(parseFloat((el as HTMLElement).style.left)))
    .sort((a, b) => a - b);

describe('duration x axis — <ChartContainer origin>', () => {
  it('reads durations from the start of the series, not the wall clock', () => {
    // 300px / 65px-per-tick ⇒ 4 ticks over ten minutes ⇒ a 5-minute step: the
    // headline swap, `10:33 10:38 10:43` → `00:00 00:05 00:10`.
    const { container } = render(
      <ChartContainer width={300} origin="data" showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={ride()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    expect(labels(container)).toEqual(['00:00', '00:05', '00:10']);
  });

  it('signs the offsets before an explicit origin (the T-minus case)', () => {
    const { container } = render(
      <ChartContainer width={300} origin={t0 + 5 * MINUTE} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={ride()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    expect(labels(container)).toEqual(['-00:05', '00:00', '00:05']);
  });

  it("anchors to the data's start, not the view's", () => {
    // A view panned back before the first sample: `'data'` keeps zero on the
    // first sample (so the labels go negative) rather than re-zeroing at the
    // left edge. Were it view-anchored this would read `00:00 00:05 00:10`.
    const { container } = render(
      <ChartContainer
        width={300}
        range={[t0 - 5 * MINUTE, t0 + 5 * MINUTE]}
        origin="data"
        showAxis={false}
      >
        <ChartRow height={120}>
          <Layers>
            <LineChart series={ride()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    expect(labels(container)).toEqual(['-00:05', '00:00', '00:05']);
  });

  it('offsets a value axis from the data start too', () => {
    // Absolute, this axis ticks 2,000 … 5,000; offset from its 1,200 start it
    // ticks 0 … 4,000 — distance travelled, not distance recorded.
    const { container } = render(
      <ChartContainer width={400} origin="data" showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    const text = labels(container);
    expect(text).toEqual(['0', '1,000', '2,000', '3,000', '4,000']);
    expect(text).not.toContain('5,000');
  });

  it('keeps the gridlines under the duration ticks', () => {
    // The elapsed scale exposes no calendar `gridLevels`, so `Layers` draws its
    // verticals at the labelled ticks — a gridline at 10:35 under a `00:00`
    // label would be the whole feature failing quietly.
    const stub = stubCanvasContext();
    try {
      const { container } = render(
        <ChartContainer width={300} origin="data" showAxis={false}>
          <ChartRow height={120}>
            <Layers>
              <LineChart series={ride()} column="hr" />
            </Layers>
          </ChartRow>
          <XAxis />
        </ChartContainer>,
      );
      const lastClear = stub.calls.map((c) => c.name).lastIndexOf('clearRect');
      // drawGrid brackets itself in save/restore; verticals are the moveTo(x, 0)
      // pairs inside that window (horizontals start at x=0, y=…+0.5).
      const end = stub.calls.findIndex(
        (c, i) => i > lastClear && c.name === 'restore',
      );
      const verticals = stub.calls
        .slice(lastClear, end === -1 ? undefined : end)
        .filter((c) => c.name === 'moveTo' && c.args[1] === 0)
        // drawGrid strokes at `Math.round(px) + 0.5` for a crisp 1px line.
        .map((c) => Math.floor(c.args[0] as number))
        .sort((a, b) => a - b);
      expect(verticals.length).toBe(3);
      expect(verticals).toEqual(tickMarkXs(container));
    } finally {
      stub.restore();
    }
  });

  it('lets an explicit time specifier label the wall clock on the same ticks', () => {
    // A d3 time specifier can only describe an instant, so `<XAxis format>`
    // reads the absolute time — the wall-clock strip stacked under a duration
    // strip, both on the origin-anchored ticks.
    const { container } = render(
      <ChartContainer width={300} origin="data" showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={ride()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis />
        <XAxis format="%H:%M" />
      </ChartContainer>,
    );
    const clocks = labels(container).filter((t) => !t.startsWith('00:'));
    expect(clocks).toHaveLength(3);
    // Whatever the runner's timezone, the three wall clocks are the same five
    // minutes apart as the duration ticks — one shared tick set, two languages.
    const mins = clocks.map((t) => {
      const [h, m] = t.split(':').map(Number);
      return h! * 60 + m!;
    });
    expect(mins[1]! - mins[0]!).toBe(5);
    expect(mins[2]! - mins[1]!).toBe(5);
  });

  it('reads the cursor pill one grain finer than the ticks', () => {
    // `<Marker indicator>` pins its instant to the x axis through the readout
    // channel: `00:05` on the ticks, `00:05:12` on the pill.
    const { container } = render(
      <ChartContainer width={300} origin="data" showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={200} />
          <Layers>
            <LineChart series={ride()} column="hr" axis="a" />
            <Marker at={t0 + 5 * MINUTE + 12_000} indicator label={false} />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    expect(labels(container)).toContain('00:05:12');
  });

  it('hands a cursorFormat function the elapsed default text', () => {
    const { container } = render(
      <ChartContainer
        width={300}
        origin="data"
        cursorFormat={(_v, { defaultText }) => `[${defaultText}]`}
        showAxis={false}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={200} />
          <Layers>
            <LineChart series={ride()} column="hr" axis="a" />
            <Marker at={t0 + 5 * MINUTE + 12_000} indicator label={false} />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    expect(labels(container)).toContain('[00:05:12]');
  });

  it('is ignored on a category axis, which reads names', () => {
    const { container } = render(
      <ChartContainer width={400} origin="data" showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="v" min={0} />
          <Layers>
            <BarChart
              categories={[
                { label: 'AAPL', value: 10 },
                { label: 'MSFT', value: 20 },
              ]}
            />
          </Layers>
          <CategoryAxis />
        </ChartRow>
      </ChartContainer>,
    );
    expect(container.textContent).toContain('AAPL');
    expect(container.textContent).toContain('MSFT');
  });
});
