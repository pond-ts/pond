/**
 * The time axis's **measured label fit** — no tick label may overprint its
 * neighbour, and dropping one may never cost the reader a date. Filed from
 * Tidal: its session calendar is derived from the bars, so one stray
 * pre-market bar becomes a one-minute session whose open (`Sep 29`, promoted —
 * it turns the day) lands a pixel left of the real `15:30` open, and the two
 * labels drew on top of each other. The ladder places every session open
 * unconditionally, so pixel collisions are resolved where the pixels and the
 * font are known: the axis.
 *
 * The contract: of two colliding ticks the **later** is drawn, the survivors
 * are re-labelled so a period turn the dropped tick carried moves onto the
 * next drawn one, and a dropped tick only ever drops itself. Two earlier
 * designs (rank by bold / seam, then later-wins only on ties) each kept a
 * stale promotion somewhere — a Monday captioned with Sunday's date, a year
 * turn that vanished — which is why the survivors are re-labelled rather than
 * ranked.
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

/** The drawn extent of tick `i` of `n` — the render's placement. */
function extent(
  t: { x: number; label: string },
  i: number,
  n: number,
  align: Align,
): [number, number] {
  const w = est(t.label);
  if (align === 'right') return [t.x + 4, t.x + 4 + w];
  if (align === 'auto' && i === 0) return [t.x, t.x + w];
  if (align === 'auto' && i === n - 1) return [t.x - w, t.x];
  return [t.x - w / 2, t.x + w / 2];
}

const kept = (
  ticks: { x: number; label: string; bold?: boolean }[],
  align: Align,
) => fitTimeLabels(ticks, align, FONT_SIZE, FAMILY).map((i) => ticks[i]!.label);

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

  it('of two colliding ticks the later is drawn — whatever either carries', () => {
    // A promoted, bold earlier tick does not outrank a plain later one: the
    // caller re-labels the survivor, so its period turn is not lost.
    const ticks = [
      { x: 360, label: '21:30' },
      { x: 480, label: 'Sep 29', bold: true },
      { x: 484, label: '15:30' },
      { x: 604, label: '16:00' },
    ];
    for (const align of ALIGNS) {
      expect(kept(ticks, align)).toEqual(['21:30', '15:30', '16:00']);
    }
  });

  it('a dropped tick never takes a neighbour down with it', () => {
    // `16` fits beside `Sep 29`; `September` overlaps both and is dropped
    // alone (the shape a ranked greedy once dropped `16` for).
    const right = [
      { x: -41, label: 'September', bold: true },
      { x: -40, label: '16' },
      { x: 0, label: 'Sep 29', bold: true },
    ];
    expect(kept(right, 'center')).toEqual(['16', 'Sep 29']);
  });

  it('keeps one label when every tick sits on one pixel (pre-layout width)', () => {
    const ticks = [
      { x: 0, label: '14:00' },
      { x: 0, label: '15:00' },
      { x: 0, label: '16:00' },
    ];
    for (const align of ALIGNS) expect(kept(ticks, align)).toEqual(['16:00']);
  });

  it('seeded sweep: kept labels never overlap, and every drop overlaps a kept label', () => {
    const pool = ['15:30', '9', 'Sep 29', 'September', '2026', '1d 06:00'];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 400; run++) {
      const n = 1 + Math.floor(rnd() * 14);
      let x = 0;
      const ticks = Array.from({ length: n }, () => {
        x += rnd() * 60;
        return {
          x,
          label: pool[Math.floor(rnd() * pool.length)]!,
          bold: rnd() < 0.3,
        };
      });
      for (const align of ALIGNS) {
        const idx = fitTimeLabels(ticks, align, FONT_SIZE, FAMILY);
        expect(idx.length).toBeGreaterThan(0);
        // The rightmost tick always survives (later wins).
        expect(idx[idx.length - 1]).toBe(n - 1);
        // Extents as the fit saw them: indexed in the input it was given.
        const ext = ticks.map((t, i) => extent(t, i, n, align));
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
    // A toy flat labeller: a tick reads its day when the previous *drawn*
    // tick was on another day, its clock time otherwise.
    const DAY = 24 * H;
    const place = (vs: readonly number[]) =>
      vs.map((v, i) => {
        const turn =
          i === 0 || Math.floor(vs[i - 1]! / DAY) !== Math.floor(v / DAY);
        return {
          x: v / M, // 1 px per minute
          label: turn ? `day${Math.floor(v / DAY)}` : `${(v % DAY) / H}h`,
          bold: turn,
        };
      });
    // day0 21h, then a stray day1 open at 15h29, the real open 15h30, 17h.
    const values = [
      21 * H,
      DAY + 15 * H + 29 * M,
      DAY + 15.5 * H,
      DAY + 17 * H,
    ];
    const out = fitTimeTicks(values, place, 'right', FONT_SIZE, FAMILY);
    expect(out.map((t) => t.label)).toEqual(['day0', 'day1', '17h']);
    // `day1` now sits on the real open, not the stray one.
    expect(out[1]!.x).toBe((DAY + 15.5 * H) / M);
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

  /** The axis strip's labels in order, with their CSS `left`. */
  const drawn = (dom: HTMLElement) =>
    Array.from(dom.querySelectorAll('[data-axis="x"] > div'))
      .filter((el) => (el.textContent ?? '') !== '')
      .map((el) => ({
        text: el.textContent ?? '',
        left: parseFloat((el as HTMLElement).style.left),
      }));

  it('Tidal: a stray pre-market bar no longer overprints the open — the open carries the date', () => {
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
    // `Sep 29` sits on the real 13:30 open (half a 30-minute step left of
    // `14:00`), not on the stray 08:00 open one live minute earlier.
    const at = (t: string) => labels.find((l) => l.text === t)!.left;
    const step = at('15:00') - at('14:00'); // two 30-minute steps
    expect(at('14:00') - at('Sep 29')).toBeCloseTo(step / 2, 0);
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
    expect(drawn(dom).map((l) => l.text)).toContain('2027');
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
        const { container: dom, unmount } = render(
          <ChartContainer
            range={[day(2026, 9, 25) + 15 * H, day(2026, 9, 30) + 18 * H]}
            width={width}
            timeZone="UTC"
            discontinuities={sessionsProvider(sessions)}
            showAxis={false}
          >
            <TimeAxis align={align} />
          </ChartContainer>,
        );
        const els = Array.from(
          dom.querySelectorAll<HTMLElement>('[data-axis="x"] > div'),
        ).filter((el) => (el.textContent ?? '') !== '');
        const ext = els.map((el, i) => {
          const left = parseFloat(el.style.left);
          const w = est(el.textContent ?? '');
          const tf = el.style.transform;
          // Undo the render's anchoring: `right` already offsets `left`.
          const start =
            tf === 'translateX(-50%)'
              ? left - w / 2
              : tf === 'translateX(-100%)'
                ? left - w
                : left;
          void i;
          return [start, start + w] as const;
        });
        for (let k = 1; k < ext.length; k++) {
          expect(ext[k - 1]![1] + 4).toBeLessThanOrEqual(ext[k]![0] + 0.5);
        }
        unmount();
      }
    }
  });
});
