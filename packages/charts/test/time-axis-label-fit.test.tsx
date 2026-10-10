/**
 * The time axis's **measured label fit** — no tick label may overprint its
 * neighbour, and the dates the survivors show must stay correct. Filed from
 * Tidal: its session calendar is derived from the bars, so one stray
 * pre-market bar becomes a one-minute session whose open (`Sep 29`, promoted —
 * it turns the day) lands a pixel left of the real `15:30` open, and the two
 * labels drew on top of each other. The ladder places every session open
 * unconditionally, so pixel collisions are resolved where the pixels and the
 * font are known: the axis.
 *
 * The contract: labels are kept greedily by priority — a period turn, then a
 * session open, then a plain clock tick; between turns or opens the later,
 * between plain ticks the earlier — so within a pass a tick is only dropped by
 * a survivor; blank labels never block. Under
 * `'auto'` the edge ticks of the FULL list anchor inward (fixed per tick, so
 * no drop re-anchors another label). The survivors are re-labelled, so the
 * dates they show stay correct, the fit repeats until nothing collides, and a
 * dropped tick that fits again (a re-label narrowed its neighbour) returns.
 * Four earlier designs failed review: ranking without re-labelling kept stale
 * promotions (a Monday captioned with Sunday's date, a year turn that
 * vanished); always keeping the later tick, and anchoring `'auto'` by drawn
 * position, cascaded (each dropped edge re-anchored the next label into the
 * same collision) and let an edge stub's date outrank the next day's.
 *
 * Runs on the no-canvas estimate path (happy-dom / node), so widths are
 * `length · fontSize · 0.62`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { TimeAxis } from '../src/TimeAxis.js';
import { fitTimeLabels, fitTimeTicks } from '../src/XAxis.js';
import { scaleTradingTime } from '../src/tradingTimeScale.js';
import {
  provider as sessionsProvider,
  type Session,
} from '../src/tradingAxis.fixture.js';

afterEach(cleanup);

const FONT_SIZE = 11;
const FAMILY = 'sans-serif';
const H = 3_600_000;
const M = 60_000;
const est = (s: string) => s.length * FONT_SIZE * 0.62;

type Align = 'auto' | 'center' | 'right';
const ALIGNS: readonly Align[] = ['right', 'center', 'auto'];

type Tick = Parameters<typeof fitTimeLabels>[0][number];

/** The drawn extent of a tick — the render's placement. */
function extent(t: Tick, align: Align): [number, number] {
  const w = est(t.label);
  if (align === 'right') return [t.x + 4, t.x + 4 + w];
  if (align === 'auto' && t.anchor === 'start') return [t.x, t.x + w];
  if (align === 'auto' && t.anchor === 'end') return [t.x - w, t.x];
  return [t.x - w / 2, t.x + w / 2];
}

/** `auto`'s fixed edge anchor for tick `i` of `n`. */
const edgeOf = (i: number, n: number): 'start' | 'end' | undefined =>
  i === 0 ? 'start' : i === n - 1 ? 'end' : undefined;

const kept = (ticks: readonly Tick[], align: Align) =>
  fitTimeLabels(ticks, align, FONT_SIZE, FAMILY).map((i) => ticks[i]!.label);

