import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { BarList } from '../src/BarList.js';
import { BoxList } from '../src/BoxList.js';
import type { ListRow } from '../src/list.js';
import type { SelectModifiers } from '../src/context.js';

afterEach(cleanup);

/**
 * **The list's range gesture** — `onRowSelect`, which is how a user actually
 * produces a multi-row `selected`. Widening the prop gave the lists the
 * currency; this is the gesture that spends it.
 *
 * The design decision under test: **crossing into another row is what makes a
 * drag a range**, rather than a pixel slop. A row is tall and discrete, so
 * "did the pointer reach a different row" is the question the gesture turns
 * on — and asking it directly means a press-and-release can never accidentally
 * commit a range, and a horizontal wobble (meaningless on a stack of rows)
 * never can either. Both of those are asserted below, because both are the
 * failure a slop-based implementation would ship.
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
/** The rows currently painted as hovered — the drag's live preview. */
const lit = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-list-row][data-hovered]')).map((r) =>
    r.getAttribute('data-list-row'),
  );

/** Press on `from`, travel through each of `via`, release on the last. */
function drag(
  c: HTMLElement,
  from: string,
  via: readonly string[],
  opts: { readonly meta?: boolean; readonly releaseOutside?: boolean } = {},
) {
  fireEvent.pointerDown(row(c, from), { buttons: 1 });
  for (const key of via) fireEvent.pointerEnter(row(c, key), { buttons: 1 });
  const last = via.length > 0 ? via[via.length - 1]! : from;
  if (opts.releaseOutside) {
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, metaKey: opts.meta }),
      );
    });
    return;
  }
  fireEvent.pointerUp(row(c, last), { metaKey: opts.meta });
  // A real release also fires a click on the row under the pointer.
  fireEvent.click(row(c, last), { metaKey: opts.meta });
}

describe('a drag across rows commits the run', () => {
  it('reports the inclusive run, in display order', () => {
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'b', ['c', 'd']);
    expect(seen).toEqual([['b', 'c', 'd']]);
  });

  it('a drag UPWARD reports the same run, still in display order', () => {
    // The run is a span of the list, not a path the pointer walked — so it
    // must not arrive reversed just because the user dragged the other way.
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'd', ['c', 'b']);
    expect(seen).toEqual([['b', 'c', 'd']]);
  });

  it('reversing mid-drag follows the pointer rather than accumulating', () => {
    // Out to `e`, then back to `b`: the run is anchor→current, not every row
    // the pointer ever touched. An implementation that unions as it goes would
    // report all five.
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'c', ['d', 'e', 'd', 'c', 'b']);
    expect(seen).toEqual([['b', 'c']]);
  });

  it('lights the covered rows WHILE dragging — the live preview', () => {
    const { container } = render(
      <BarList rows={hosts} columns={columns} onRowSelect={() => {}} />,
    );
    fireEvent.pointerDown(row(container, 'b'), { buttons: 1 });
    fireEvent.pointerEnter(row(container, 'c'), { buttons: 1 });
    expect(lit(container)).toEqual(['b', 'c']);
    fireEvent.pointerEnter(row(container, 'd'), { buttons: 1 });
    expect(lit(container)).toEqual(['b', 'c', 'd']);
    // …and the preview collapses on release; it was never selection. What is
    // left is the ordinary single-row hover for wherever the pointer ended up,
    // which is `d` — so the assertion is "no longer a run", not "nothing".
    fireEvent.pointerUp(row(container, 'd'));
    expect(lit(container)).toEqual(['d']);
  });

  it('the preview OUT-RANKS a controlled `hovered` without touching it', () => {
    // While a run is being drawn it is what "would be selected if you released
    // now" — the canvas sweep clears the single-mark hover for exactly this
    // reason. The consumer's channel is out-ranked, not hijacked: `onHover`
    // must not fire.
    const onHover = vi.fn();
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        hovered="e"
        onHover={onHover}
        onRowSelect={() => {}}
      />,
    );
    expect(lit(container)).toEqual(['e']);
    fireEvent.pointerDown(row(container, 'a'), { buttons: 1 });
    fireEvent.pointerEnter(row(container, 'b'), { buttons: 1 });
    expect(lit(container)).toEqual(['a', 'b']);
    expect(onHover).not.toHaveBeenCalled();
    // Released — the consumer's hover is back, untouched.
    fireEvent.pointerUp(row(container, 'b'));
    expect(lit(container)).toEqual(['e']);
  });
});

