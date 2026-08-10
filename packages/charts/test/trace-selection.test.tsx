import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { AreaChart } from '../src/AreaChart.js';
import { YAxis } from '../src/YAxis.js';
import { MultiSelector } from '../src/selectors.js';
import { sweepSpan } from '../src/sweep.js';
import { sliceTrace, traceHitIndex } from '../src/line.js';
import { areaHitIndex } from '../src/area.js';
import { sameMark, selectionContains } from '../src/span.js';
import { RowContext, type RowFrame } from '../src/context.js';
import type { SelectInfo, SpanSelection } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **Selection on a continuous trace** ([PND-TRACESEL]) — the last two columns
 * of the selection matrix, and the one place where the premise "a trace has no
 * marks" had to be taken seriously rather than worked around.
 *
 * Two claims carry the design, and both are pinned below:
 *
 * 1. **A sweep commits a span with NO hits.** Empty is the answer, not a
 *    shortfall — a trace's samples are usually undrawn and there are several
 *    per pixel, so "the samples you swept" is a set the user never expressed,
 *    and materialising them is the A8.1 cliff.
 * 2. **A click commits a series-scoped entry that can still be deselected.**
 *    `key`/`value` are `NaN` because no sample was selected, and a stable
 *    `mark` is what gives the entry identity — `sameMark` prefers `mark` over
 *    `key`, so re-clicking toggles. Without the `mark` it could never:
 *    `NaN !== NaN`.
 */

const T = (i: number) => i * 1000;
/** A rising line, 0..4000 on x, 1..5 on y. */
const line = () =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [T(i), i + 1]) as [
      number,
      number,
    ][],
  });
// **There is no gappy fixture here on purpose.** A `TimeSeries` cannot hold a
// gap in a number column — NaN, `null` and `undefined` are all rejected by
// validation — so a gap only ever reaches a chart as NaN in the Float64Array
// an operator produced. The gap cases are therefore pinned at the unit level
// below, against a raw `ChartSeries`, which is the only honest place for them.

describe('`sweepSpan` — the span-only session', () => {
  const cs = { x: new Float64Array([0, 10]), y: new Float64Array([0, 1]) };
  void cs;

  it('reports the drag window, and never any hits', () => {
    const s = sweepSpan({ id: 'a' });
    expect(s.update(100, 400)).toBe(true);
    expect(s.extent()).toEqual([100, 400]);
    // The whole point: nothing to materialise, ever.
    expect(s.hits()).toEqual([]);
    // …and the empty array is identity-stable, so an empty preview never
    // mints one (the same `NO_HITS` discipline the other sessions keep).
    expect(s.hits()).toBe(s.hits());
  });

  it('orders a reversed drag', () => {
    const s = sweepSpan({ id: 'a' });
    s.update(400, 100);
    expect(s.extent()).toEqual([100, 400]);
  });

  it('clamps to the trace’s own span', () => {
    // A drag off the end must not commit a range the series never covered.
    const s = sweepSpan({ id: 'a', bounds: [0, 5000] });
    s.update(-2000, 9000);
    expect(s.extent()).toEqual([0, 5000]);
  });

  it('a window entirely outside the bounds covers nothing', () => {
    // Reported as "no extent" rather than a zero-width span, so a release past
    // the data reads as the swept-empty deselect every other layer gives.
    const s = sweepSpan({ id: 'a', bounds: [0, 5000] });
    expect(s.update(6000, 7000)).toBe(true);
    expect(s.extent()).toBeNull();
  });

  it('gates on change — an unchanged window re-reports nothing', () => {
    // The delta gate is why this is cheap; without it every pointer move would
    // re-render the preview.
    const s = sweepSpan({ id: 'a' });
    expect(s.update(100, 400)).toBe(true);
    expect(s.update(100, 400)).toBe(false);
    expect(s.update(100, 401)).toBe(true);
  });

  it('is 1-D — it declares no second dimension', () => {
    const s = sweepSpan({ id: 'a' });
    expect(s.twoD).toBeUndefined();
    expect(s.extent2D).toBeUndefined();
  });
});

