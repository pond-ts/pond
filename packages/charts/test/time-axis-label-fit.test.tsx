/**
 * The time axis's **measured label fit** — no tick label may overprint its
 * neighbour. Filed from Tidal: its session calendar is derived from the bars,
 * so one stray pre-market bar becomes a one-minute session whose open (`Sep
 * 29`, promoted — it turns the day) lands a pixel left of the real `15:30`
 * open, and the two labels drew on top of each other. The ladder pushes every
 * session open unconditionally, so pixel collisions have to be resolved where
 * the pixels and the font are known: the axis.
 *
 * Runs on the no-canvas estimate path (happy-dom), so widths are
 * `length · fontSize · 0.62` — the contract under test is the priority rule and
 * that the drawn extents never overlap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { fitTimeLabels } from '../src/XAxis.js';
import { provider as sessionsProvider } from '../src/tradingAxis.fixture.js';

afterEach(cleanup);

const FONT_SIZE = 11;
const FAMILY = 'sans-serif';

const labels = (ts: readonly { label: string }[]) => ts.map((t) => t.label);

describe('fitTimeLabels', () => {
  it('keeps every label that has room', () => {
    const ticks = [
      { x: 0, label: '14:00' },
      { x: 80, label: '15:00' },
      { x: 160, label: 'Sep 29', bold: true },
    ];
    expect(labels(fitTimeLabels(ticks, 'right', FONT_SIZE, FAMILY))).toEqual([
      '14:00',
      '15:00',
      'Sep 29',
    ]);
  });

  it('a micro-session open beside the real open: the date turn wins', () => {
    // The Tidal shape — `Sep 29` (the stray bar's open) 4px left of `15:30`.
    const ticks = [
      { x: 360, label: '21:30' },
      { x: 480, label: 'Sep 29', bold: true },
      { x: 484, label: '15:30' },
      { x: 604, label: '16:00' },
    ];
    for (const align of ['right', 'center', 'auto'] as const) {
      expect(labels(fitTimeLabels(ticks, align, FONT_SIZE, FAMILY))).toEqual([
        '21:30',
        'Sep 29',
        '16:00',
      ]);
    }
  });

  it('a later period turn displaces an earlier plain label (seam crowding)', () => {
    // The last clock tick before a collapsed seam, then the next day's open.
    const ticks = [
      { x: 0, label: '18:00' },
      { x: 90, label: '21:00' },
      { x: 105, label: 'Sep 23', bold: true },
    ];
    expect(labels(fitTimeLabels(ticks, 'right', FONT_SIZE, FAMILY))).toEqual([
      '18:00',
      'Sep 23',
    ]);
  });

  it('a session open outranks a plain clock label, but not a period turn', () => {
    // Elapsed / undated labels carry no `bold`: the tick on the seam (the
    // instant really at that pixel) beats the late-session tick before it.
    const elapsed = [
      { x: 0, label: '00:00', seam: true },
      { x: 280, label: '06:00' },
      { x: 300, label: '1d 00:00', seam: true },
    ];
    expect(labels(fitTimeLabels(elapsed, 'center', FONT_SIZE, FAMILY))).toEqual(
      ['00:00', '1d 00:00'],
    );
    // A micro-session's open is a seam too — the date turn still wins.
    const stray = [
      { x: 480, label: 'Sep 29', bold: true, seam: true },
      { x: 484, label: '15:30', seam: true },
    ];
    expect(labels(fitTimeLabels(stray, 'right', FONT_SIZE, FAMILY))).toEqual([
      'Sep 29',
    ]);
  });

  it('between equals the earlier label keeps its place', () => {
    const plain = [
      { x: 0, label: '15:30' },
      { x: 10, label: '15:45' },
    ];
    expect(labels(fitTimeLabels(plain, 'right', FONT_SIZE, FAMILY))).toEqual([
      '15:30',
    ]);
    const turns = [
      { x: 0, label: 'Sep 28', bold: true },
      { x: 10, label: 'Sep 29', bold: true },
    ];
    expect(labels(fitTimeLabels(turns, 'right', FONT_SIZE, FAMILY))).toEqual([
      'Sep 28',
    ]);
  });

  it("'auto' re-fits once a dropped edge label hands the edge anchor on", () => {
    // `auto` left-anchors the first label. When the plain first label loses to
    // the bold second, the second becomes the edge and shifts right by half
    // its width — into the third, which a single pass (measured with the
    // second still centred) would miss.
    const w = (s: string) => s.length * FONT_SIZE * 0.62;
    const turnX = 6;
    // Clear of `Sep 29` centred, overlapping it left-anchored.
    const thirdX = turnX + w('Sep 29') / 2 + 4 + w('16:00') / 2 + 2;
    const ticks = [
      { x: 0, label: '15:00' },
      { x: turnX, label: 'Sep 29', bold: true },
      { x: thirdX, label: '16:00' },
      { x: 400, label: '18:00' },
    ];
    expect(labels(fitTimeLabels(ticks, 'auto', FONT_SIZE, FAMILY))).toEqual([
      'Sep 29',
      '18:00',
    ]);
  });
});

describe('time axis label fit — rendered', () => {
  const H = 3_600_000;
  const M = 60_000;
  const day = (d: number) => Date.UTC(2026, 8, d);
  const session = (d: number) => ({
    date: new Date(day(d)).toISOString().slice(0, 10),
    open: day(d) + 13.5 * H,
    close: day(d) + 20 * H,
  });
  // A calendar derived from bars: one stray 08:00 print on Sep 29 makes a
  // one-minute session ahead of the real open.
  const sessions = [
    session(25),
    session(28),
    {
      date: '2026-09-29-stray',
      open: day(29) + 8 * H,
      close: day(29) + 8 * H + M,
    },
    session(29),
    session(30),
  ];

  const drawnLabels = (dom: HTMLElement): string[] =>
    Array.from(dom.querySelectorAll('[data-axis="x"] > div'))
      .map((el) => el.textContent ?? '')
      .filter((t) => t !== '');

  it('the stray-bar open and the real open no longer overprint', () => {
    const { container: dom } = render(
      <ChartContainer
        // The last two hours of Sep 28, across the seam, into Sep 29.
        range={[day(28) + 18 * H, day(29) + 16.5 * H]}
        width={1200}
        timeZone="UTC"
        discontinuities={sessionsProvider(sessions)}
      />,
    );
    const drawn = drawnLabels(dom);
    // The day turn survives; the clock label at the real open (1 live minute
    // to its right) is the one dropped.
    expect(drawn).toContain('Sep 29');
    expect(drawn).not.toContain('13:30');
    expect(drawn).toContain('14:00');
  });
});
