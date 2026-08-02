import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { BarList } from '../src/BarList.js';
import { defaultTheme } from '../src/theme.js';
import type { ListRow } from '../src/list.js';

afterEach(cleanup);

const rows: ListRow[] = [
  { key: 'if-a', label: 'Interface A', values: { in: 50, out: 10 } },
  { key: 'if-b', values: { in: 100, out: 40 } },
  { key: 'if-c', values: { in: 25, out: undefined } },
];

const rowKeys = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-list-row]')].map((r) =>
    r.getAttribute('data-list-row'),
  );

describe('<BarList>', () => {
  it('renders one row per datum, label falling back to key', () => {
    const { container } = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} />,
    );
    expect(rowKeys(container)).toEqual(['if-a', 'if-b', 'if-c']);
    const labels = [...container.querySelectorAll('[data-list-cell="label"]')];
    expect(labels.map((l) => l.textContent)).toEqual([
      'Interface A',
      'if-b',
      'if-c',
    ]);
  });

  it('scales bar widths on the shared [0, max] domain', () => {
    const { container } = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} />,
    );
    const bars = [
      ...container.querySelectorAll('[data-list-bar="in"]'),
    ] as HTMLElement[];
    // Domain resolves [0, 100]: 50 → 50%, 100 → 100%, 25 → 25%.
    expect(bars.map((b) => b.style.width)).toEqual(['50%', '100%', '25%']);
  });

  it('an explicit domain overrides the data fit', () => {
    const { container } = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} domain={[0, 200]} />,
    );
    const bars = [
      ...container.querySelectorAll('[data-list-bar="in"]'),
    ] as HTMLElement[];
    expect(bars.map((b) => b.style.width)).toEqual(['25%', '50%', '12.5%']);
  });

  it('multiple columns render one track each, top→bottom in order', () => {
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }, { column: 'out', as: 'secondary' }]}
      />,
    );
    const first = container.querySelector('[data-list-row="if-a"]')!;
    const tracks = [...first.querySelectorAll('[data-list-track]')];
    expect(tracks.map((t) => t.getAttribute('data-list-track'))).toEqual([
      'in',
      'out',
    ]);
    // The second column resolves the theme's secondary bar style.
    const outBar = first.querySelector('[data-list-bar="out"]') as HTMLElement;
    expect(outBar.style.background).toBe(defaultTheme.bar.secondary!.fill);
    // ...and both live on ONE shared scale (max over all columns = 100).
    expect(outBar.style.width).toBe('10%');
  });

  it('a missing value renders an empty track (no bar) and sorts last', () => {
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'out' }]}
        sortBy="out"
        sortDirection="asc"
      />,
    );
    expect(rowKeys(container)).toEqual(['if-a', 'if-b', 'if-c']);
    const gapRow = container.querySelector('[data-list-row="if-c"]')!;
    expect(gapRow.querySelector('[data-list-track="out"]')).not.toBeNull();
    expect(gapRow.querySelector('[data-list-bar="out"]')).toBeNull();
  });

  it('sortBy ranks desc by default; custom sort overrides', () => {
    const desc = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} sortBy="in" />,
    );
    expect(rowKeys(desc.container)).toEqual(['if-b', 'if-a', 'if-c']);
    desc.unmount();
    const custom = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        sortBy="in"
        sort={(a, b) => a.key.localeCompare(b.key)}
      />,
    );
    expect(rowKeys(custom.container)).toEqual(['if-a', 'if-b', 'if-c']);
  });

  it('before / after cells render around the glyph cell, aligned as told', () => {
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        before={[{ key: 'type', render: (r) => `t:${r.key}` }]}
        after={[
          {
            key: 'val',
            align: 'right',
            render: (r) => `${r.values.in ?? '—'}`,
          },
        ]}
      />,
    );
    const cells = [
      ...container
        .querySelector('[data-list-row="if-a"]')!
        .querySelectorAll('[data-list-cell]'),
    ];
    expect(cells.map((c) => c.getAttribute('data-list-cell'))).toEqual([
      'label',
      'type',
      'glyphs',
      'val',
    ]);
    expect(cells[1]!.textContent).toBe('t:if-a');
    expect(cells[3]!.textContent).toBe('50');
    expect((cells[3] as HTMLElement).style.textAlign).toBe('right');
  });

  it('renderExpanded adds a chevron; toggling shows the detail row and reports', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        renderExpanded={(r) => <div>detail:{r.key}</div>}
        onExpandToggle={onToggle}
      />,
    );
    expect(container.querySelector('[data-list-detail]')).toBeNull();
    const button = container
      .querySelector('[data-list-row="if-b"]')!
      .querySelector('[data-list-expander]')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith('if-b', true);
    const detail = container.querySelector('[data-list-detail="if-b"]')!;
    expect(detail.textContent).toBe('detail:if-b');
    // The detail row spans every column (label + glyphs + expander).
    expect(detail.querySelector('td')!.getAttribute('colspan')).toBe('3');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenLastCalledWith('if-b', false);
    expect(container.querySelector('[data-list-detail]')).toBeNull();
  });

  it('defaultExpanded opens rows on first render; no expander UI without renderExpanded', () => {
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        renderExpanded={() => 'open'}
        defaultExpanded={['if-a']}
      />,
    );
    expect(container.querySelector('[data-list-detail="if-a"]')).not.toBeNull();
    cleanup();
    const bare = render(<BarList rows={rows} columns={[{ column: 'in' }]} />);
    expect(bare.container.querySelector('[data-list-expander]')).toBeNull();
  });

  it('row click reports the row; the expander click does not bubble into it', () => {
    const onRowClick = vi.fn();
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        onRowClick={onRowClick}
        renderExpanded={() => 'x'}
      />,
    );
    const rowEl = container.querySelector('[data-list-row="if-a"]')!;
    fireEvent.click(rowEl.querySelector('[data-list-cell="label"]')!);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]![0].key).toBe('if-a');
    fireEvent.click(rowEl.querySelector('[data-list-expander]')!);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('the selected row is stamped and accent-edged', () => {
    const { container } = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} selected="if-b" />,
    );
    const selectedRow = container.querySelector(
      '[data-list-row="if-b"]',
    ) as HTMLElement;
    expect(selectedRow.hasAttribute('data-selected')).toBe(true);
    expect(selectedRow.style.boxShadow).toContain('inset 3px 0 0');
    expect(
      container
        .querySelector('[data-list-row="if-a"]')!
        .hasAttribute('data-selected'),
    ).toBe(false);
  });

  it('no origin baseline by default; baseline opts it in', () => {
    const off = render(<BarList rows={rows} columns={[{ column: 'in' }]} />);
    const bare = off.container.querySelector(
      '[data-list-cell="glyphs"]',
    ) as HTMLElement;
    expect(bare.style.borderLeft).toBe('');
    off.unmount();
    const on = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} baseline />,
    );
    const glyphs = on.container.querySelector(
      '[data-list-cell="glyphs"]',
    ) as HTMLElement;
    expect(glyphs.style.borderLeft).toContain('1px solid');
  });

  it('dividers rule every row after the first; divided={false} removes them', () => {
    const ruled = render(<BarList rows={rows} columns={[{ column: 'in' }]} />);
    const trs = [
      ...ruled.container.querySelectorAll('[data-list-row]'),
    ] as HTMLElement[];
    expect(trs[0]!.style.borderTop).toBe('');
    expect(trs[1]!.style.borderTop).toContain('1px solid');
    ruled.unmount();
    const plain = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} divided={false} />,
    );
    const bare = [
      ...plain.container.querySelectorAll('[data-list-row]'),
    ] as HTMLElement[];
    expect(bare[1]!.style.borderTop).toBe('');
  });
});