describe('`traceHitIndex` — distance to the drawn path', () => {
  const cs = {
    x: new Float64Array([0, 100, 200]),
    y: new Float64Array([0, 100, 0]),
    length: 3,
  };
  const id = (v: number) => v; // scales are identity, so px === data

  it('hits on the path and misses off it', () => {
    // Midway up the first leg: the path passes through (50, 50).
    expect(traceHitIndex(cs, 50, 50, id, id)).not.toBeNull();
    // Same x, far above the leg.
    expect(traceHitIndex(cs, 50, 0, id, id)).toBeNull();
  });

  it('measures to the SEGMENT, not to the nearest vertex', () => {
    // The distinguishing case: (50,50) is 70px from either vertex but 0px from
    // the segment between them. A vertex-distance implementation would miss.
    const dv = Math.hypot(50 - 0, 50 - 0);
    expect(dv).toBeGreaterThan(6);
    expect(traceHitIndex(cs, 50, 50, id, id)).not.toBeNull();
  });

  it('honours the tolerance', () => {
    expect(traceHitIndex(cs, 50, 54, id, id)).not.toBeNull(); // ~2.8px off
    expect(traceHitIndex(cs, 50, 70, id, id)).toBeNull(); // ~14px off
  });

  it('a gap is a hole, not a bridge', () => {
    // Either end non-finite ⇒ the segment is not drawn, so it cannot be hit.
    const g = {
      x: new Float64Array([0, 100, 200]),
      y: new Float64Array([0, NaN, 0]),
      length: 3,
    };
    expect(traceHitIndex(g, 50, 50, id, id)).toBeNull();
    expect(traceHitIndex(g, 50, 0, id, id)).toBeNull();
  });

  it('a single-sample trace is still hittable', () => {
    // It draws no segment, so a segments-only implementation makes it
    // unreachable — a real series can be one point after a filter.
    const one = {
      x: new Float64Array([50]),
      y: new Float64Array([50]),
      length: 1,
    };
    expect(traceHitIndex(one, 50, 50, id, id)).toBe(0);
    expect(traceHitIndex(one, 50, 80, id, id)).toBeNull();
  });

  it('an empty series is a miss, not a throw', () => {
    const none = { x: new Float64Array(), y: new Float64Array(), length: 0 };
    expect(traceHitIndex(none, 0, 0, id, id)).toBeNull();
  });
});

describe('`sliceTrace` — the path whose ends ARE the window', () => {
  // Why this exists rather than clipping the emphasised pass: a clipped stroke
  // is sheared on a vertical line wherever the rect cuts it, so `lineCap`
  // never shows — the cap is drawn off in the hidden part of the path. Slicing
  // gives the emphasised segment real endpoints, which can be rounded.
  const cs = {
    x: new Float64Array([0, 10, 20, 30]),
    y: new Float64Array([0, 10, 20, 30]),
    length: 4,
  };

  it('interpolates both endpoints onto the path', () => {
    // The boundary lands between samples, and the emphasis has to start
    // exactly there — snapping to the nearest sample would over- or
    // under-shoot the window the reader just swept, so the emphasis would not
    // line up with the band that produced it.
    const out = sliceTrace(cs, 5, 25)!;
    expect(out).not.toBeNull();
    expect([...out.x]).toEqual([5, 10, 20, 25]);
    expect([...out.y]).toEqual([5, 10, 20, 25]); // y = x here
  });

  it('keeps interior samples untouched', () => {
    const out = sliceTrace(cs, 0, 30)!;
    expect([...out.x]).toEqual([0, 10, 20, 30]);
  });

  it('a boundary on a gap contributes no point', () => {
    // No drawn segment there to sit on, and inventing one would bridge a hole
    // the trace deliberately shows.
    const g = {
      x: new Float64Array([0, 10, 20, 30]),
      y: new Float64Array([0, NaN, 20, 30]),
      length: 4,
    };
    const out = sliceTrace(g, 5, 25)!;
    // The head would have to interpolate across the NaN at index 1 — skipped.
    expect(out.x[0]).not.toBe(5);
    expect([...out.x]).toEqual([10, 20, 25]);
  });

  it('a window past the data yields null, not an empty path', () => {
    expect(sliceTrace(cs, 100, 200)).toBeNull();
    expect(sliceTrace(cs, -200, -100)).toBeNull();
  });

  it('a collapsed or reversed window yields null', () => {
    expect(sliceTrace(cs, 10, 10)).toBeNull();
    expect(sliceTrace(cs, 20, 10)).toBeNull();
  });

  it('an empty series yields null', () => {
    expect(
      sliceTrace(
        { x: new Float64Array(), y: new Float64Array(), length: 0 },
        0,
        1,
      ),
    ).toBeNull();
  });
});

