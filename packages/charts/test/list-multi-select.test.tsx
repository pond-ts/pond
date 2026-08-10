import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BarList } from '../src/BarList.js';
import { BoxList } from '../src/BoxList.js';
import type { ListRow } from '../src/list.js';

afterEach(cleanup);

/**
 * **`selected` takes a set, matching `hovered`** ([PND-INTERACTCONF]).
 *
 * The list family was given the *receiving* half of the sweep vocabulary and
 * not the committing half: `hovered` went plural precisely because a sweep
 * lights several marks at once, while `selected` stayed `string | null`. That
 * asymmetry is what made a list multi-select impossible to express at all,
 * whatever gesture eventually drives it.
 *
 * The widening is additive — `string | null` is still assignable — so nothing
 * below is a behaviour change for an existing caller, and the first two cases
 * exist to pin exactly that.
 */

const hosts: ListRow[] = [
  { key: 'web-1', values: { in: 62 } },
  { key: 'web-2', values: { in: 95 } },
  { key: 'db-1', values: { in: 40 } },
  { key: 'db-2', values: { in: 12 } },
];
const columns = [{ column: 'in' }];
const boxRows: ListRow[] = hosts.map((r) => ({
  key: r.key,
  values: { lower: 1, median: 5, upper: 9 },
}));
const boxColumns = [{ lower: 'lower', median: 'median', upper: 'upper' }];

/** The keys of every row currently marked selected. */
const marked = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-list-row][data-selected]')).map((r) =>
    r.getAttribute('data-list-row'),
  );

describe('<BarList selected> — the widened union', () => {
  it('a bare key still selects exactly that row', () => {
    // The compatibility case: every caller that exists today passes a string.
    const { container } = render(
      <BarList rows={hosts} columns={columns} selected="web-2" />,
    );
    expect(marked(container)).toEqual(['web-2']);
  });

  it('null and omitted both select nothing', () => {
    const { container, rerender } = render(
      <BarList rows={hosts} columns={columns} selected={null} />,
    );
    expect(marked(container)).toEqual([]);
    rerender(<BarList rows={hosts} columns={columns} />);
    expect(marked(container)).toEqual([]);
  });

  it('a set marks several rows at once', () => {
    const { container } = render(
      <BarList rows={hosts} columns={columns} selected={['web-1', 'db-2']} />,
    );
    expect(marked(container)).toEqual(['web-1', 'db-2']);
  });

  it('an empty array selects nothing — it is not read as "all"', () => {
    // The edge a `Set`-based rewrite gets wrong in the other direction: an
    // empty selection must be empty, not a missing filter.
    const { container } = render(
      <BarList rows={hosts} columns={columns} selected={[]} />,
    );
    expect(marked(container)).toEqual([]);
  });

  it('a contiguous run marks exactly that run — the shape a sweep commits', () => {
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        selected={['web-2', 'db-1', 'db-2']}
      />,
    );
    expect(marked(container)).toEqual(['web-2', 'db-1', 'db-2']);
    // …and the rows outside it are genuinely untouched, not merely
    // un-attributed: the marked ones paint an edge and this one does not.
    const outside = container.querySelector(
      '[data-list-row="web-1"]',
    ) as HTMLElement;
    const inside = container.querySelector(
      '[data-list-row="db-1"]',
    ) as HTMLElement;
    expect(inside.style.boxShadow || inside.style.borderLeft).not.toBe(
      outside.style.boxShadow || outside.style.borderLeft,
    );
  });

  it('keys naming no row are ignored rather than throwing', () => {
    // A consumer holding a selection across a data change hands back keys
    // that may no longer exist — the list must survive it.
    const { container } = render(
      <BarList rows={hosts} columns={columns} selected={['gone', 'db-1']} />,
    );
    expect(marked(container)).toEqual(['db-1']);
  });

  it('selection and hover are independent channels on one row', () => {
    // They read the same union and the same normalization, so the risk is
    // that one gets wired to the other's set.
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        selected={['web-1']}
        hovered={['db-1']}
      />,
    );
    expect(marked(container)).toEqual(['web-1']);
    expect(
      Array.from(
        container.querySelectorAll('[data-list-row][data-hovered]'),
      ).map((r) => r.getAttribute('data-list-row')),
    ).toEqual(['db-1']);
  });
});

describe('<BoxList selected> — the same widening, the sister component', () => {
  it('a bare key still works, and a set marks several', () => {
    const { container, rerender } = render(
      <BoxList rows={boxRows} columns={boxColumns} selected="db-1" />,
    );
    expect(marked(container)).toEqual(['db-1']);
    rerender(
      <BoxList
        rows={boxRows}
        columns={boxColumns}
        selected={['web-1', 'db-1']}
      />,
    );
    expect(marked(container)).toEqual(['web-1', 'db-1']);
  });
});
