import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { BarList } from '../src/BarList.js';
import { defaultTheme } from '../src/theme.js';
import type { ListRow } from '../src/list.js';

afterEach(cleanup);

describe('<BarList series> — the series door', () => {
  const splits = () =>
    new TimeSeries({
      name: 'splits',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'speed', kind: 'number' },
      ] as const,
      rows: [
        [1000, 7.3],
        [2000, 15.3],
      ] as Array<[number, number]>,
    });

  it('one row per event, no shaping step; label option feeds the first cell', () => {
    const { container } = render(
      <BarList
        series={splits()}
        columns={[{ column: 'speed' }]}
        label={(i) => `${i + 1}`}
      />,
    );
    const keys = Array.from(container.querySelectorAll('[data-list-row]')).map(
      (r) => r.getAttribute('data-list-row'),
    );
    expect(keys).toEqual(['1000', '2000']);
    const labels = Array.from(
      container.querySelectorAll('[data-list-cell="label"]'),
    );
    expect(labels.map((l) => l.textContent)).toEqual(['1', '2']);
    const bars = Array.from(
      container.querySelectorAll('[data-list-bar="speed"]'),
    ) as HTMLElement[];
    // Shared [0, 15.3] fit.
    expect(bars[1]!.style.width).toBe('100%');
  });

  it('a ValueSeries rows per axis key', () => {
    const vs = ValueSeries.fromColumns({
      name: 'byKm',
      schema: [
        { name: 'km', kind: 'value' },
        { name: 'pace', kind: 'number' },
      ] as const,
      columns: { km: [1, 2], pace: [4.1, 3.9] },
    });
    const { container } = render(
      <BarList series={vs} columns={[{ column: 'pace' }]} />,
    );
    const keys = Array.from(container.querySelectorAll('[data-list-row]')).map(
      (r) => r.getAttribute('data-list-row'),
    );
    expect(keys).toEqual(['1', '2']);
  });

  it('rows and series are exactly-one-of — a COMPILE error either way', () => {
    // [PND-CHARTAPI]: both illegal shapes are rejected by the type system
    // now; `@ts-expect-error` fails the build if that ever regresses.
    // @ts-expect-error — neither door.
    expect(() => render(<BarList columns={[{ column: 'speed' }]} />)).toThrow(
      /exactly one/,
    );
    expect(() =>
      render(
        // @ts-expect-error — both doors.
        <BarList
          rows={[{ key: 'a', values: { speed: 1 } }]}
          series={splits()}
          columns={[{ column: 'speed' }]}
        />,
      ),
    ).toThrow(/exactly one/);
  });
});

const rows: ListRow[] = [
  { key: 'if-a', label: 'Interface A', values: { in: 50, out: 10 } },
  { key: 'if-b', values: { in: 100, out: 40 } },
  { key: 'if-c', values: { in: 25, out: undefined } },
];

const rowKeys = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-list-row]')).map((r) =>
    r.getAttribute('data-list-row'),
  );

describe('<BarList>', () => {
  it('renders one row per datum, label falling back to key', () => {
    const { container } = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} />,
    );
    expect(rowKeys(container)).toEqual(['if-a', 'if-b', 'if-c']);
    const labels = Array.from(
      container.querySelectorAll('[data-list-cell="label"]'),
    );
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
    const bars = Array.from(
      container.querySelectorAll('[data-list-bar="in"]'),
    ) as HTMLElement[];
    // Domain resolves [0, 100]: 50 → 50%, 100 → 100%, 25 → 25%.
    expect(bars.map((b) => b.style.width)).toEqual(['50%', '100%', '25%']);
  });

  it('an explicit domain overrides the data fit', () => {
    const { container } = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} domain={[0, 200]} />,
    );
    const bars = Array.from(
      container.querySelectorAll('[data-list-bar="in"]'),
    ) as HTMLElement[];
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
    const tracks = Array.from(first.querySelectorAll('[data-list-track]'));
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
    const cells = Array.from(
      container
        .querySelector('[data-list-row="if-a"]')!
        .querySelectorAll('[data-list-cell]'),
    );
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

  it('clickable rows are keyboard-reachable: focusable, Enter activates', () => {
    const onRowClick = vi.fn();
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        onRowClick={onRowClick}
      />,
    );
    const rowEl = container.querySelector(
      '[data-list-row="if-a"]',
    ) as HTMLElement;
    expect(rowEl.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(rowEl, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(rowEl, { key: ' ' });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    // A display-only list exposes no tab stops on its rows.
    cleanup();
    const bare = render(<BarList rows={rows} columns={[{ column: 'in' }]} />);
    expect(
      bare.container
        .querySelector('[data-list-row="if-a"]')!
        .getAttribute('tabindex'),
    ).toBeNull();
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

  it('markers rule every row and print a label strip; values join the auto fit', () => {
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        markers={[{ value: 200, label: 'capacity' }]}
      />,
    );
    // One dotted segment per data row, all at the marker's fraction — and the
    // 200 marker WIDENED the auto domain (data max 100), so bars halve.
    const segs = Array.from(
      container.querySelectorAll('[data-list-marker]'),
    ) as HTMLElement[];
    expect(segs).toHaveLength(3);
    expect(segs[0]!.style.left).toBe('calc(100% - 0.5px)');
    expect(segs[0]!.style.borderLeft).toContain('dotted');
    const bar = container.querySelector('[data-list-bar="in"]') as HTMLElement;
    expect(bar.style.width).toBe('25%'); // 50 / 200
    // The label strip sits above the data rows, centred on the rule.
    const strip = container.querySelector('[data-list-marker-labels]');
    expect(strip).not.toBeNull();
    const label = container.querySelector(
      '[data-list-marker-label]',
    ) as HTMLElement;
    expect(label.textContent).toBe('capacity');
    expect(label.style.left).toBe('100%');
  });

  it('an unlabelled marker draws rules but no strip; explicit domain clamps', () => {
    const { container } = render(
      <BarList
        rows={rows}
        columns={[{ column: 'in' }]}
        domain={[0, 100]}
        markers={[{ value: 250 }]}
      />,
    );
    expect(container.querySelector('[data-list-marker-labels]')).toBeNull();
    const seg = container.querySelector('[data-list-marker]') as HTMLElement;
    // Explicit domain wins: the out-of-domain marker clamps to the edge.
    expect(seg.style.left).toBe('calc(100% - 0.5px)');
    const bar = container.querySelector('[data-list-bar="in"]') as HTMLElement;
    expect(bar.style.width).toBe('50%'); // domain untouched by the marker
  });

  it('dividers rule every row after the first; divided={false} removes them', () => {
    const ruled = render(<BarList rows={rows} columns={[{ column: 'in' }]} />);
    const trs = Array.from(
      ruled.container.querySelectorAll('[data-list-row]'),
    ) as HTMLElement[];
    expect(trs[0]!.style.borderTop).toBe('');
    expect(trs[1]!.style.borderTop).toContain('1px solid');
    ruled.unmount();
    const plain = render(
      <BarList rows={rows} columns={[{ column: 'in' }]} divided={false} />,
    );
    const bare = Array.from(
      plain.container.querySelectorAll('[data-list-row]'),
    ) as HTMLElement[];
    expect(bare[1]!.style.borderTop).toBe('');
  });
});