describe('`areaHitIndex` — inside the fill, not on the edge', () => {
  const cs = {
    x: new Float64Array([0, 100, 200]),
    y: new Float64Array([50, 50, 50]),
    length: 3,
  };
  const id = (v: number) => v;

  it('the whole filled shape is the target', () => {
    // A flat trace at y=50 with baseline 0: everything between is inside.
    expect(areaHitIndex(cs, 0, 100, 25, id, id)).not.toBeNull();
    expect(areaHitIndex(cs, 0, 100, 49, id, id)).not.toBeNull();
    // This is the difference from a line: a point well away from the stroke
    // is still a hit, because the fill is the mark.
    expect(traceHitIndex(cs, 100, 25, id, id)).toBeNull();
  });

  it('outside the fill, on either side, is a miss', () => {
    // Careful with direction: the scales here are identity, so a LARGER py is
    // lower on screen. The fill occupies pixels 0…50 (trace at 50, baseline at
    // 0), so a miss is beyond that band by more than the tolerance — which is
    // the pair worth asserting, not "above the trace" in data terms.
    expect(areaHitIndex(cs, 0, 100, -7, id, id)).toBeNull();
    expect(areaHitIndex(cs, 0, 100, 57, id, id)).toBeNull();
    // …and just inside the tolerance still hits, so the edge is grabbable.
    expect(areaHitIndex(cs, 0, 100, -5, id, id)).not.toBeNull();
  });

  it('follows the drawn slope rather than stepping', () => {
    // A ramp from 0 to 100 over x 0..100. At x=50 the edge is at 50, so a
    // point at y=40 is inside and one at y=60 is not (plus tolerance).
    const ramp = {
      x: new Float64Array([0, 100]),
      y: new Float64Array([0, 100]),
      length: 2,
    };
    expect(areaHitIndex(ramp, 0, 50, 40, id, id)).not.toBeNull();
    expect(areaHitIndex(ramp, 0, 50, 70, id, id)).toBeNull();
  });

  it('outside the series’ x span there is no fill to be inside of', () => {
    expect(areaHitIndex(cs, 0, 400, 25, id, id)).toBeNull();
    expect(areaHitIndex(cs, 0, -400, 25, id, id)).toBeNull();
  });

  it('a gap is a hole here too', () => {
    const g = {
      x: new Float64Array([0, 100, 200]),
      y: new Float64Array([50, NaN, 50]),
      length: 3,
    };
    expect(areaHitIndex(g, 0, 100, 25, id, id)).toBeNull();
  });
});

/** Mount a trace under a `<MultiSelector>` and hand back a driver. */
function mount(node: React.ReactNode) {
  const seen: Array<{
    hits: readonly SelectInfo[];
    span: SpanSelection | null;
    spans: readonly SpanSelection[];
  }> = [];
  let rf: RowFrame | null = null;
  function Capture() {
    const r = useContext(RowContext);
    useEffect(() => {
      if (r) rf = r;
    });
    return null;
  }
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    dom = render(
      <ChartContainer range={[0, 4000]} width={320}>
        <MultiSelector
          onSelect={(hits, _m, span, spans) => seen.push({ hits, span, spans })}
        />
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={6} />
          <Layers>
            {node}
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;
  } finally {
    stub.restore();
  }
  const surface = dom.querySelector('canvas')!.parentElement!;
  const ev = (type: string, x: number, y: number, buttons: number) =>
    act(() => {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons,
          pointerId: 1,
        }),
      );
    });
  return {
    seen,
    frame: () => rf!,
    sweep(x0: number, x1: number, y = 60) {
      ev('pointerdown', x0, y, 1);
      ev('pointermove', x1, y, 1);
      ev('pointerup', x1, y, 0);
    },
  };
}

