import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BarList } from '../src/BarList.js';
import { BoxList } from '../src/BoxList.js';
import { defaultTheme } from '../src/theme.js';
import type { ChartTheme } from '../src/theme.js';
import type { ListRow } from '../src/list.js';

afterEach(cleanup);

/**
 * **The row-chart state ladder** (owner spec, 2026-08-10) — rest, dimmed,
 * hover, selected, and the single- vs multi-metric split.
 *
 * The four rules it comes with are what these tests actually pin, because the
 * rules are the part that generalises and the hexes are not:
 *
 * 1. **The row is the target, not the bar** — one hit area, ≥44px.
 * 2. **The band carries selection alone** — band + rail must read as selected
 *    with no help from the fill, because a multi-metric row's fill is the
 *    metric's identity and cannot change.
 * 3. **Track is chrome, so it never dims** — the unfilled remainder is a
 *    scale, not a measurement; dimming it destroys the shared baseline.
 * 4. **Reserve blue even from markers** — a target tick inside a mark that
 *    selection recolors is the one collision the language cannot absorb.
 *
 * Rule 2 is the one worth reading closely below: it is asserted as an
 * *independence* property (chrome alone distinguishes the states) rather than
 * as "the fill is blue", which is the assertion that would let a regression
 * through on exactly the row type the rule exists for.
 */

/**
 * `defaultTheme` with the `list` register **omitted** — not set to `undefined`.
 * Under `exactOptionalPropertyTypes` those are different types, and only the
 * omission is what a hand-built theme predating the register actually looks
 * like.
 */
function themeWithoutList(): ChartTheme {
  const { list: _list, ...rest } = defaultTheme;
  return rest;
}

const hosts: ListRow[] = [
  { key: 'web-1', values: { in: 62, out: 20 } },
  { key: 'web-2', values: { in: 95, out: 44 } },
  { key: 'db-1', values: { in: 40, out: 11 } },
];
const one = [{ column: 'in' }];
// Two metrics in different hues — the case the rule exists for. `secondary`
// also has no `dimmed` token, so it exercises the opacity fallback.
const two = [{ column: 'in' }, { column: 'out', as: 'secondary' }] as const;

const REG = defaultTheme.list!;
const BAR = defaultTheme.bar.default;

/** CSS round-trips `rgba(a,b,c,d)` with spaces, so compare on a normal form. */
const css = (v: string) => v.replace(/\s+/g, '');

const row = (c: HTMLElement, key: string) =>
  c.querySelector(`[data-list-row="${key}"]`) as HTMLElement;
/** The filled portion of a row's bar for one metric. */
const bar = (c: HTMLElement, key: string, col = 'in') =>
  row(c, key).querySelector(`[data-list-bar="${col}"]`) as HTMLElement;
/** The unfilled remainder behind it — the track. */
const track = (c: HTMLElement, key: string, col = 'in') =>
  row(c, key).querySelector(`[data-list-track="${col}"] > div`) as HTMLElement;

describe('the ladder, state by state', () => {
  it('rest — no band, no rail, the metric’s own fill', () => {
    const { container } = render(
      <BarList rows={hosts} columns={one} onRowClick={() => {}} />,
    );
    const r = row(container, 'web-1');
    expect(r.style.background).toBe('');
    expect(r.style.boxShadow).toBe('');
    expect(bar(container, 'web-1').style.background).toBe(BAR.fill);
  });

  it('hover — band and rail, and the rail is never the selection hue', () => {
    const { container } = render(
      <BarList rows={hosts} columns={one} hovered="web-2" />,
    );
    const r = row(container, 'web-2');
    expect(r.style.background).toBe(REG.hoverBand);
    expect(r.style.boxShadow).toContain(REG.hoverRail);
    // Rule 4's sibling: blue is reserved for *committed*, so a merely hovered
    // row must not borrow it.
    expect(r.style.boxShadow).not.toContain(REG.selectedRail);
  });

  it('selected — band and rail, and on a SOLE metric the fill agrees', () => {
    const { container } = render(
      <BarList rows={hosts} columns={one} selected="web-2" />,
    );
    const r = row(container, 'web-2');
    expect(r.style.background).toBe(REG.selectedBand);
    expect(r.style.boxShadow).toContain(REG.selectedRail);
    expect(bar(container, 'web-2').style.background).toBe(BAR.highlight);
  });

  it('selection outranks hover on one row', () => {
    // A hovered selected row must not read as merely hovered: committed beats
    // transient, and the band and rail have to agree about which it is.
    const { container } = render(
      <BarList rows={hosts} columns={one} selected="web-2" hovered="web-2" />,
    );
    const r = row(container, 'web-2');
    expect(r.style.background).toBe(REG.selectedBand);
    expect(r.style.boxShadow).toContain(REG.selectedRail);
  });
});

