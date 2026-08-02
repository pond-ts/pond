import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { BoxList } from '../src/BoxList.js';
import { defaultTheme, estelaTheme } from '../src/theme.js';
import type { BoxListColumn, ListRow } from '../src/list.js';

afterEach(cleanup);

// One interface: traffic ranges 10–90, IQR 30–60, median 45, now 70 — on the
// explicit [0, 100] domain every part's percentage is the value itself.
const rows: ListRow[] = [
  {
    key: 'if-a',
    values: {
      lo: 10,
      q1: 30,
      med: 45,
      q3: 60,
      hi: 90,
      now: 70,
    },
  },
];

const FULL: BoxListColumn = {
  lower: 'lo',
  q1: 'q1',
  median: 'med',
  q3: 'q3',
  upper: 'hi',
  value: 'now',
  format: (v) => `${v}Gbps`,
};

describe('<BoxList>', () => {
  it('draws range band, body, median, tick and label at their fractions', () => {
    const { container } = render(
      <BoxList rows={rows} columns={[FULL]} domain={[0, 100]} />,
    );
    const range = container.querySelector('[data-list-range]') as HTMLElement;
    expect(range.style.left).toBe('10%');
    expect(range.style.width).toBe('80%');
    expect(range.style.background).toBe(defaultTheme.box.default.whisker);
    const body = container.querySelector('[data-list-body]') as HTMLElement;
    expect(body.style.left).toBe('30%');
    expect(body.style.width).toBe('30%');
    expect(body.style.background).toBe(defaultTheme.box.default.fill);
    const median = container.querySelector('[data-list-median]') as HTMLElement;
    expect(median.style.left).toContain('45%');
    const tick = container.querySelector('[data-list-tick]') as HTMLElement;
    expect(tick.style.left).toContain('70%');
    expect(container.querySelector('[data-list-value]')!.textContent).toBe(
      '70Gbps',
    );
  });

  it('a range-only column draws no body; no value ⇒ no tick, no label', () => {
    const { container } = render(
      <BoxList
        rows={rows}
        columns={[{ lower: 'lo', upper: 'hi' }]}
        domain={[0, 100]}
      />,
    );
    expect(container.querySelector('[data-list-range]')).not.toBeNull();
    expect(container.querySelector('[data-list-body]')).toBeNull();
    expect(container.querySelector('[data-list-median]')).toBeNull();
    expect(container.querySelector('[data-list-tick]')).toBeNull();
    expect(container.querySelector('[data-list-value]')).toBeNull();
  });

  it('a tick without format draws the tick but prints nothing', () => {
    const { container } = render(
      <BoxList
        rows={rows}
        columns={[{ lower: 'lo', upper: 'hi', value: 'now' }]}
        domain={[0, 100]}
      />,
    );
    expect(container.querySelector('[data-list-tick]')).not.toBeNull();
    expect(container.querySelector('[data-list-value]')).toBeNull();
  });

  it('rejects a half-specified body (q1 without q3)', () => {
    expect(() =>
      render(
        <BoxList
          rows={rows}
          columns={[{ lower: 'lo', q1: 'q1', upper: 'hi' }]}
        />,
      ),
    ).toThrow(/both-or-neither/);
  });

  it('a row missing its range keeps an empty slot line (no collapsed row)', () => {
    const gappy: ListRow[] = [
      { key: 'gone', values: { lo: undefined, hi: undefined } },
    ];
    const { container } = render(
      <BoxList rows={gappy} columns={[{ lower: 'lo', upper: 'hi' }]} />,
    );
    expect(container.querySelector('[data-list-boxline]')).not.toBeNull();
    expect(container.querySelector('[data-list-range]')).toBeNull();
  });

  it('the domain resolves over lower/upper/value across all columns', () => {
    // No explicit domain: max is the value tick (95), min stays 0.
    const wide: ListRow[] = [{ key: 'a', values: { lo: 20, hi: 60, now: 95 } }];
    const { container } = render(
      <BoxList
        rows={wide}
        columns={[{ lower: 'lo', upper: 'hi', value: 'now' }]}
      />,
    );
    const range = container.querySelector('[data-list-range]') as HTMLElement;
    // 20 / 95 and (60 − 20) / 95 of the track.
    expect(range.style.left).toBe(`${(20 / 95) * 100}%`);
    expect(range.style.width).toBe(`${(40 / 95) * 100}%`);
  });

  it('columns resolve their theme role (secondary box exists in both themes)', () => {
    const { container } = render(
      <BoxList
        rows={rows}
        columns={[{ ...FULL, as: 'secondary' }]}
        domain={[0, 100]}
      />,
    );
    const range = container.querySelector('[data-list-range]') as HTMLElement;
    expect(range.style.background).toBe(defaultTheme.box.secondary!.whisker);
    expect(estelaTheme.box.secondary).toBeDefined();
  });

  it('sortBy works on any values entry (here the current value)', () => {
    const many: ListRow[] = [
      { key: 'slow', values: { lo: 0, hi: 50, now: 5 } },
      { key: 'fast', values: { lo: 0, hi: 90, now: 80 } },
    ];
    const { container } = render(
      <BoxList
        rows={many}
        columns={[{ lower: 'lo', upper: 'hi', value: 'now' }]}
        sortBy="now"
      />,
    );
    const keys = Array.from(container.querySelectorAll('[data-list-row]')).map(
      (r) => r.getAttribute('data-list-row'),
    );
    expect(keys).toEqual(['fast', 'slow']);
  });

  it('draws the origin baseline by default; baseline={false} drops it', () => {
    const on = render(
      <BoxList rows={rows} columns={[FULL]} domain={[0, 100]} />,
    );
    const glyphs = on.container.querySelector(
      '[data-list-cell="glyphs"]',
    ) as HTMLElement;
    expect(glyphs.style.borderLeft).toContain('1px solid');
    // The rule inks like the row dividers — one quiet reference grid.
    expect(glyphs.style.borderLeft).toContain(defaultTheme.axis.grid);
    // Left padding narrows to a 5px breath off the rule.
    expect(glyphs.style.padding).toBe('6px 8px 6px 5px');
    on.unmount();
    const off = render(
      <BoxList
        rows={rows}
        columns={[FULL]}
        domain={[0, 100]}
        baseline={false}
      />,
    );
    const bare = off.container.querySelector(
      '[data-list-cell="glyphs"]',
    ) as HTMLElement;
    expect(bare.style.borderLeft).toBe('');
  });

  it('markers draw through box rows at their fraction', () => {
    const { container } = render(
      <BoxList
        rows={rows}
        columns={[FULL]}
        domain={[0, 100]}
        markers={[{ value: 50, label: 'SLA' }]}
      />,
    );
    const seg = container.querySelector('[data-list-marker]') as HTMLElement;
    expect(seg.style.left).toBe('calc(50% - 0.5px)');
    expect(
      container.querySelector('[data-list-marker-label]')!.textContent,
    ).toBe('SLA');
  });

  it('the series door: quantile columns per event feed directly', () => {
    const s = new TimeSeries({
      name: 'q',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'lo', kind: 'number' },
        { name: 'hi', kind: 'number' },
      ] as const,
      rows: [[1000, 10, 90]] as Array<[number, number, number]>,
    });
    const { container } = render(
      <BoxList
        series={s}
        columns={[{ lower: 'lo', upper: 'hi' }]}
        domain={[0, 100]}
      />,
    );
    expect(container.querySelector('[data-list-row="1000"]')).not.toBeNull();
    const range = container.querySelector('[data-list-range]') as HTMLElement;
    expect(range.style.left).toBe('10%');
    expect(() =>
      render(<BoxList columns={[{ lower: 'lo', upper: 'hi' }]} />),
    ).toThrow(/exactly one/);
  });

  it('two box columns stack top→bottom within a row', () => {
    const twoDir: ListRow[] = [
      {
        key: 'if-a',
        values: { ilo: 10, ihi: 60, olo: 5, ohi: 30 },
      },
    ];
    const { container } = render(
      <BoxList
        rows={twoDir}
        columns={[
          { lower: 'ilo', upper: 'ihi' },
          { lower: 'olo', upper: 'ohi', as: 'secondary' },
        ]}
      />,
    );
    const lines = Array.from(container.querySelectorAll('[data-list-boxline]'));
    expect(lines).toHaveLength(2);
    const second = lines[1]!.querySelector('[data-list-range]') as HTMLElement;
    expect(second.style.background).toBe(defaultTheme.box.secondary!.whisker);
  });
});
