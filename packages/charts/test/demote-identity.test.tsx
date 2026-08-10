/**
 * **Demote-on-edit removes the mark you clicked — not every mark sharing its
 * key.**
 *
 * A key IS a bar's identity, so `m.key !== hit.key` looks like the right
 * filter and is right three times out of five. On a **stack** or a **heat
 * map** two marks share a bin and are separated by `label`, so the same
 * filter takes out the whole column. `<MultiSelector>`'s own demote story did
 * exactly that, in the file that is supposed to be the worked example, and it
 * surfaced as a column-shaped hole in a heat-map selection's perimeter — the
 * union outline was drawing a wrong selection faithfully.
 *
 * `sameMark` is the fix and the export that came out of it. These tests drive
 * the real stories, because that is where the mistake lived: a unit test of
 * `sameMark` alone would not have caught a consumer that never called it.
 */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { makeMultiSelectorStories } from '../src/selection-stories.js';
import { heatGrid, stackedBars, timeBars } from '../src/selection-fixtures.js';
import { sameMark } from '../src/span.js';
import type { SelectInfo } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/** Mount a fixture's `DemoteOnEdit` story and hand back a driver. */
function mountDemote(fx: Parameters<typeof makeMultiSelectorStories>[0]) {
  const Story = makeMultiSelectorStories(fx)!.DemoteOnEdit
    .render as () => ReactElement;
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    dom = render(<Story />).container;
  } finally {
    stub.restore();
  }
  const surface = dom.querySelector('canvas')!.parentElement!;
  const box = () => surface.getBoundingClientRect();
  const at = (fx0: number, fy0: number): [number, number] => {
    const r = box();
    // jsdom gives a zero-sized rect, so the fractions land on the plot's own
    // coordinate space directly — which is what the handlers read anyway.
    return [r.left + 600 * fx0, r.top + 200 * fy0];
  };
  const ev = (
    type: string,
    x: number,
    y: number,
    buttons: number,
    meta = false,
  ) =>
    act(() => {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons,
          metaKey: meta,
          pointerId: 1,
        }),
      );
    });
  return {
    dom,
    surface,
    /** The story's `selected:` readout, as the reader sees it. */
    readout: () => (dom.textContent ?? '').split('selected:')[1]?.trim() ?? '',
    sweep: (a: readonly [number, number], b: readonly [number, number]) => {
      const [x0, y0] = at(a[0], a[1]);
      const [x1, y1] = at(b[0], b[1]);
      ev('pointerdown', x0, y0, 1);
      ev('pointermove', x1, y1, 1);
      ev('pointerup', x1, y1, 0);
    },
    metaClick: (p: readonly [number, number]) => {
      const [x, y] = at(p[0], p[1]);
      ev('pointerdown', x, y, 1, true);
      ev('pointerup', x, y, 0, true);
      act(() => {
        surface.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            metaKey: true,
          }),
        );
      });
    },
  };
}

