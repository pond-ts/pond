import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { BarList } from '../src/BarList.js';
import { BoxList } from '../src/BoxList.js';
import type { ListRow } from '../src/list.js';

afterEach(cleanup);

/**
 * **Keyboard parity with the range gesture.**
 *
 * There is no drag on a keyboard, so the range has to arrive as a *modifier*
 * there. That is not the contradiction with `SelectModifiers`' "an ordinal
 * range is a gesture, not a modifier" that it looks like: the note is about not
 * overloading a **pointer** chord that already means something else (a region
 * drag), and a keyboard has no competing gesture while Shift-Arrow is the one
 * range idiom every platform already teaches.
 *
 * The anchor is shared with the pointer path deliberately — click a row, then
 * Shift-Arrow, and the run starts where you clicked. Two input methods, one
 * model.
 */

const hosts: ListRow[] = [
  { key: 'a', values: { in: 10 } },
  { key: 'b', values: { in: 20 } },
  { key: 'c', values: { in: 30 } },
  { key: 'd', values: { in: 40 } },
  { key: 'e', values: { in: 50 } },
];
const columns = [{ column: 'in' }];

const row = (c: HTMLElement, key: string) =>
  c.querySelector(`[data-list-row="${key}"]`) as HTMLElement;
const focused = () =>
  (document.activeElement as HTMLElement | null)?.getAttribute(
    'data-list-row',
  ) ?? null;

/** Mount with a selection recorder; returns the keys of each reported run. */
function mount(extra?: { readonly onRowClick?: (r: ListRow) => void }) {
  const seen: Array<readonly string[]> = [];
  const { container } = render(
    <BarList
      rows={hosts}
      columns={columns}
      onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      {...extra}
    />,
  );
  return { container, seen };
}

