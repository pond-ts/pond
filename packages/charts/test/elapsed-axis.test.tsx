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
import {
  provider as sessionsProvider,
  weekdaySessions,
} from '../src/tradingAxis.fixture.js';
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
    // strip, both on the origin-anchored ticks. Rendered as the ONLY axis so
    // the assertion needs no text filter to tell the strips apart: an earlier
    // version filtered labels by `!startsWith('00:')` and so failed in UTC−10,
    // where the wall clock genuinely reads `00:33` (issue #540, finding 4).
    const { container } = render(
      <ChartContainer width={300} origin="data" showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={ride()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis format="%H:%M" />
      </ChartContainer>,
    );
    // `%H:%M` in the runner's own zone at the three origin-anchored instants —
    // computed the same way d3 would, so the expectation holds in any timezone.
    const clock = (t: number) => {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, '0')}:${String(
        d.getMinutes(),
      ).padStart(2, '0')}`;
    };
    expect(labels(container)).toEqual([
      clock(t0),
      clock(t0 + 5 * MINUTE),
      clock(t0 + 10 * MINUTE),
    ]);
  });

  it('leaves an axis with its own format owning its pill, ticks and all', () => {
    // Pill precedence is `cursorFormat → axis format → container`. The elapsed
    // container supplies a *default* finer readout, not a `cursorFormat`, so it
    // must not outrank this strip's own `format`: a wall-clock strip that ticks
    // `11:33` may not pill `00:05:12` (issue #540, finding 2).
    const { container } = render(
      <ChartContainer width={300} origin="data" showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={200} />
          <Layers>
            <LineChart series={ride()} column="hr" axis="a" />
            {/* Deliberately BETWEEN ticks (they sit at +0/+5/+10 min): a marker
                on a tick would give the pill a wall-clock label some tick
                already carries, and the positive assertion below would pass
                with the marker deleted. */}
            <Marker at={t0 + 7 * MINUTE + 30_000} indicator label={false} />
          </Layers>
        </ChartRow>
        <XAxis format="%H:%M" />
      </ChartContainer>,
    );
    const d = new Date(t0 + 7 * MINUTE + 30_000);
    const wall = `${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes(),
    ).padStart(2, '0')}`;
    const text = labels(container);
    // The pill reads its own wall clock — a label no tick on this strip carries.
    expect(text.filter((t) => t === wall)).toHaveLength(1);
    expect(text).not.toContain('00:07:30');
  });

  it('lets a container timeFormat own the pill as well as the labels', () => {
    // `timeFormat`'s documented back-compat: absent a `cursorFormat` it shapes
    // the readout too. Under `origin` the elapsed default was overruling it —
    // the same inversion as the `<XAxis format>` one, a rung further down
    // (PR #541 review).
    const { container } = render(
      <ChartContainer
        width={300}
        origin="data"
        timeFormat={() => 'CUSTOM'}
        showAxis={false}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={200} />
          <Layers>
            <LineChart series={ride()} column="hr" axis="a" />
            <Marker at={t0 + 7 * MINUTE + 30_000} indicator label={false} />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    // Ticks and pill alike: the custom format owns every label on the strip.
    expect(labels(container)).not.toContain('00:07:30');
    expect(labels(container).filter((t) => t === 'CUSTOM').length).toBe(4);
  });

  it('still lets a real cursorFormat outrank an axis format', () => {
    // The other side of the same rung: a `cursorFormat` IS allowed to beat an
    // axis `format`, so the fix above must not have flattened the precedence.
    const { container } = render(
      <ChartContainer
        width={300}
        origin="data"
        cursorFormat={() => 'PILL'}
        showAxis={false}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={200} />
          <Layers>
            <LineChart series={ride()} column="hr" axis="a" />
            <Marker at={t0 + 5 * MINUTE} indicator label={false} />
          </Layers>
        </ChartRow>
        <XAxis format="%H:%M" />
      </ChartContainer>,
    );
    expect(labels(container)).toContain('PILL');
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

  it('never stacks two ticks on one pixel across a collapsed session', () => {
    // The duration walk is in wall-clock ms, so a ladder striding through a
    // closed market puts several ticks inside the gap — and a trading scale
    // maps every one of them to the same seam pixel. Unfiltered that renders
    // labels on top of labels (issue #540, finding 1). Three weekday sessions
    // 09:30–16:00: the overnight gaps are 17.5h, so a 12h-or-finer step lands
    // repeatedly inside them.
    const sessions = weekdaySessions(3);
    const span = new TimeSeries({
      name: 'sessions',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: sessions.map((s, i) => [s.open, 10 + i] as [number, number]),
    });
    const { container } = render(
      <ChartContainer
        width={900}
        origin="data"
        discontinuities={sessionsProvider(sessions)}
        showAxis={false}
      >
        <ChartRow height={120}>
          <Layers>
            <LineChart series={span} column="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    const xs = tickMarkXs(container);
    expect(xs.length).toBeGreaterThan(1);
    // Every rendered tick sits on its own pixel — the labels can crowd, but
    // they may never coincide.
    expect(new Set(xs).size).toBe(xs.length);
    // …and one label per tick: no two share a position.
    expect(labels(container).length).toBe(xs.length);
    // The survivor at a seam is the LAST tick of the group — the session open
    // that genuinely sits on that pixel (`1d 00:00` = Tuesday 09:30), not the
    // first, which is a moment inside the collapsed night (`12:00` = 21:30,
    // market shut). First-wins renders a label for time the axis doesn't draw.
    const text = labels(container);
    expect(text).toContain('1d 00:00');
    expect(text).not.toContain('12:00');
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