describe('demote-on-edit knocks out one mark, not a bin', () => {
  it('a heat map loses ONE cell — the other rows of its bin survive', () => {
    const t = mountDemote(heatGrid);
    // A heat-map sweep is a RECT, so the drag has to span the rows too — a
    // horizontal drag at one y captures a single row.
    t.sweep([0.15, 0.1], [0.6, 0.9]);

    expect(t.readout()).toContain('span ['); // the sweep committed a span
    t.metaClick([0.35, 0.55]);
    const after = t.readout();
    // The span demoted to its marks, so the readout is now a cell list.
    expect(after).not.toContain('span [');
    const cells = after.split(', ').filter((c) => c.includes('·'));
    expect(cells.length).toBeGreaterThan(3);
    // The clicked cell's DAY must still appear — its sibling rows are still
    // selected. `m.key !== hit.key` is what removed the whole column, and it
    // is the only way this assertion fails while the count above passes.
    const days = cells.map((c) => c.split('·')[0]!);
    const perDay = new Map<string, number>();
    for (const d of days) perDay.set(d, (perDay.get(d) ?? 0) + 1);
    // Exactly one day is short by one row; none is missing entirely.
    const counts = [...perDay.values()].sort();
    expect(counts[0]).toBe(counts[counts.length - 1]! - 1);
    expect(counts.filter((n) => n === counts[0]!)).toHaveLength(1);
  });

  it('a SECOND knock-out works — and a third, and a re-add', () => {
    // The first ⌘-click demotes the span; every one after it acts on a list
    // of marks, and the demote arm alone left those untouched — so the second
    // knock-out silently did nothing. Every existing test above stopped after
    // one click, which is exactly why that survived.
    const t = mountDemote(heatGrid);
    t.sweep([0.15, 0.1], [0.6, 0.9]);
    t.metaClick([0.35, 0.55]);
    const one = t.readout().split(', ').length;
    t.metaClick([0.45, 0.55]);
    const two = t.readout().split(', ').length;
    expect(two).toBe(one - 1);
    t.metaClick([0.25, 0.55]);
    expect(t.readout().split(', ').length).toBe(one - 2);
    // …and ⌘-clicking a knocked-out cell puts it back: the policy is a
    // toggle, which is what `selectionContains`' doc describes.
    t.metaClick([0.25, 0.55]);
    expect(t.readout().split(', ').length).toBe(one - 1);
  });

  it('a stacked bar loses ONE segment, for the same reason', () => {
    const t = mountDemote(stackedBars);
    t.sweep([0.15, 0.7], [0.6, 0.7]);
    expect(t.readout()).toContain('span [');
    t.metaClick([0.35, 0.75]);
    const after = t.readout();
    expect(after).not.toContain('span [');
    const marks = after.split(', ').filter((m) => m.includes('·'));
    const perBin = new Map<string, number>();
    for (const m of marks) {
      const k = m.split('·')[0]!;
      perBin.set(k, (perBin.get(k) ?? 0) + 1);
    }
    const counts = [...perBin.values()].sort();
    expect(counts[0]).toBe(counts[counts.length - 1]! - 1);
  });

  it('a bar chart is unaffected — its key WAS its identity all along', () => {
    // The case the old filter got right, kept so the fix is visibly a
    // widening rather than a change of behaviour where key sufficed.
    const t = mountDemote(timeBars);
    // Low in the plot, so the pointer is inside every bar's ink — a bar's
    // 'select' hit-test wants drawn pixels, not the full-height slot.
    t.sweep([0.15, 0.9], [0.6, 0.9]);
    const swept = t.readout();
    expect(swept).toContain('span [');
    t.metaClick([0.35, 0.9]);
    const after = t.readout();
    expect(after).not.toContain('span [');
    // A real mark list, not the empty readout — the assertion above passes
    // for '—' too, and a click that missed the ink would land there.
    expect(after).not.toBe('—');
    expect(after.split(', ').length).toBeGreaterThan(1);
  });
});

describe('`sameMark` — the identity the stories now share', () => {
  const cell = (
    key: number,
    label: string,
    over: Partial<SelectInfo> = {},
  ): SelectInfo => ({ id: 'h', key, value: 1, color: '#000', label, ...over });

  it('two rows of one bin are DIFFERENT marks', () => {
    expect(sameMark(cell(10, 'lo'), cell(10, 'hi'))).toBe(false);
    expect(sameMark(cell(10, 'lo'), cell(10, 'lo'))).toBe(true);
  });

  it('a stable `mark` decides when BOTH sides carry one', () => {
    const a = cell(10, 'lo', { mark: 'm1' });
    const b = cell(999, 'lo', { mark: 'm1' });
    expect(sameMark(a, b)).toBe(true); // the bogus key is irrelevant
    expect(sameMark(a, cell(10, 'lo', { mark: 'm2' }))).toBe(false);
  });

  it('…and the key is the fallback when either side lacks one', () => {
    expect(sameMark(cell(10, 'lo', { mark: 'm1' }), cell(10, 'lo'))).toBe(true);
    expect(sameMark(cell(10, 'lo', { mark: 'm1' }), cell(11, 'lo'))).toBe(
      false,
    );
  });

  it('never matches across layers', () => {
    expect(sameMark(cell(10, 'lo'), cell(10, 'lo', { id: 'other' }))).toBe(
      false,
    );
  });

  it('a series-scoped entry (NaN key) names no mark', () => {
    expect(sameMark(cell(NaN, 'lo'), cell(NaN, 'lo'))).toBe(false);
  });
});