describe('moving focus', () => {
  it('Arrow Down / Up walk the rows', () => {
    const { container } = mount();
    row(container, 'b').focus();
    fireEvent.keyDown(row(container, 'b'), { key: 'ArrowDown' });
    expect(focused()).toBe('c');
    fireEvent.keyDown(row(container, 'c'), { key: 'ArrowDown' });
    expect(focused()).toBe('d');
    fireEvent.keyDown(row(container, 'd'), { key: 'ArrowUp' });
    expect(focused()).toBe('c');
  });

  it('clamps at both ends rather than wrapping', () => {
    // Wrapping a *list* would teleport the reader from the top to the bottom;
    // clamping matches every native listbox.
    const { container } = mount();
    row(container, 'a').focus();
    fireEvent.keyDown(row(container, 'a'), { key: 'ArrowUp' });
    expect(focused()).toBe('a');
    row(container, 'e').focus();
    fireEvent.keyDown(row(container, 'e'), { key: 'ArrowDown' });
    expect(focused()).toBe('e');
  });

  it('Home / End jump to the ends', () => {
    const { container } = mount();
    row(container, 'c').focus();
    fireEvent.keyDown(row(container, 'c'), { key: 'End' });
    expect(focused()).toBe('e');
    fireEvent.keyDown(row(container, 'e'), { key: 'Home' });
    expect(focused()).toBe('a');
  });

  it('a plain move selects nothing', () => {
    // Navigation is not selection. A list where arrowing past a row selected
    // it would make the keyboard unable to *look* without committing.
    const { container, seen } = mount();
    row(container, 'a').focus();
    fireEvent.keyDown(row(container, 'a'), { key: 'ArrowDown' });
    fireEvent.keyDown(row(container, 'b'), { key: 'ArrowDown' });
    expect(seen).toEqual([]);
  });

  it('claims the key, so the page does not scroll under the list', () => {
    const { container } = mount();
    row(container, 'b').focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const el = document.activeElement as HTMLElement;
      expect(fireEvent.keyDown(el, { key })).toBe(false); // preventDefault'd
    }
  });

  it('leaves keys it does not own alone', () => {
    // Tab, typing, everything else must still reach the browser.
    const { container } = mount();
    row(container, 'b').focus();
    expect(fireEvent.keyDown(row(container, 'b'), { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(row(container, 'b'), { key: 'x' })).toBe(true);
    expect(focused()).toBe('b');
  });
});

describe('Shift extends from the anchor', () => {
  it('Shift-Down grows ONE run rather than walking a window', () => {
    // The anchor must hold across repeats. If it followed focus, the second
    // Shift-Down would report [c, d] instead of [b, c, d] — a two-row window
    // sliding down the list, which is the classic version of this bug.
    const { container, seen } = mount();
    row(container, 'b').focus();
    fireEvent.keyDown(row(container, 'b'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    fireEvent.keyDown(row(container, 'c'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    fireEvent.keyDown(row(container, 'd'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(seen).toEqual([
      ['b', 'c'],
      ['b', 'c', 'd'],
      ['b', 'c', 'd', 'e'],
    ]);
    expect(focused()).toBe('e');
  });

  it('shrinks again when the extend reverses', () => {
    const { container, seen } = mount();
    row(container, 'b').focus();
    fireEvent.keyDown(row(container, 'b'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    fireEvent.keyDown(row(container, 'c'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    fireEvent.keyDown(row(container, 'd'), { key: 'ArrowUp', shiftKey: true });
    expect(seen[seen.length - 1]).toEqual(['b', 'c']);
  });

  it('extends UPWARD, still reporting in display order', () => {
    const { container, seen } = mount();
    row(container, 'd').focus();
    fireEvent.keyDown(row(container, 'd'), { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(row(container, 'c'), { key: 'ArrowUp', shiftKey: true });
    expect(seen).toEqual([
      ['c', 'd'],
      ['b', 'c', 'd'],
    ]);
  });

  it('Shift-End and Shift-Home extend to the ends', () => {
    const { container, seen } = mount();
    row(container, 'c').focus();
    fireEvent.keyDown(row(container, 'c'), { key: 'End', shiftKey: true });
    expect(seen[0]).toEqual(['c', 'd', 'e']);
    fireEvent.keyDown(row(container, 'e'), { key: 'Home', shiftKey: true });
    // The anchor is still `c`, so Home extends back up to the top from THERE.
    expect(seen[1]).toEqual(['a', 'b', 'c']);
  });

  it('a plain move RE-anchors, so the next extend starts fresh', () => {
    const { container, seen } = mount();
    row(container, 'a').focus();
    fireEvent.keyDown(row(container, 'a'), { key: 'ArrowDown' }); // → b, anchor b
    fireEvent.keyDown(row(container, 'b'), { key: 'ArrowDown' }); // → c, anchor c
    fireEvent.keyDown(row(container, 'c'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(seen).toEqual([['c', 'd']]);
  });

  it('a plain move re-anchors even when an anchor ALREADY exists', () => {
    // The sharper version of the case above, and the only one that can tell
    // "plain arrows re-anchor" from "the `?? focused` fallback happens to give
    // the same answer": there is a real anchor at `a` first, so leaving it in
    // place would report [a, b, c, d] instead of [c, d]. Found by mutation —
    // the weaker test passed with the re-anchor removed entirely.
    const { container, seen } = mount();
    fireEvent.pointerDown(row(container, 'a'), {
      buttons: 1,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(row(container, 'a'), { pointerType: 'mouse' });
    fireEvent.click(row(container, 'a')); // anchor = a
    row(container, 'a').focus();
    fireEvent.keyDown(row(container, 'a'), { key: 'ArrowDown' }); // → b
    fireEvent.keyDown(row(container, 'b'), { key: 'ArrowDown' }); // → c
    fireEvent.keyDown(row(container, 'c'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(seen).toEqual([['a'], ['c', 'd']]);
  });

  it('with no anchor yet, extends from the row it left', () => {
    // Tab straight into the middle of a list and Shift-Down: there has been no
    // click and no arrow, so the honest anchor is where focus already was.
    const { container, seen } = mount();
    row(container, 'c').focus();
    fireEvent.keyDown(row(container, 'c'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(seen).toEqual([['c', 'd']]);
  });
});

describe('the anchor is shared with the pointer', () => {
  it('click a row, then Shift-Arrow, and the run starts at the click', () => {
    // The point of one anchor rather than two: the two input methods are one
    // model, so a user can start with the mouse and finish with the keyboard.
    const { container, seen } = mount();
    fireEvent.pointerDown(row(container, 'b'), {
      buttons: 1,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(row(container, 'b'), { pointerType: 'mouse' });
    fireEvent.click(row(container, 'b'));
    expect(seen).toEqual([['b']]);
    row(container, 'd').focus();
    fireEvent.keyDown(row(container, 'd'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    // Anchored at the CLICK (b), extended to the newly focused row (e).
    expect(seen[1]).toEqual(['b', 'c', 'd', 'e']);
  });

  it('a drag re-anchors where the press landed', () => {
    const { container, seen } = mount();
    fireEvent.pointerDown(row(container, 'd'), {
      buttons: 1,
      pointerType: 'mouse',
    });
    fireEvent.pointerEnter(row(container, 'c'), {
      buttons: 1,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(row(container, 'c'), { pointerType: 'mouse' });
    expect(seen).toEqual([['c', 'd']]);
    // The press was on `d`, so that is the anchor — not `c`, where it ended.
    row(container, 'd').focus();
    fireEvent.keyDown(row(container, 'd'), { key: 'ArrowUp', shiftKey: true });
    expect(seen[1]).toEqual(['c', 'd']);
  });
});

describe('Enter and Space', () => {
  it('select the focused row, and fire both callbacks', () => {
    const clicks: string[] = [];
    const { container, seen } = mount({
      onRowClick: (r) => clicks.push(r.key),
    });
    row(container, 'c').focus();
    fireEvent.keyDown(row(container, 'c'), { key: 'Enter' });
    fireEvent.keyDown(row(container, 'c'), { key: ' ' });
    expect(clicks).toEqual(['c', 'c']);
    expect(seen).toEqual([['c'], ['c']]);
  });

  it('carry modifiers, so ⌘/Ctrl-Enter is the additive chord', () => {
    // The keyboard equivalent of ⌘-click. Without modifiers reaching here the
    // keyboard could only ever replace a selection, never add to one.
    const seen: Array<{ keys: readonly string[]; additive: boolean }> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows, m) =>
          seen.push({ keys: rows.map((r) => r.key), additive: m.additive })
        }
      />,
    );
    row(container, 'b').focus();
    fireEvent.keyDown(row(container, 'b'), { key: 'Enter', metaKey: true });
    expect(seen).toEqual([{ keys: ['b'], additive: true }]);
  });

  it('re-anchor, so a following Shift-Arrow starts there', () => {
    const { container, seen } = mount();
    row(container, 'd').focus();
    fireEvent.keyDown(row(container, 'd'), { key: 'ArrowUp' }); // → c
    fireEvent.keyDown(row(container, 'c'), { key: 'Enter' }); // anchor c
    fireEvent.keyDown(row(container, 'c'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(seen).toEqual([['c'], ['c', 'd']]);
  });
});

describe('scope and mounting', () => {
  it('a list with no `onRowSelect` navigates but never extends', () => {
    // Arrows are navigation and belong to any interactive list; the RANGE is
    // what `onRowSelect` enables (A4.2 rule 1), so Shift-Arrow just moves.
    const clicks: string[] = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowClick={(r) => clicks.push(r.key)}
      />,
    );
    row(container, 'b').focus();
    fireEvent.keyDown(row(container, 'b'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(focused()).toBe('c');
    expect(clicks).toEqual([]);
  });

  it('a non-interactive list has no keyboard behaviour at all', () => {
    const { container } = render(<BarList rows={hosts} columns={columns} />);
    const r = row(container, 'b');
    expect(r.getAttribute('tabindex')).toBeNull();
    expect(fireEvent.keyDown(r, { key: 'ArrowDown' })).toBe(true);
  });

  it('arrows do not walk into a NESTED list', () => {
    // An expanded row's detail may hold a whole list of its own, whose rows
    // carry the same attribute. A descendant query would navigate somebody
    // else's rows — so the lookup is `:scope > tbody > tr`.
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={() => {}}
        defaultExpanded={['a']}
        renderExpanded={() => (
          <BarList
            rows={[
              { key: 'inner-1', values: { in: 1 } },
              { key: 'inner-2', values: { in: 2 } },
            ]}
            columns={columns}
          />
        )}
      />,
    );
    row(container, 'a').focus();
    fireEvent.keyDown(row(container, 'a'), { key: 'ArrowDown' });
    // `b`, the next row of THIS list — not `inner-1`, which sits in between
    // in document order.
    expect(focused()).toBe('b');
  });

  it('a <BoxList> gets the identical keyboard', () => {
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BoxList
        rows={hosts.map((r) => ({
          key: r.key,
          values: { lower: 1, median: 5, upper: 9 },
        }))}
        columns={[{ lower: 'lower', median: 'median', upper: 'upper' }]}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    row(container, 'b').focus();
    fireEvent.keyDown(row(container, 'b'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(seen).toEqual([['b', 'c']]);
  });
});

describe('end to end — keyboard only', () => {
  it('Tab in, Shift-Down twice, and three rows are selected', () => {
    function Harness() {
      const [sel, setSel] = useState<readonly string[]>([]);
      return (
        <BarList
          rows={hosts}
          columns={columns}
          selected={sel}
          onRowSelect={(rows) => setSel(rows.map((r) => r.key))}
        />
      );
    }
    const { container } = render(<Harness />);
    row(container, 'b').focus();
    fireEvent.keyDown(row(container, 'b'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    fireEvent.keyDown(row(container, 'c'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(
      Array.from(
        container.querySelectorAll('[data-list-row][data-selected]'),
      ).map((r) => r.getAttribute('data-list-row')),
    ).toEqual(['b', 'c', 'd']);
  });
});