describe('a click stays a click', () => {
  it('press and release on ONE row reports that row, not a range', () => {
    // The failure a pixel slop ships: a 5px jitter inside a 44px row would
    // arm a "range" of one row and swallow the click.
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'c', []);
    expect(seen).toEqual([['c']]);
  });

  it('re-entering the SAME row mid-press is still a click', () => {
    // Out of the row and back without reaching another — a wobble across the
    // row's own edge. `ranged` must not latch on the way through.
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'c', ['c']);
    expect(seen).toEqual([['c']]);
  });

  it('wandering to another row and BACK is a click again', () => {
    // `ranged` tracks where the pointer IS, not where it has been, so the user
    // is allowed to change their mind. Both callbacks are mounted because that
    // is where the difference shows: a range commits through `onRowSelect` and
    // swallows the click, so a sticky `ranged` would lose the `onRowClick`
    // entirely — and no other assertion in this file would notice.
    const clicks: string[] = [];
    const selects: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowClick={(r) => clicks.push(r.key)}
        onRowSelect={(rows) => selects.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'b', ['c', 'd', 'c', 'b']);
    expect(clicks).toEqual(['b']);
    expect(selects).toEqual([['b']]);
  });

  it('`onRowSelect` is a SUPERSET — both callbacks fire on a click', () => {
    const clicks: string[] = [];
    const selects: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowClick={(r) => clicks.push(r.key)}
        onRowSelect={(rows) => selects.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'b', []);
    expect(clicks).toEqual(['b']);
    expect(selects).toEqual([['b']]);
  });

  it('a ranged drag does NOT also report the row it ended on', () => {
    // The release fires a `click` too. Left unswallowed, the run would be
    // immediately overwritten by a single-row select — the multi-selection
    // would flash and vanish, which is the bug a consumer would report as
    // "drag doesn't work".
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'a', ['b', 'c']);
    expect(seen).toEqual([['a', 'b', 'c']]);
  });

  it('…and the click AFTER a ranged drag works again', () => {
    // The swallow is one-shot, not a latch.
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'a', ['b']);
    drag(container, 'd', []);
    expect(seen).toEqual([['a', 'b'], ['d']]);
  });
});

describe('modifiers and mounting', () => {
  it('reports the platform additive chord, and shift carries no meaning', () => {
    const seen: SelectModifiers[] = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(_rows, m) => seen.push(m)}
      />,
    );
    drag(container, 'b', ['c'], { meta: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.metaKey).toBe(true);
    // `shiftKey` is reported but the library gives it no behaviour — an
    // ordinal range is a gesture here, not a modifier (`SelectModifiers`).
    expect(seen[0]!.shiftKey).toBe(false);
  });

  it('no `onRowSelect` mounted ⇒ no gesture at all', () => {
    // A4.2 rule 1: the mount is the enablement. A list with only `onRowClick`
    // behaves exactly as it always has — dragging lights nothing.
    const clicks: string[] = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowClick={(r) => clicks.push(r.key)}
      />,
    );
    fireEvent.pointerDown(row(container, 'b'), { buttons: 1 });
    fireEvent.pointerEnter(row(container, 'c'), { buttons: 1 });
    // Row `c` lights because the pointer is over it — the list has always
    // tracked its own hover. What must NOT happen is a run: `b` stays dark.
    expect(lit(container)).toEqual(['c']);
    fireEvent.pointerUp(row(container, 'c'));
    fireEvent.click(row(container, 'c'));
    expect(clicks).toEqual(['c']);
  });

  it('a release outside the rows still commits the run', () => {
    // Without the window listener the drag would stay armed, and the next
    // stray pointerenter would resume a gesture the user had finished.
    const seen: Array<readonly string[]> = [];
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        onRowSelect={(rows) => seen.push(rows.map((r) => r.key))}
      />,
    );
    drag(container, 'b', ['c', 'd'], { releaseOutside: true });
    expect(seen).toEqual([['b', 'c', 'd']]);
    // …and the gesture is genuinely over: a later enter does not resume it.
    // `e` lights as an ordinary hover, alone — not as a run from the old
    // anchor, which is what a stranded `dragRef` would have produced.
    fireEvent.pointerEnter(row(container, 'e'), { buttons: 1 });
    expect(lit(container)).toEqual(['e']);
  });

  it('a <BoxList> gets the identical gesture', () => {
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
    drag(container, 'a', ['b', 'c']);
    expect(seen).toEqual([['a', 'b', 'c']]);
  });
});

describe('end to end — the run becomes a selection', () => {
  it('feeding `onRowSelect` back through `selected` marks the run', () => {
    // The whole loop, which is the thing a consumer actually writes: the
    // gesture reports, the consumer stores, the ladder paints.
    function Harness() {
      const [sel, setSel] = useState<readonly string[]>([]);
      return (
        <BarList
          rows={hosts}
          columns={columns}
          selected={sel}
          onRowSelect={(rows, m) =>
            setSel((cur) => {
              const keys = rows.map((r) => r.key);
              return m.additive ? [...new Set([...cur, ...keys])] : keys;
            })
          }
        />
      );
    }
    const { container } = render(<Harness />);
    drag(container, 'b', ['c']);
    const marked = () =>
      Array.from(
        container.querySelectorAll('[data-list-row][data-selected]'),
      ).map((r) => r.getAttribute('data-list-row'));
    expect(marked()).toEqual(['b', 'c']);

    // A plain second drag REPLACES…
    drag(container, 'd', ['e']);
    expect(marked()).toEqual(['d', 'e']);
    // …and an additive one unions, which is the consumer's policy, not ours.
    drag(container, 'a', ['b'], { meta: true });
    expect(marked()).toEqual(['a', 'b', 'd', 'e']);
  });
});