describe('fitTimeLabels — which ticks keep their labels', () => {
  it('keeps every label that has room', () => {
    const ticks = [
      { x: 0, label: '14:00' },
      { x: 80, label: '15:00' },
      { x: 160, label: 'Sep 29', bold: true },
    ];
    for (const align of ALIGNS) {
      expect(kept(ticks, align)).toEqual(['14:00', '15:00', 'Sep 29']);
    }
  });

  it('a period turn outlasts a clock label, on either side', () => {
    // The Tidal shape — `Sep 29` (a stray bar's open) 4px left of `15:30`.
    const ticks = [
      { x: 360, label: '21:30' },
      { x: 480, label: 'Sep 29', bold: true },
      { x: 484, label: '15:30', seam: true },
      { x: 604, label: '16:00' },
    ];
    for (const align of ALIGNS) {
      expect(kept(ticks, align)).toEqual(['21:30', 'Sep 29', '16:00']);
    }
    // The seam shape — the last clock tick, then the next day's open.
    const seam = [
      { x: 0, label: '18:00' },
      { x: 90, label: '21:00' },
      { x: 105, label: 'Sep 23', bold: true, seam: true },
      { x: 300, label: '12:00' },
    ];
    for (const align of ALIGNS) {
      expect(kept(seam, align)).toEqual(['18:00', 'Sep 23', '12:00']);
    }
  });

  it('between two turns the later wins; between plain ticks the earlier', () => {
    // CME in UTC: the Sunday 23:00 open, then Monday's midnight turn.
    const turns = [
      { x: 0, label: '12:00' },
      { x: 200, label: 'Jan 4', bold: true, seam: true },
      { x: 210, label: 'Jan 5', bold: true },
      { x: 400, label: '06:00' },
    ];
    for (const align of ALIGNS) {
      expect(kept(turns, align)).toEqual(['12:00', 'Jan 5', '06:00']);
    }
    const plain = [
      { x: 0, label: '14:00' },
      { x: 100, label: '15:30' },
      { x: 110, label: '15:45' },
      { x: 300, label: '18:00' },
    ];
    for (const align of ALIGNS) {
      expect(kept(plain, align)).toEqual(['14:00', '15:30', '18:00']);
    }
  });

  it('a session open outranks a plain clock label', () => {
    // Elapsed / undated labels carry no turn: the tick on the seam (the
    // instant really at that pixel) beats the late-session tick before it.
    const elapsed = [
      { x: 0, label: '00:00', seam: true },
      { x: 280, label: '06:00' },
      { x: 300, label: '1d 00:00', seam: true },
      { x: 600, label: '1d 06:00' },
    ];
    for (const align of ALIGNS) {
      expect(kept(elapsed, align)).toEqual(['00:00', '1d 00:00', '1d 06:00']);
    }
  });

  it('between two session opens the later wins', () => {
    // A stray print's open beside the real open, neither a period turn (a
    // custom format, or a zone where the open doesn't turn the day): the real
    // open owns the session that follows.
    const ticks = [
      { x: 0, label: '09:00' },
      { x: 200, label: '10:00', seam: true },
      { x: 204, label: '15:30', seam: true },
      { x: 300, label: '16:00' },
    ];
    for (const align of ALIGNS) {
      expect(kept(ticks, align)).toEqual(['09:00', '15:30', '16:00']);
    }
  });

  it('a blank label never blocks another', () => {
    // A custom format thinning its own labels: '' on two of every three
    // ticks. The visible labels clear one another; the blanks draw nothing.
    const long = 'Mon, 02 Mar 2026 00:00:00 GMT';
    const pitch = est(long) / 2 + 20;
    const ticks = Array.from({ length: 7 }, (_, i) => ({
      x: i * pitch,
      label: i % 3 === 0 ? long : '',
    }));
    for (const align of ['center', 'right'] as const) {
      expect(kept(ticks, align)).toEqual(ticks.map((t) => t.label));
    }
  });

  it("under 'auto' a crowded edge costs one label — no cascade", () => {
    // `auto` anchors the edge labels inward, so the first overlaps its
    // neighbour where a centred label wouldn't. The anchor belongs to the
    // tick, not to its drawn position: once the neighbour is dropped nothing
    // re-anchors, so it settles (anchoring by drawn position made each dropped
    // edge push the next label into the same collision, pass after pass).
    const w = est('14:00:10');
    const d = w * 1.25 + 4; // clears centred, not edge-anchored
    const ticks = Array.from({ length: 8 }, (_, i) => ({
      x: 20 + i * d,
      label: `14:00:${String(10 + i * 5)}`,
      anchor: edgeOf(i, 8),
    }));
    expect(kept(ticks, 'center')).toHaveLength(8);
    // Left edge: the inner neighbour goes (plain ties keep the earlier).
    // Right edge: the edge label itself goes, for the same reason.
    expect(kept(ticks, 'auto')).toEqual([
      '14:00:10',
      '14:00:20',
      '14:00:25',
      '14:00:30',
      '14:00:35',
      '14:00:40',
    ]);
  });

  it("under 'auto' an edge turn does not outrank the later turn beside it", () => {
    // FX in UTC: the Sunday 22:00 open is the left-edge tick, anchored
    // inward onto Monday's midnight turn. Monday owns the ticks that follow.
    const ticks = [
      {
        x: 0,
        label: 'Feb 15',
        bold: true,
        seam: true,
        anchor: 'start' as const,
      },
      { x: 51.9, label: 'Feb 16', bold: true },
      { x: 129.9, label: '03:00' },
      { x: 207.8, label: '06:00', anchor: 'end' as const },
    ];
    expect(kept(ticks, 'auto')).toEqual(['Feb 16', '03:00', '06:00']);
  });

  it('a dropped tick never takes a neighbour down with it', () => {
    // `16` fits beside `Sep 29`; `September` overlaps both and is dropped
    // alone (the shape a ranked greedy once dropped `16` for).
    const ticks = [
      { x: -41, label: 'September', bold: true },
      { x: -40, label: '16' },
      { x: 0, label: 'Sep 29', bold: true },
    ];
    expect(kept(ticks, 'center')).toEqual(['16', 'Sep 29']);
  });

  it('keeps one label when every tick sits on one pixel (pre-layout width)', () => {
    const ticks = [
      { x: 0, label: '14:00' },
      { x: 0, label: '15:00' },
      { x: 0, label: '16:00' },
    ];
    for (const align of ALIGNS) expect(kept(ticks, align)).toEqual(['14:00']);
  });

  it('seeded sweep: kept labels never overlap, and every drop overlaps a kept one', () => {
    const pool = ['15:30', '9', 'Sep 29', 'September', '2026', '1d 06:00'];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 400; run++) {
      const n = 1 + Math.floor(rnd() * 14);
      let x = 0;
      const ticks = Array.from({ length: n }, (_, i) => {
        x += rnd() * 60;
        return {
          x,
          label: pool[Math.floor(rnd() * pool.length)]!,
          bold: rnd() < 0.3,
          seam: rnd() < 0.3,
          anchor: edgeOf(i, n),
        };
      });
      for (const align of ALIGNS) {
        const idx = fitTimeLabels(ticks, align, FONT_SIZE, FAMILY);
        expect(idx.length).toBeGreaterThan(0);
        const ext = ticks.map((t) => extent(t, align));
        for (let k = 1; k < idx.length; k++) {
          expect(ext[idx[k - 1]!]![1] + 4).toBeLessThanOrEqual(
            ext[idx[k]!]![0] + 1e-9,
          );
        }
        const keep = new Set(idx);
        for (let i = 0; i < n; i++) {
          if (keep.has(i)) continue;
          const hit = idx.some(
            (j) => ext[i]![1] + 4 > ext[j]![0] && ext[j]![1] + 4 > ext[i]![0],
          );
          expect(hit).toBe(true);
        }
      }
    }
  });
});

