import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { BarList } from '../src/BarList.js';
import { BoxList } from '../src/BoxList.js';
import type { ListRow } from '../src/list.js';

afterEach(cleanup);

/**
 * The list family's hover channel ([PND-INTERACTCONF], issue #608) — the same
 * `hovered` / `onHover` pair `<ChartContainer>` gives the canvas layers, so a
 * consumer wiring a hover-linked list ↔ chart uses one vocabulary (RFC
 * `interaction.md` A3.1). Controlled in, notification out, plural set, and the
 * uncontrolled behaviour the list has always had left exactly as it was.
 */

const hosts: ListRow[] = [
  { key: 'web-1', values: { in: 62 } },
  { key: 'web-2', values: { in: 95 } },
  { key: 'db-1', values: { in: 40 } },
];
const columns = [{ column: 'in' }];

/** The keys of every row currently painted as hovered. */
const lit = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-list-row][data-hovered]')).map((r) =>
    r.getAttribute('data-list-row'),
  );
const row = (c: HTMLElement, key: string) =>
  c.querySelector(`[data-list-row="${key}"]`)!;

describe('<BarList hovered> — controlled hover in', () => {
  it('a single key lights that row and only that row', () => {
    const { container } = render(
      <BarList rows={hosts} columns={columns} hovered="web-2" />,
    );
    expect(lit(container)).toEqual(['web-2']);
    // Not just the attribute — the row actually paints.
    expect((row(container, 'web-2') as HTMLElement).style.background).not.toBe(
      '',
    );
    expect((row(container, 'db-1') as HTMLElement).style.background).toBe('');
  });

  it('a set lights several rows at once', () => {
    const { container } = render(
      <BarList rows={hosts} columns={columns} hovered={['web-1', 'db-1']} />,
    );
    expect(lit(container)).toEqual(['web-1', 'db-1']);
  });

  it('every member of a longer set lights — not just the first', () => {
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        hovered={['web-1', 'web-2', 'db-1']}
      />,
    );
    expect(lit(container)).toEqual(['web-1', 'web-2', 'db-1']);
  });

  it('`null` and `[]` both mean nothing hovered', () => {
    const { container, rerender } = render(
      <BarList rows={hosts} columns={columns} hovered={null} />,
    );
    expect(lit(container)).toEqual([]);
    rerender(<BarList rows={hosts} columns={columns} hovered={[]} />);
    expect(lit(container)).toEqual([]);
  });

  it('a controlled hover wins over the pointer — the prop is the state', () => {
    const { container } = render(
      <BarList rows={hosts} columns={columns} hovered="web-2" />,
    );
    fireEvent.pointerOver(row(container, 'db-1'));
    expect(lit(container)).toEqual(['web-2']);
  });

  it('re-rendering with a new key moves the light — the mirrored case', () => {
    const { container, rerender } = render(
      <BarList rows={hosts} columns={columns} hovered="web-1" />,
    );
    expect(lit(container)).toEqual(['web-1']);
    rerender(<BarList rows={hosts} columns={columns} hovered="db-1" />);
    expect(lit(container)).toEqual(['db-1']);
  });
});