describe('<BarList barColors> — per-row bar colour ([#650])', () => {
  const ZONES: ListRow[] = [
    { key: 'z1', label: 'Z1', values: { frac: 40 } },
    { key: 'z2', label: 'Z2', values: { frac: 30 } },
    { key: 'z3', label: 'Z3', values: { frac: 20 } },
  ];
  const RAMP = ['#0b3d3a', '#27a396', '#b6e7dd'];
  const barOf = (c: HTMLElement, key: string) =>
    c.querySelector(`[data-list-row="${key}"] [data-list-bar]`) as HTMLElement;

  it('paints each row its own colour', () => {
    const { container } = render(
      <BarList rows={ZONES} columns={[{ column: 'frac' }]} barColors={RAMP} />,
    );
    expect(
      ['z1', 'z2', 'z3'].map((k) => barOf(container, k).style.background),
    ).toEqual(RAMP);
  });

  it('falls back to the theme fill for an undefined or short entry', () => {
    // A partial list is legal — `binColors` has the same rule.
    const { container } = render(
      <BarList
        rows={ZONES}
        columns={[{ column: 'frac' }]}
        barColors={['#0b3d3a', undefined]}
      />,
    );
    expect(barOf(container, 'z1').style.background).toBe('#0b3d3a');
    for (const k of ['z2', 'z3'])
      expect(barOf(container, k).style.background).toBe(
        defaultTheme.bar.default.fill,
      );
  });

  it('follows the rows through a sort rather than the render order', () => {
    // The colours align to the rows the caller passed; the table renders
    // `sorted`. An index would repaint the ramp onto the wrong rows here.
    const { container } = render(
      <BarList
        rows={ZONES}
        columns={[{ column: 'frac' }]}
        barColors={RAMP}
        sortBy="frac"
        sortDirection="asc"
      />,
    );
    const order = Array.from(container.querySelectorAll('[data-list-row]')).map(
      (r) => r.getAttribute('data-list-row'),
    );
    expect(order).toEqual(['z3', 'z2', 'z1']); // ascending by frac
    // …and each row kept ITS colour, not the one at its new position.
    expect(barOf(container, 'z1').style.background).toBe(RAMP[0]);
    expect(barOf(container, 'z3').style.background).toBe(RAMP[2]);
  });

  it('keeps its own colour while selected, rather than swapping to highlight', () => {
    // The fill means something now, so the state treatment stands down — the
    // band and rail already say "selected". Same rule as a multi-metric row.
    const { container } = render(
      <BarList
        rows={ZONES}
        columns={[{ column: 'frac' }]}
        barColors={RAMP}
        selected="z2"
      />,
    );
    const bar = barOf(container, 'z2');
    expect(bar.style.background).toBe(RAMP[1]);
    expect(bar.style.background).not.toBe(defaultTheme.bar.default.highlight);
  });

  it('still swaps to highlight when NO per-row colour is given', () => {
    // The guard must not disable the existing treatment for everyone else.
    const { container } = render(
      <BarList rows={ZONES} columns={[{ column: 'frac' }]} selected="z2" />,
    );
    expect(barOf(container, 'z2').style.background).toBe(
      defaultTheme.bar.default.highlight,
    );
  });
});
