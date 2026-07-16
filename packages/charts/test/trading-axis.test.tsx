import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { TimeAxis } from '../src/TimeAxis.js';
import { YAxis } from '../src/YAxis.js';
import { defaultTheme } from '../src/theme.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';
import {
  type DiscontinuityProvider,
  type TradingCalendarLike,
} from '../src/tradingTimeScale.js';
import { provider as sessionsProvider } from '../src/tradingAxis.fixture.js';
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

  it('derives the provider from the calendar sugar prop', () => {
    const calls: Array<{ spacing?: string } | undefined> = [];
    const calendar: TradingCalendarLike = {
      discontinuities: (options) => {
        calls.push(options);
        return provider;
      },
    };
    const f = frameOf({ calendar });
    // The container called calendar.discontinuities() once and used its result.
    expect(calls).toEqual([undefined]);
    expect(f.discontinuities).toBe(provider);
    expect(f.xKind).toBe('time');
    // Same trading-time behavior as the low-level prop — the gap collapses.
    expect(Math.abs(f.xScale(100) - f.xScale(200))).toBeLessThan(1);
  });

  it('passes spacing through the calendar sugar', () => {
    const calls: Array<{ spacing?: string } | undefined> = [];
    const calendar: TradingCalendarLike = {
      discontinuities: (options) => {
        calls.push(options);
        return provider;
      },
    };
    frameOf({ calendar, spacing: 'uniform' });
    expect(calls).toEqual([{ spacing: 'uniform' }]);
  });

  it('the low-level discontinuities prop wins over calendar', () => {
    let called = false;
    const calendar: TradingCalendarLike = {
      discontinuities: () => {
        called = true;
        return provider;
      },
    };
    const other = { ...provider }; // a distinct provider identity
    const f = frameOf({ discontinuities: other, calendar });
    expect(f.discontinuities).toBe(other); // low-level wins
    expect(called).toBe(false); // calendar sugar not consulted
  });

  it('drops the calendar-derived provider on a value axis', () => {
    // Same gate as the low-level prop, on the merged provider — a value-keyed
    // row must not become a trading-time axis via the calendar sugar either.
    const calendar: TradingCalendarLike = {
      discontinuities: () => provider,
    };
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
      ],
    }).byValue('cumDist');

    let frame: ContainerFrame | null = null;
    render(
      <ChartContainer calendar={calendar} width={320}>
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
    expect(f.discontinuities).toBeUndefined(); // gated off
  });

  it('grid / sessionDividers props: grid gate, and labeled vs all vs none', () => {
    const H = 3_600_000;
    const DAY = 24 * H;
    // ~40 weekday sessions from Mon 2026-01-05 → many session boundaries, only
    // a handful of which are labelled ticks.
    const sessions: Array<{ date: string; open: number; close: number }> = [];
    for (let d = 0; sessions.length < 40; d++) {
      const day = Date.UTC(2026, 0, 5) + d * DAY;
      const dow = new Date(day).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      sessions.push({ date: '', open: day + 9.5 * H, close: day + 16 * H });
    }
    const prov = sessionsProvider(sessions);
    const px = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: sessions.map((s) => [s.open, 1]) as [number, number][],
    });
    const dividerColor = defaultTheme.axis.sessionDivider!;
    const gridDash = defaultTheme.axis.gridDash as number[];
    const tree = (props: Record<string, unknown>) => (
      <ChartContainer
        range={[sessions[0]!.open, sessions[39]!.close]}
        width={900}
        discontinuities={prov}
        showAxis={false}
        {...props}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={2} />
          <Layers>
            <LineChart series={px} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
    // Dividers draw as one path: `moveTo` per line between the divider-colour
    // `strokeStyle` set and the following `stroke()`. Count them.
    const dividerCount = (
      calls: ReturnType<typeof stubCanvasContext>['calls'],
    ) => {
      const i = calls.findIndex(
        (c) =>
          c.type === 'set' &&
          c.name === 'strokeStyle' &&
          c.args[0] === dividerColor,
      );
      if (i < 0) return 0;
      // Count divider lines from the divider-colour set until drawDividers'
      // `restore` — one `moveTo` per line. ('labeled' draws one path; 'all'
      // draws a path per line for per-line fade — both counted the same way.)
      let n = 0;
      for (let j = i + 1; j < calls.length; j++) {
        if (calls[j]!.name === 'restore') break;
        if (calls[j]!.name === 'moveTo') n++;
      }
      return n;
    };
    const gridDashed = (calls: ReturnType<typeof stubCanvasContext>['calls']) =>
      calls.some(
        (c) =>
          c.type === 'call' &&
          c.name === 'setLineDash' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as number[]).join() === gridDash.join(),
      );
    // Render each mode under a fresh stub; read the counts before restoring.
    let byDefault = 0;
    let labeled = 0;
    let all = 0;
    let gridDashedWithGrid = false;
    let gridDashedNoGrid = false;
    let dividersNoGrid = 0;
    {
      const stub = stubCanvasContext();
      render(tree({})); // default: sessionDividers 'none', grid on
      byDefault = dividerCount(stub.calls);
      gridDashedWithGrid = gridDashed(stub.calls);
      stub.restore();
      cleanup();
    }
    {
      const stub = stubCanvasContext();
      render(tree({ sessionDividers: 'labeled' }));
      labeled = dividerCount(stub.calls);
      stub.restore();
      cleanup();
    }
    {
      const stub = stubCanvasContext();
      render(tree({ sessionDividers: 'all' }));
      all = dividerCount(stub.calls);
      stub.restore();
      cleanup();
    }
    {
      const stub = stubCanvasContext();
      render(tree({ grid: false, sessionDividers: 'labeled' }));
      dividersNoGrid = dividerCount(stub.calls);
      gridDashedNoGrid = gridDashed(stub.calls);
      stub.restore();
      cleanup();
    }

    // Default is 'none': the hierarchical grid marks the calendar structure;
    // dividers are opt-in emphasis (the owner's grid-off-but-lines-remain
    // confusion, 2026-07-16).
    expect(byDefault).toBe(0);
    expect(labeled).toBeGreaterThan(0); // 'labeled' draws some (at labels)
    expect(all).toBeGreaterThan(labeled); // 'all' draws every boundary — denser
    // Grid gate is independent of dividers: `grid={false}` drops the dashed
    // gridlines but explicitly-enabled dividers still draw.
    expect(gridDashedWithGrid).toBe(true);
    expect(gridDashedNoGrid).toBe(false);
    expect(dividersNoGrid).toBeGreaterThan(0);
  });

  it("dividers mark collapse SEAMS, not every roster boundary — contiguous sessions don't seam", () => {
    const H = 3_600_000;
    const DAY = 24 * H;
    // A weekendSkip-style demo calendar: contiguous full-day Mon–Fri
    // sessions (nothing removed overnight), Sat+Sun excised. Its `boundaries`
    // is the session ROSTER — every weekday midnight — which the ticks and
    // grid need; but only the Monday opens follow removed time.
    const t0 = Date.UTC(2026, 0, 5); // a Monday, UTC math throughout
    const days = 14;
    const isWeekday = (t: number) => {
      const dow = new Date(t).getUTCDay();
      return dow !== 0 && dow !== 6;
    };
    const weekdaysBefore = (di: number) => {
      const w = Math.floor(di / 7);
      return w * 5 + Math.min(di - w * 7, 5);
    };
    const liveMs = (t: number) => {
      const di = Math.floor((t - t0) / DAY);
      const rem = t - t0 - di * DAY;
      return weekdaysBefore(di) * DAY + (isWeekday(t0 + di * DAY) ? rem : 0);
    };
    const demo: DiscontinuityProvider = {
      distance: (a, b) => liveMs(b) - liveMs(a),
      offset: (v, amt) => {
        const live = liveMs(v) + amt;
        const ld = Math.floor(live / DAY);
        const weeks = Math.floor(ld / 5);
        return t0 + (weeks * 7 + (ld - weeks * 5)) * DAY + (live - ld * DAY);
      },
      clampUp: (t) => t,
      clampDown: (t) => t,
      copy: () => demo,
      boundaries: (from, to) => {
        const out: number[] = [];
        for (let d = 1; d < days; d++) {
          const t = t0 + d * DAY;
          if (isWeekday(t) && t > from && t < to) out.push(t);
        }
        return out;
      },
    };
    const px = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [t0, 1],
        [t0 + (days - 1) * DAY, 2],
      ] as [number, number][],
    });
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer
          range={[t0, t0 + days * DAY]}
          width={900}
          discontinuities={demo}
          sessionDividers="all"
          showAxis={false}
        >
          <ChartRow height={120}>
            <YAxis id="a" min={0} max={3} />
            <Layers>
              <LineChart series={px} column="v" axis="a" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      const dividerColor = defaultTheme.axis.sessionDivider!;
      const i = stub.calls.findIndex(
        (c) =>
          c.type === 'set' &&
          c.name === 'strokeStyle' &&
          c.args[0] === dividerColor,
      );
      let n = 0;
      for (let j = i + 1; i >= 0 && j < stub.calls.length; j++) {
        if (stub.calls[j]!.name === 'restore') break;
        if (stub.calls[j]!.name === 'moveTo') n++;
      }
      // 14 days from a Monday: 9 interior weekday midnights in the roster,
      // but only ONE follows removed time — the second Monday (after the
      // excised first weekend). That is the only divider.
      expect(n).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it('seam test is exact (<= 0), not a positive tolerance — a uniform provider does not false-seam a contiguous roster boundary', () => {
    // Codex review (#479): the seam filter must test `distance(b-1,b) <= 0`,
    // not `< 0.5`. Under uniform spacing, distance is session-units, so a
    // *contiguous* roster boundary reads a tiny fraction (1/sessionMs) — a
    // `< 0.5` test would misread it as a removed-time seam and draw a false
    // divider. This provider reports BOTH a contiguous open (D, no gap before)
    // and a true seam (3D, gap [2D,3D) removed); only the seam may divide.
    const D = 24 * 3_600_000;
    const uniform: DiscontinuityProvider = (() => {
      // Session-unit live space: S0 [0,D), S1 [D,2D) contiguous, S2 [3D,4D)
      // after a removed gap. Each session is one unit wide.
      const liveMs = (t: number): number => {
        if (t <= 0) return 0;
        if (t < D) return t / D;
        if (t < 2 * D) return 1 + (t - D) / D;
        if (t < 3 * D) return 2; // in the removed gap → clamps to S1 end
        if (t < 4 * D) return 2 + (t - 3 * D) / D;
        return 3;
      };
      const instantFor = (L: number): number => {
        if (L <= 0) return 0;
        if (L < 1) return L * D;
        if (L < 2) return D + (L - 1) * D;
        if (L < 3) return 3 * D + (L - 2) * D;
        return 4 * D;
      };
      const self: DiscontinuityProvider = {
        distance: (a, b) => liveMs(b) - liveMs(a),
        offset: (v, amt) => instantFor(liveMs(v) + amt),
        clampUp: (t) => t,
        clampDown: (t) => t,
        copy: () => self,
        boundaries: () => [D, 3 * D], // the full roster: contiguous open + seam
      };
      return self;
    })();
    const px = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [D / 2, 1],
        [1.5 * D, 2],
        [3.5 * D, 1],
      ] as [number, number][],
    });
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer
          range={[0, 4 * D]}
          width={600}
          discontinuities={uniform}
          sessionDividers="all"
          showAxis={false}
        >
          <ChartRow height={120}>
            <YAxis id="a" min={0} max={3} />
            <Layers>
              <LineChart series={px} column="v" axis="a" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      const dividerColor = defaultTheme.axis.sessionDivider!;
      const i = stub.calls.findIndex(
        (c) =>
          c.type === 'set' &&
          c.name === 'strokeStyle' &&
          c.args[0] === dividerColor,
      );
      let n = 0;
      for (let j = i + 1; i >= 0 && j < stub.calls.length; j++) {
        if (stub.calls[j]!.name === 'restore') break;
        if (stub.calls[j]!.name === 'moveTo') n++;
      }
      // Only 3D (the true seam) divides; the contiguous D boundary does not.
      // With the old `< 0.5` tolerance this was 2.
      expect(n).toBe(1);
    } finally {
      stub.restore();
    }
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
      render(tree({ discontinuities: provider, sessionDividers: 'labeled' }));
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

    // Control: no provider → no divider color stroked (even asked for).
    const noStub = stubCanvasContext();
    try {
      render(tree({ sessionDividers: 'labeled' }));
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

describe('trading-axis tick density derives from plot width', () => {
  const H = 3_600_000;
  const DAY = 24 * H;

  /** `n` weekday sessions (09:30–16:00 UTC) from Mon 2025-06-23 — mid-year
   *  anchored, as a "1Y back from today" trading view is. At the old fixed
   *  count of 5 this span rendered 5 quarterly ticks at best and 2 year-grain
   *  ticks once it stretched past ~5 quarters (the 0.44 Tidal report). */
  function yearSessions(n = 260) {
    const mon = Date.UTC(2025, 5, 23);
    const out: Array<{ date: string; open: number; close: number }> = [];
    for (let d = 0; out.length < n; d++) {
      const day = mon + d * DAY;
      const dow = new Date(day).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      out.push({ date: '', open: day + 9.5 * H, close: day + 16 * H });
    }
    return out;
  }

  function tradingFrame(width: number, n?: number): ContainerFrame {
    const sessions = yearSessions(n);
    let frame: ContainerFrame | null = null;
    render(
      <ChartContainer
        range={[sessions[0]!.open, sessions[sessions.length - 1]!.close]}
        width={width}
        discontinuities={sessionsProvider(sessions)}
        showAxis={false}
      >
        <Capture sink={(f) => (frame = f)} />
      </ChartContainer>,
    );
    return frame!;
  }

  const tickList = (f: ContainerFrame): number[] =>
    (f.xScale.ticks(f.xTickCount) as ReadonlyArray<number | Date>).map(
      (d) => +d,
    );

  it('a ~900px year-long daily view ticks ~monthly (the 0.44 report showed 2)', () => {
    const f = tradingFrame(900);
    const ticks = tickList(f);
    expect(ticks.length).toBeGreaterThanOrEqual(10); // month grain, not year
    expect(ticks.length).toBeLessThanOrEqual(f.xTickCount);
    // …and the shared formatter labels those ticks as bare months (`%b`) on
    // the same grain — the year lives on the boundary (second) row.
    expect(f.formatTime(ticks[1]!)).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it('a narrower view of the same data coarsens the grain (fewer ticks)', () => {
    const wide = tradingFrame(900);
    const narrow = tradingFrame(420);
    expect(narrow.xTickCount).toBeLessThan(wide.xTickCount);
    expect(tickList(narrow).length).toBeLessThan(tickList(wide).length);
    expect(tickList(narrow).length).toBeLessThanOrEqual(narrow.xTickCount);
  });

  it('a continuous time axis derives its count from width too (shared ladder)', () => {
    // No provider → the identity-provider trading scale; a plain time axis
    // runs the same logical ladder, so its cap is width-derived as well.
    const f = frameOf({});
    expect(f.xTickCount).toBe(Math.max(2, Math.floor(f.plotWidth / 65)));
  });

  it('the auto-rendered (flat default) axis shows month labels with the year turn inline', () => {
    const sessions = yearSessions();
    const { container: dom } = render(
      <ChartContainer
        range={[sessions[0]!.open, sessions[sessions.length - 1]!.close]}
        width={900}
        discontinuities={sessionsProvider(sessions)}
      />,
    );
    // One label div per tick, text like "Jul" (`%b` month-grain anchors).
    const labels = Array.from(dom.querySelectorAll('div')).filter((el) =>
      /^[A-Z][a-z]{2}$/.test(el.textContent ?? ''),
    );
    expect(labels.length).toBeGreaterThanOrEqual(10);
    // Flat: no second (boundary) row and no pinned context — the year turn is
    // promoted *inline* onto the January tick instead.
    expect(dom.querySelectorAll('[data-boundary-label]')).toHaveLength(0);
    expect(dom.querySelector('[data-boundary-context]')).toBeNull();
    const years = Array.from(dom.querySelectorAll('div'))
      .map((el) => el.textContent ?? '')
      .filter((t) => /^\d{4}$/.test(t));
    // Only the year *turn* shows (2026); the domain-start year 2025 has no
    // pinned label in flat mode.
    expect(years).toEqual(['2026']);
  });

  it('dateStyle="stacked" restores the two-row boundary + pinned context', () => {
    const sessions = yearSessions();
    const { container: dom } = render(
      <ChartContainer
        range={[sessions[0]!.open, sessions[sessions.length - 1]!.close]}
        width={900}
        discontinuities={sessionsProvider(sessions)}
        showAxis={false}
      >
        <TimeAxis dateStyle="stacked" />
      </ChartContainer>,
    );
    // The boundary (second) row carries the year: the domain start's year
    // pinned at the left edge (context), plus the crossing tick where the year
    // turns — never on every tick.
    const boundaries = Array.from(
      dom.querySelectorAll('[data-boundary-label]'),
    ).map((el) => el.textContent);
    expect(boundaries.sort()).toEqual(['2025', '2026']);
    const context = dom.querySelector('[data-boundary-context]') as HTMLElement;
    expect(context.textContent).toBe('2025');
    expect(parseFloat(context.style.left)).toBeLessThanOrEqual(0);
  });

  it('a container-level timeFormat suppresses the boundary row', () => {
    // An explicit format owns the whole label — the ladder must not add a
    // second line under it (same opt-out as an <XAxis format> override).
    const sessions = yearSessions();
    const { container: dom } = render(
      <ChartContainer
        range={[sessions[0]!.open, sessions[sessions.length - 1]!.close]}
        width={900}
        discontinuities={sessionsProvider(sessions)}
        timeFormat="%Y-%m-%d"
      />,
    );
    expect(dom.querySelectorAll('[data-boundary-label]')).toHaveLength(0);
  });

  it('formatTime labels year-grain ticks with the year — count shared with ticks', () => {
    // ~2 years of dailies at a narrow width → year grain. Before the count was
    // shared, ticks coarsened at 5 (year grain) while formatTime anchored at
    // the scale's internal default (10 → quarter grain), so a year-grain tick
    // read as a date ("Jun 22") instead of "%Y" — the labels in the report.
    const f = tradingFrame(220, 520);
    const labels = tickList(f).map((t) => f.formatTime(t));
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels.every((l) => /^\d{4}$/.test(l))).toBe(true);
  });
});