describe('fitTimeTicks — re-labels the survivors until nothing collides', () => {
  it('a survivor inherits the period turn of the tick dropped beside it', () => {
    // A toy flat labeller: the coarsest unit that changed since the previous
    // *drawn* tick (year > day), else the hour; x is a collapsed axis. A
    // stray New Year's open (`Y1`) sits a pixel left of the next real open
    // (`d5`, a day turn after the stray). The later turn wins, and
    // re-labelling makes it the year turn — `Y1` is not lost.
    const DAY = 24 * H;
    const YEAR = 4 * DAY;
    const xs = new Map([
      [3 * DAY + 10 * H, 0],
      [3 * DAY + 20 * H, 100],
      [YEAR + 15 * H, 200], // the stray open
      [YEAR + DAY + 15 * H, 201], // the real open
      [YEAR + DAY + 18 * H, 300],
    ]);
    const place = (vs: readonly number[]) =>
      vs.map((v, i) => {
        const p = vs[i - 1];
        const label =
          p === undefined || Math.floor(p / YEAR) !== Math.floor(v / YEAR)
            ? `Y${Math.floor(v / YEAR)}`
            : Math.floor(p / DAY) !== Math.floor(v / DAY)
              ? `d${Math.floor(v / DAY)}`
              : `${(v % DAY) / H}h`;
        return { x: xs.get(v)!, label, bold: !label.endsWith('h') };
      });
    const values = [...xs.keys()];
    expect(place(values).map((t) => t.label)).toEqual([
      'Y0',
      '20h',
      'Y1',
      'd5',
      '18h',
    ]);
    const out = fitTimeTicks(values, place, 'right', FONT_SIZE, FAMILY);
    expect(out.map((t) => `${t.label}@${t.x}`)).toEqual([
      'Y0@0',
      '20h@100',
      'Y1@201',
      '18h@300',
    ]);
  });

  it('repeats until a pass drops nothing (a re-labelled survivor can widen)', () => {
    // Toy flat labeller (`Year…` / `d…` / hour, against the previous *drawn*
    // tick). Pass 1 drops the stray `Year1` for the later `d5`; re-labelled,
    // `d5` becomes the wider `Year1` and now overlaps `16h` — a third pass
    // settles it. Re-placing once and returning would leave the overlap.
    const DAY = 24 * H;
    const YEAR = 4 * DAY;
    const xs = new Map([
      [3 * DAY + 20 * H, 0],
      [YEAR + 15 * H, 100], // the stray open
      [YEAR + DAY + 15 * H, 101], // the real open
      [YEAR + DAY + 16 * H, 138],
      [YEAR + DAY + 20 * H, 300],
    ]);
    let passes = 0;
    const place = (vs: readonly number[]) => {
      passes += 1;
      return vs.map((v, i) => {
        const p = vs[i - 1];
        const label =
          p === undefined || Math.floor(p / YEAR) !== Math.floor(v / YEAR)
            ? `Year${Math.floor(v / YEAR)}`
            : Math.floor(p / DAY) !== Math.floor(v / DAY)
              ? `d${Math.floor(v / DAY)}`
              : `${(v % DAY) / H}h`;
        return { x: xs.get(v)!, label, bold: !label.endsWith('h') };
      });
    };
    const out = fitTimeTicks([...xs.keys()], place, 'right', FONT_SIZE, FAMILY);
    expect(out.map((t) => `${t.label}@${t.x}`)).toEqual([
      'Year0@0',
      'Year1@101',
      '20h@300',
    ]);
    // Three placing passes, plus a re-admission trial per dropped tick.
    expect(passes).toBeGreaterThanOrEqual(3);
  });

  it('re-admits a dropped tick once a re-label narrows its neighbour', () => {
    // Toy labeller: `Y…` (narrow) when the year changed since the previous
    // drawn tick, `DayLabel…` (wide) when the day did, else the hour. The
    // wide `DayLabel5` crowds out `12h`; once the stray `Y1` beside it is
    // dropped, it re-labels as the narrow `Y1` — and `12h` fits again.
    const DAY = 24 * H;
    const YEAR = 4 * DAY;
    const xs = new Map([
      [3 * DAY + 2 * H, 0],
      [3 * DAY + 12 * H, 60],
      [YEAR + 15 * H, 100], // the stray open
      [YEAR + DAY + 15 * H, 101], // the real open
      [YEAR + DAY + 20 * H, 300],
    ]);
    const place = (vs: readonly number[]) =>
      vs.map((v, i) => {
        const p = vs[i - 1];
        const label =
          p === undefined || Math.floor(p / YEAR) !== Math.floor(v / YEAR)
            ? `Y${Math.floor(v / YEAR)}`
            : Math.floor(p / DAY) !== Math.floor(v / DAY)
              ? `DayLabel${Math.floor(v / DAY)}`
              : `${(v % DAY) / H}h`;
        return { x: xs.get(v)!, label, bold: !label.endsWith('h') };
      });
    expect(place([...xs.keys()]).map((t) => t.label)).toEqual([
      'Y0',
      '12h',
      'Y1',
      'DayLabel5',
      '20h',
    ]);
    const out = fitTimeTicks(
      [...xs.keys()],
      place,
      'center',
      FONT_SIZE,
      FAMILY,
    );
    expect(out.map((t) => `${t.label}@${t.x}`)).toEqual([
      'Y0@0',
      '12h@60',
      'Y1@101',
      '20h@300',
    ]);
  });

  it('places once when nothing collides', () => {
    let calls = 0;
    const place = (vs: readonly number[]) => {
      calls += 1;
      return vs.map((v) => ({ x: v, label: 'ab' }));
    };
    fitTimeTicks([0, 100, 200], place, 'center', FONT_SIZE, FAMILY);
    expect(calls).toBe(1);
  });
});