describe('<BarList onHover> — hover out', () => {
  it('fires with the row on enter and `null` on leaving the rows', () => {
    const onHover = vi.fn();
    const { container } = render(
      <BarList rows={hosts} columns={columns} onHover={onHover} />,
    );
    fireEvent.pointerOver(row(container, 'db-1'));
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onHover).toHaveBeenLastCalledWith(hosts[2]);
    fireEvent.pointerOut(row(container, 'db-1'));
    expect(onHover).toHaveBeenCalledTimes(2);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('dedupes within a row — a move over a cell is not a new hover', () => {
    const onHover = vi.fn();
    const { container } = render(
      <BarList rows={hosts} columns={columns} onHover={onHover} />,
    );
    const target = row(container, 'web-1');
    fireEvent.pointerOver(target);
    fireEvent.pointerOver(target);
    fireEvent.pointerOver(target.querySelector('[data-list-cell="label"]')!);
    expect(onHover).toHaveBeenCalledTimes(1);
  });

  it('row → row reports the new row, with no `null` in between', () => {
    const onHover = vi.fn();
    const { container } = render(
      <BarList rows={hosts} columns={columns} onHover={onHover} />,
    );
    fireEvent.pointerOver(row(container, 'web-1'));
    fireEvent.pointerOver(row(container, 'db-1'));
    expect(onHover.mock.calls.map(([r]) => r?.key ?? null)).toEqual([
      'web-1',
      'db-1',
    ]);
  });

  it('notifies in controlled mode too (the consumer owns the state)', () => {
    const onHover = vi.fn();
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        hovered="web-2"
        onHover={onHover}
      />,
    );
    fireEvent.pointerOver(row(container, 'db-1'));
    expect(onHover).toHaveBeenLastCalledWith(hosts[2]);
    // …and does NOT light it: the prop still decides what paints.
    expect(lit(container)).toEqual(['web-2']);
  });

  it('carries the caller row type through (custom fields ride along)', () => {
    interface Split extends ListRow {
      readonly segment: number;
    }
    const rows: Split[] = [{ key: 'a', segment: 3, values: { in: 1 } }];
    const seen: Array<number | null> = [];
    const { container } = render(
      <BarList<Split>
        rows={rows}
        columns={columns}
        onHover={(r) => seen.push(r?.segment ?? null)}
      />,
    );
    fireEvent.pointerOver(row(container, 'a'));
    expect(seen).toEqual([3]);
  });
});

describe('list hover — uncontrolled, unchanged', () => {
  it('a clickable list still lights the row under the pointer', () => {
    const { container } = render(
      <BarList rows={hosts} columns={columns} onRowClick={() => {}} />,
    );
    expect(lit(container)).toEqual([]);
    fireEvent.pointerOver(row(container, 'db-1'));
    expect(lit(container)).toEqual(['db-1']);
    fireEvent.pointerOut(row(container, 'db-1'));
    expect(lit(container)).toEqual([]);
  });

  it('a plain list with no interaction wired still never lights a row', () => {
    const { container } = render(<BarList rows={hosts} columns={columns} />);
    fireEvent.pointerOver(row(container, 'db-1'));
    expect(lit(container)).toEqual([]);
  });

  it('wiring only `onHover` lights rows but adds no click affordance', () => {
    const { container } = render(
      <BarList rows={hosts} columns={columns} onHover={() => {}} />,
    );
    fireEvent.pointerOver(row(container, 'web-1'));
    expect(lit(container)).toEqual(['web-1']);
    expect((row(container, 'web-1') as HTMLElement).style.cursor).toBe('');
  });

  it('a nested list inside an expanded row does not hijack the outer hover', () => {
    const onHover = vi.fn();
    const { container } = render(
      <BarList
        rows={hosts}
        columns={columns}
        defaultExpanded={['web-1']}
        onHover={onHover}
        renderExpanded={() => (
          <BarList
            rows={[{ key: 'inner', values: { in: 5 } }]}
            columns={columns}
          />
        )}
      />,
    );
    fireEvent.pointerOver(row(container, 'web-1'));
    expect(lit(container)).toEqual(['web-1']);
    // Into the nested list's row: it belongs to another table, so the outer
    // list reports "off my rows" rather than a key it doesn't own.
    fireEvent.pointerOver(container.querySelector('[data-list-row="inner"]')!);
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(lit(container)).toEqual([]);
  });
});

describe('<BoxList> speaks the same channel', () => {
  const services: ListRow[] = [
    { key: 'api', values: { p5: 12, p50: 34, p95: 90 } },
    { key: 'auth', values: { p5: 8, p50: 19, p95: 44 } },
  ];
  const boxColumns = [{ lower: 'p5', median: 'p50', upper: 'p95' }] as const;

  it('controlled hover lights the named rows', () => {
    const { container } = render(
      <BoxList
        rows={services}
        columns={boxColumns}
        hovered={['api', 'auth']}
      />,
    );
    expect(lit(container)).toEqual(['api', 'auth']);
  });

  it('onHover reports the entered row', () => {
    const onHover = vi.fn();
    const { container } = render(
      <BoxList rows={services} columns={boxColumns} onHover={onHover} />,
    );
    fireEvent.pointerOver(row(container, 'auth'));
    expect(onHover).toHaveBeenLastCalledWith(services[1]);
  });
});