describe('a sweep over a trace commits a span with no marks', () => {
  it('`<LineChart id>` reports a span and an empty hit list', () => {
    const t = mount(<LineChart series={line()} column="v" axis="a" id="cpu" />);
    t.sweep(40, 240);
    expect(t.seen).toHaveLength(1);
    const { hits, span } = t.seen[0]!;
    expect(span).not.toBeNull();
    expect(span!.id).toBe('cpu');
    expect(span!.x[0]).toBeLessThan(span!.x[1]);
    // The design's first claim, asserted directly.
    expect(hits).toEqual([]);
    // 1-D: no second dimension is claimed.
    expect(span!.y).toBeUndefined();
    expect(span!.rows).toBeUndefined();
  });

  it('`<AreaChart id>` does the same — one currency, two layers', () => {
    const t = mount(<AreaChart series={line()} column="v" axis="a" id="net" />);
    t.sweep(40, 240);
    expect(t.seen[0]!.span?.id).toBe('net');
    expect(t.seen[0]!.hits).toEqual([]);
  });

  it('the span is clamped to the trace, not to the drag', () => {
    // Dragged well past both ends; the committed range cannot exceed the data.
    const t = mount(<LineChart series={line()} column="v" axis="a" id="cpu" />);
    t.sweep(0, 320);
    const span = t.seen[0]!.span!;
    expect(span.x[0]).toBeGreaterThanOrEqual(0);
    expect(span.x[1]).toBeLessThanOrEqual(4000);
  });

  it('no `id` ⇒ no sweep at all — the trace stays inert', () => {
    const t = mount(<LineChart series={line()} column="v" axis="a" />);
    t.sweep(40, 240);
    expect(t.seen).toHaveLength(0);
    const entry = t.frame().layers.at(-1)!;
    expect(entry.layer.beginSweep).toBeUndefined();
    expect(entry.layer.hitTest).toBeUndefined();
  });

  it('declares a 1-D x cut, and its session agrees', () => {
    // The `sweep-capabilities` contract: the layer's declaration and the
    // session it builds must not disagree about the shape of the gesture.
    const t = mount(<LineChart series={line()} column="v" axis="a" id="cpu" />);
    const entry = t.frame().layers.at(-1)!;
    expect(entry.layer.sweepsRect).toBe(false);
    expect(entry.layer.sweepAxis).toBe('x');
    const s = entry.layer.beginSweep!(
      (v: number) => v,
      (v: number) => v,
    );
    expect(s).not.toBeNull();
    expect(s!.twoD).not.toBe(true);
  });
});