describe('scaleTradingTime.flatFormat(count, drawn)', () => {
  it('promotes along the drawn ticks only', () => {
    const day = Date.UTC(2026, 8, 28);
    const sessions: Session[] = [
      { date: 'a', open: day + 13.5 * H, close: day + 20 * H },
      {
        date: 'b',
        open: day + 24 * H + 13.5 * H,
        close: day + 24 * H + 20 * H,
      },
    ];
    const s = scaleTradingTime(sessionsProvider(sessions), { timeZone: 'UTC' })
      .domain([day + 18 * H, day + 24 * H + 16 * H])
      .range([0, 600]);
    const all = s.ticks(9);
    const open = day + 24 * H + 13.5 * H;
    expect(all).toContain(open);
    // Everything drawn: the session open is the day turn.
    expect(s.flatFormat(9)(open)).toBe('Sep 29');
    // Drop the open: the next drawn tick carries the turn instead.
    const drawn = all.filter((t) => t !== open);
    const next = drawn.find((t) => t > open)!;
    expect(s.flatFormat(9)(next)).toMatch(/^\d\d:\d\d$/);
    expect(s.flatFormat(9, drawn)(next)).toBe('Sep 29');
  });
});

describe('time axis label fit — rendered', () => {
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
  const session = (
    d: number,
    openH: number,
    closeH: number,
    date = String(d),
  ): Session => ({ date, open: d + openH * H, close: d + closeH * H });

  /** The axis strip's tick-label elements, in order (labels are leaves; the
   *  stacked band row is a container). */
  const labelEls = (dom: HTMLElement) =>
    Array.from(
      dom.querySelectorAll<HTMLElement>('[data-axis="x"] > div'),
    ).filter(
      (el) => (el.textContent ?? '') !== '' && el.childElementCount === 0,
    );

  /** The axis strip's labels in order, with their CSS `left`. */
  const drawn = (dom: HTMLElement) =>
    labelEls(dom).map((el) => ({
      text: el.textContent ?? '',
      left: parseFloat(el.style.left),
    }));

  /** Every drawn label clears the next by the fit's gap — the extents read
   *  back from the DOM (the render's `left` + anchoring transform). */
  const expectNoOverlap = (dom: HTMLElement) => {
    const ext = labelEls(dom).map((el) => {
      const left = parseFloat(el.style.left);
      const w = est(el.textContent ?? '');
      const tf = el.style.transform;
      const start =
        tf === 'translateX(-50%)'
          ? left - w / 2
          : tf === 'translateX(-100%)'
            ? left - w
            : left; // `right` already offsets `left`
      return [start, start + w] as const;
    });
    for (let k = 1; k < ext.length; k++) {
      expect(ext[k - 1]![1] + 4).toBeLessThanOrEqual(ext[k]![0] + 0.5);
    }
  };

  it('Tidal: a stray pre-market bar no longer overprints the open', () => {
    const d29 = day(2026, 9, 29);
    const sessions = [
      session(day(2026, 9, 25), 13.5, 20),
      session(day(2026, 9, 28), 13.5, 20),
      { date: 'stray', open: d29 + 8 * H, close: d29 + 8 * H + M },
      session(d29, 13.5, 20),
    ];
    const { container: dom } = render(
      <ChartContainer
        range={[day(2026, 9, 28) + 18 * H, d29 + 16.5 * H]}
        width={1200}
        timeZone="UTC"
        discontinuities={sessionsProvider(sessions)}
        showAxis={false}
      >
        <TimeAxis align="right" />
      </ChartContainer>,
    );
    const labels = drawn(dom);
    const text = labels.map((l) => l.text);
    expect(text).toContain('Sep 29');
    expect(text).not.toContain('13:30');
    // The day turn keeps its own tick — the stray open, one live minute
    // before the real 13:30 open — and the `13:30` beside it is dropped.
    const at = (t: string) => labels.find((l) => l.text === t)!.left;
    const hour = at('15:00') - at('14:00');
    expect(at('14:00') - at('Sep 29')).toBeCloseTo(hour / 2 + hour / 60, 0);
  });

  it('CME-style: a Sunday-evening open does not caption Monday with Sunday', () => {
    // Weekday sessions 23:00 the evening before → 22:00, shown in UTC: the
    // Sunday 23:00 open (`Jan 4`) lands one live hour before Monday's
    // midnight turn (`Jan 5`).
    const sessions: Session[] = [];
    for (let d = 1; d <= 9; d++) {
      const t = day(2026, 1, d);
      const dow = new Date(t).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      sessions.push(session(t, -1, 22, `j${d}`));
    }
    const { container: dom } = render(
      <ChartContainer
        range={[day(2026, 1, 2) + 12 * H, day(2026, 1, 5) + 20 * H]}
        width={720}
        timeZone="UTC"
        discontinuities={sessionsProvider(sessions)}
      />,
    );
    const text = drawn(dom).map((l) => l.text);
    expect(text).toContain('Jan 5');
    expect(text).not.toContain('Jan 4');
  });

  it('a stray print on New Year’s Day does not take the year turn with it', () => {
    const sessions: Session[] = [
      ...[28, 29, 30, 31].map((d) =>
        session(day(2026, 12, d), 14.5, 21, `d${d}`),
      ),
      {
        date: 'stray',
        open: day(2027, 1, 1) + 15 * H,
        close: day(2027, 1, 1) + 15 * H + M,
      },
      ...[4, 5].map((d) => session(day(2027, 1, d), 14.5, 21, `j${d}`)),
    ];
    const { container: dom } = render(
      <ChartContainer
        range={[day(2026, 12, 30) + 14.5 * H, day(2027, 1, 5) + 21 * H]}
        width={600}
        timeZone="UTC"
        discontinuities={sessionsProvider(sessions)}
        showAxis={false}
      >
        <TimeAxis align="auto" />
      </ChartContainer>,
    );
    // The stray's `2027` lost to the later Jan 4 open, which re-labelled as
    // the year turn — drawn as one (bold), not as a plain label.
    const year = labelEls(dom).find((el) => el.textContent === '2027');
    expect(year).toBeDefined();
    expect(year!.style.fontWeight).toBe('700');
  });

  it("FX in UTC under 'auto': the Sunday-evening stub does not erase Monday's date", () => {
    // 24x5 FX: one live span per week, Sunday 22:00 → Friday 22:00 UTC. The
    // window opens in the weekend gap, so the left-edge tick is the Sunday
    // open (`Feb 15`, anchored inward onto Monday's midnight `Feb 16`).
    const week = (sun: number): Session => ({
      date: `w${sun}`,
      open: day(2026, 2, sun) + 22 * H,
      close: day(2026, 2, sun + 5) + 22 * H,
    });
    const { container: dom } = render(
      <ChartContainer
        range={[day(2026, 2, 14) + 12 * H, day(2026, 2, 16) + 21.6 * H]}
        width={613}
        timeZone="UTC"
        discontinuities={sessionsProvider([week(8), week(15)])}
        showAxis={false}
      >
        <TimeAxis align="auto" />
      </ChartContainer>,
    );
    const text = drawn(dom).map((l) => l.text);
    // Monday's date sits on Monday's midnight, ahead of its 03:00 tick —
    // not carried onto 03:00 (which then vanished) by an edge stub.
    const i = text.indexOf('Feb 16');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(text[i + 1]).toBe('03:00');
    expectNoOverlap(dom);
  });

  it('no two drawn labels overlap, across widths and aligns', () => {
    const d29 = day(2026, 9, 29);
    const sessions = [
      session(day(2026, 9, 25), 13.5, 20),
      session(day(2026, 9, 28), 13.5, 20),
      { date: 'stray', open: d29 + 8 * H, close: d29 + 8 * H + M },
      session(d29, 13.5, 20),
      session(day(2026, 9, 30), 13.5, 20),
    ];
    for (const width of [300, 480, 720, 1100]) {
      for (const align of ALIGNS) {
        for (const dateStyle of ['flat', 'stacked'] as const) {
          const { container: dom, unmount } = render(
            <ChartContainer
              range={[day(2026, 9, 25) + 15 * H, day(2026, 9, 30) + 18 * H]}
              width={width}
              timeZone="UTC"
              discontinuities={sessionsProvider(sessions)}
              showAxis={false}
            >
              <TimeAxis align={align} dateStyle={dateStyle} />
            </ChartContainer>,
          );
          expectNoOverlap(dom);
          unmount();
        }
      }
    }
  });

  it("a continuous axis: no overlap in any align, and 'auto' loses at most one label per edge", () => {
    // A one-minute continuous axis whose `HH:MM:SS` labels clear one another
    // centred but not when edge-anchored. Always keeping the later tick once
    // stripped this axis down to two labels, one per pass.
    const count = (align: Align) => {
      const { container: dom, unmount } = render(
        <ChartContainer
          range={[
            Date.UTC(2026, 0, 5, 14, 0, 7),
            Date.UTC(2026, 0, 5, 14, 1, 7),
          ]}
          width={1000}
          timeZone="UTC"
          showAxis={false}
        >
          <TimeAxis align={align} />
        </ChartContainer>,
      );
      expectNoOverlap(dom);
      const n = drawn(dom).length;
      unmount();
      return n;
    };
    const center = count('center');
    expect(center).toBeGreaterThanOrEqual(10);
    expect(count('right')).toBeGreaterThanOrEqual(center - 2);
    expect(count('auto')).toBeGreaterThanOrEqual(center - 2);
  });
  it('a custom format that blanks ticks keeps every visible label', () => {
    // The usual thinning idiom: '' on two of every three 6h ticks. The
    // visible labels clear one another centred, so every one draws.
    const t0 = Date.UTC(2026, 2, 2);
    const format = (v: number) =>
      Math.round((v - t0) / (6 * H)) % 3 === 0 ? new Date(v).toUTCString() : '';
    for (const align of ALIGNS) {
      const { container: dom, unmount } = render(
        <ChartContainer
          range={[t0, t0 + 3 * 24 * H]}
          width={1040}
          timeZone="UTC"
          showAxis={false}
        >
          <TimeAxis align={align} format={format} />
        </ChartContainer>,
      );
      // `auto`'s left-anchored first label genuinely reaches the next visible
      // one (the documented edge cost); the blanks never cost a label.
      expect(drawn(dom)).toHaveLength(align === 'auto' ? 3 : 4);
      expectNoOverlap(dom);
      unmount();
    }
  });

  it("'auto' anchors the edges of the full tick list inward", () => {
    // No collisions: the first label left-aligns at its tick, the last
    // right-aligns, the rest centre — exactly as before the fit existed.
    const { container: dom } = render(
      <ChartContainer
        range={[Date.UTC(2026, 0, 5, 14, 2), Date.UTC(2026, 0, 5, 14, 58)]}
        width={1000}
        timeZone="UTC"
        showAxis={false}
      >
        <TimeAxis align="auto" />
      </ChartContainer>,
    );
    const tf = labelEls(dom).map((el) => el.style.transform);
    expect(tf.length).toBeGreaterThanOrEqual(5);
    expect(tf[0]).toBe('none');
    expect(tf[tf.length - 1]).toBe('translateX(-100%)');
    expect(tf.slice(1, -1).every((t) => t === 'translateX(-50%)')).toBe(true);
  });

  it('Tidal under an explicit format: the stray open yields to the real open', () => {
    // `format` opts out of the ladder's flat labels, so neither open is a
    // period turn — both are session opens, and the later (real) one wins.
    const d29 = day(2026, 9, 29);
    const sessions = [
      session(day(2026, 9, 25), 13.5, 20),
      session(day(2026, 9, 28), 13.5, 20),
      { date: 'stray', open: d29 + 8 * H, close: d29 + 8 * H + M },
      session(d29, 13.5, 20),
    ];
    const { container: dom } = render(
      <ChartContainer
        range={[day(2026, 9, 28) + 18 * H, d29 + 16.5 * H]}
        width={1200}
        timeZone="UTC"
        discontinuities={sessionsProvider(sessions)}
        showAxis={false}
      >
        <TimeAxis align="right" format="%H:%M" />
      </ChartContainer>,
    );
    const text = drawn(dom).map((l) => l.text);
    expect(text).toContain('13:30');
    expect(text).not.toContain('08:00');
    expectNoOverlap(dom);
  });
});