describe('rule 2 — the band carries selection ALONE', () => {
  it('a multi-metric row’s fill does NOT change when selected', () => {
    // The rule's actual content. Hue is the metric's identity here, so
    // recolouring the fill would trade a distinction the reader needs for one
    // the chrome already gave them.
    const { container } = render(
      <BarList rows={hosts} columns={[...two]} selected="web-2" />,
    );
    // Each keeps its OWN hue — the stronger form of the rule than "the fill
    // did not turn blue": what must survive is the reader's ability to tell
    // the two metrics apart.
    expect(bar(container, 'web-2', 'in').style.background).toBe(BAR.fill);
    expect(bar(container, 'web-2', 'out').style.background).toBe(
      defaultTheme.bar.secondary!.fill,
    );
    // …and it is still unmistakably selected.
    expect(row(container, 'web-2').style.background).toBe(REG.selectedBand);
    expect(row(container, 'web-2').style.boxShadow).toContain(REG.selectedRail);
  });

  it('chrome alone separates rest from selected — on BOTH row kinds', () => {
    // The independence property, stated the way the rule is: whatever the
    // fill does, the chrome must already have said it. Asserted for the
    // single-metric row too, because the rule's second half is "design the
    // single-metric case that way too and one treatment covers every row
    // chart" — a single-metric-only signal would pass every other test here.
    for (const columns of [one, two]) {
      const { container, unmount } = render(
        <BarList rows={hosts} columns={[...columns]} selected="web-2" />,
      );
      const sel = row(container, 'web-2');
      const rest = row(container, 'db-1');
      expect(sel.style.background).not.toBe(rest.style.background);
      expect(sel.style.boxShadow).not.toBe(rest.style.boxShadow);
      unmount();
    }
  });
});

describe('rule 3 — the track never dims', () => {
  it('a dimmed row recedes its FILL and leaves the track at full strength', () => {
    const { container } = render(
      <BarList rows={hosts} columns={one} selected="web-2" />,
    );
    // `db-1` is not selected while something else is — the dimmed state.
    const dimmedBar = bar(container, 'db-1');
    expect(css(dimmedBar.style.background)).toBe(css(BAR.dimmed!));

    // The track behind it is untouched: same colour, same 0.15, as the
    // selected row's own track. This is the assertion that fails if a future
    // change dims the row wholesale (an opacity on the container, say) —
    // which is the tempting implementation and the one the rule forbids.
    const dimmedTrack = track(container, 'db-1');
    const selectedTrack = track(container, 'web-2');
    expect(dimmedTrack.style.background).toBe(BAR.fill);
    expect(dimmedTrack.style.opacity).toBe(selectedTrack.style.opacity);
  });

  it('nothing dims while the selection is empty', () => {
    // With nothing selected there is nothing to recede *from* — the same rule
    // `BarStyle.dimmed` states for the canvas.
    const { container } = render(<BarList rows={hosts} columns={one} />);
    for (const key of ['web-1', 'web-2', 'db-1'])
      expect(bar(container, key).style.background).toBe(BAR.fill);
  });

  it('a BoxList dims its marks but not its range band', () => {
    // The box list's track is the whisker span: it is what makes one row
    // comparable with the next.
    const boxRows: ListRow[] = hosts.map((r) => ({
      key: r.key,
      values: { lower: 1, q1: 3, median: 5, q3: 7, upper: 9 },
    }));
    const { container } = render(
      <BoxList
        rows={boxRows}
        columns={[
          {
            lower: 'lower',
            q1: 'q1',
            median: 'median',
            q3: 'q3',
            upper: 'upper',
          },
        ]}
        selected="web-2"
      />,
    );
    const dimmed = row(container, 'db-1');
    const range = dimmed.querySelector('[data-list-range]') as HTMLElement;
    const median = dimmed.querySelector('[data-list-median]') as HTMLElement;
    expect(range.style.opacity).toBe('0.55'); // untouched
    expect(Number(median.style.opacity)).toBeLessThan(1); // receded
  });
});

describe('rule 1 — the row is the target', () => {
  it('an interactive row reserves a 44px hit area', () => {
    const { container } = render(
      <BarList rows={hosts} columns={one} onRowClick={() => {}} />,
    );
    expect(row(container, 'web-1').style.height).toBe('44px');
  });

  it('…and a static list is left alone', () => {
    // A read-only list has no target to make tappable, and forcing the height
    // there would be a layout change for nothing.
    const { container } = render(<BarList rows={hosts} columns={one} />);
    expect(row(container, 'web-1').style.height).toBe('');
  });
});

describe('a theme with no `list` register keeps the pre-token look', () => {
  const bare: ChartTheme = themeWithoutList();

  it('hover falls back, selection keeps the annotation rail, nothing dims', () => {
    const { container, rerender } = render(
      <BarList rows={hosts} columns={one} hovered="web-1" theme={bare} />,
    );
    // The old hover band, borrowed from `legend.border`.
    expect(row(container, 'web-1').style.background).not.toBe(REG.hoverBand);
    expect(row(container, 'web-1').style.background).not.toBe('');

    rerender(
      <BarList rows={hosts} columns={one} selected="web-1" theme={bare} />,
    );
    // A rail still, from the annotation register — but no band…
    expect(row(container, 'web-1').style.boxShadow).toContain('inset 3px');
    expect(row(container, 'web-1').style.background).toBe('');
    // …and no dimmed state at all: it did not exist before the register did.
    expect(bar(container, 'db-1').style.background).toBe(BAR.fill);
  });
});