describe('a sweep covers EVERY trace in the row', () => {
  // The PR's headline behaviour, and it had no assertions at all — which is
  // exactly what let the span ORDER bug through (`spans[0]` was the
  // bottom-most layer while `span` reported the topmost, contradicting the
  // documented relationship). Reviewer finding; this is the test that pins it.
  const two = (
    <>
      <LineChart series={line()} column="v" axis="a" id="cpu" />
      <LineChart series={line()} column="v" axis="a" id="mem" />
    </>
  );

  it('reports one span per trace, not just the topmost', () => {
    const t = mount(two);
    t.sweep(40, 240);
    expect(t.seen).toHaveLength(1);
    const { spans } = t.seen[0]!;
    expect(spans.map((s) => s.id).sort()).toEqual(['cpu', 'mem']);
  });

  it('`spans[0]` is the same layer `span` reports', () => {
    // The documented relationship. `beginTopmostSweep` scans descending and
    // `beginSpanOnlySweeps` used to scan ascending, so on a two-trace row the
    // two disagreed about which layer they meant.
    const t = mount(two);
    t.sweep(40, 240);
    const { span, spans } = t.seen[0]!;
    expect(span).not.toBeNull();
    expect(spans[0]!.id).toBe(span!.id);
  });

  it('names each trace exactly once', () => {
    // The duplicate-span bug: the claimant was prepended AND appeared again in
    // the span-only set, because those are separately-built sessions.
    const t = mount(two);
    t.sweep(40, 240);
    const ids = t.seen[0]!.spans.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('still reports no marks — plural spans, zero hits', () => {
    const t = mount(two);
    t.sweep(40, 240);
    expect(t.seen[0]!.hits).toEqual([]);
  });

  it('a single trace reports exactly one span', () => {
    const t = mount(<LineChart series={line()} column="v" axis="a" id="cpu" />);
    t.sweep(40, 240);
    expect(t.seen[0]!.spans.map((s) => s.id)).toEqual(['cpu']);
  });
});

describe('a click on a trace is series-scoped — and can be deselected', () => {
  /** The `hitTest` a click would run, at the layer level. */
  const hitAt = (
    node: React.ReactNode,
    px: number,
    py: number,
    xs: (v: number) => number,
    ys: (v: number) => number,
  ) => {
    const t = mount(node);
    return t.frame().layers.at(-1)!.layer.hitTest!(px, py, xs, ys);
  };
  /** …with identity scales, where px reads as data units. */
  const hitOf = (node: React.ReactNode, px: number, py: number) =>
    hitAt(
      node,
      px,
      py,
      (v) => v,
      (v) => v,
    );

  it('carries NaN key and value — no sample was selected', () => {
    // A trace has no marks, so there is nothing for `key` to name. `NaN` is
    // what that already means in this currency (see `SelectInfo.key`).
    const hit = hitOf(
      <LineChart series={line()} column="v" axis="a" id="cpu" />,
      1000,
      2,
    );
    expect(hit).not.toBeNull();
    expect(Number.isNaN(hit!.key)).toBe(true);
    expect(Number.isNaN(hit!.value)).toBe(true);
    expect(hit!.id).toBe('cpu');
  });

  it('…and a stable `mark`, which is what makes it deselectable', () => {
    // **The load-bearing assertion of the whole design.** Two clicks at
    // different x must be the SAME selection, or the documented toggle policy
    // can never remove a trace from `selected`. `sameMark` prefers `mark` over
    // `key`, so this works; on `key` alone it could not, because NaN !== NaN.
    const a = hitOf(
      <LineChart series={line()} column="v" axis="a" id="cpu" />,
      1000,
      2,
    );
    cleanup();
    const b = hitOf(
      <LineChart series={line()} column="v" axis="a" id="cpu" />,
      3000,
      4,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.mark).toBeDefined();
    expect(sameMark(a!, b!)).toBe(true);
    // Which is exactly what the consumer-facing predicate needs in order to
    // answer "is this already selected?" — the deselect half of the toggle.
    expect(selectionContains([a!], b!)).toBe(true);
  });

  it('never matches another trace', () => {
    const a = hitOf(
      <LineChart series={line()} column="v" axis="a" id="cpu" />,
      1000,
      2,
    );
    cleanup();
    const b = hitOf(
      <LineChart series={line()} column="v" axis="a" id="mem" />,
      1000,
      2,
    );
    expect(sameMark(a!, b!)).toBe(false);
  });

  it('a span does not swallow a click on the same trace', () => {
    // A series-scoped hit has a NaN key, so it is never "inside" a span — and
    // that is right: "the whole series" and "this range of it" are different
    // selections, and a click must not read as already-covered.
    const t = mount(<LineChart series={line()} column="v" axis="a" id="cpu" />);
    t.sweep(40, 240);
    const span = t.seen[0]!.span!;
    const entry = t.frame().layers.at(-1)!;
    const hit = entry.layer.hitTest!(
      1000,
      2,
      (v: number) => v,
      (v: number) => v,
    );
    expect(selectionContains([span], hit!)).toBe(false);
  });

  it('an area is hit through its fill, a line only near its stroke', () => {
    // The one place the two layers differ, and it follows from what is drawn.
    //
    // This needs PIXEL scales rather than the identity ones above: with y in
    // 1…5 data units, a 6px tolerance swallows the whole plot and a line would
    // look hittable everywhere. So map the data onto a 120px-tall plot, where
    // 6px means what it means on screen.
    const xs = (v: number) => (v / 4000) * 300;
    const ys = (v: number) => 120 - (v / 6) * 120;
    // Deep inside the fill: at x=2000 the trace is at v=3 (py 60), the
    // baseline at v=0 (py 120), so py=110 is inside the fill and 50px from
    // the stroke.
    const at = (node: React.ReactNode) => hitAt(node, 260, 110, xs, ys);
    expect(
      at(<AreaChart series={line()} column="v" axis="a" id="net" />),
    ).not.toBeNull();
    cleanup();
    expect(
      at(<LineChart series={line()} column="v" axis="a" id="cpu" />),
    ).toBeNull();
    cleanup();
    // …and the line IS hit right on its stroke, so the miss above is about
    // distance and not about the layer being inert.
    expect(
      hitAt(
        <LineChart series={line()} column="v" axis="a" id="cpu" />,
        150,
        60,
        xs,
        ys,
      ),
    ).not.toBeNull();
  });
});
