import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { BarList } from './BarList.js';
import { estelaTheme } from './theme.js';
import type { ListRow } from './list.js';

/**
 * Feature fan-out for `<BarList>` — one story per knob, so every prop has a
 * dedicated, reviewable state (the systematic-coverage discipline). The
 * real-pipeline compositions (splits from `aggregate`, traffic from
 * `partitionBy` + `reduce`) live in `Lists/Scenarios`.
 */
const meta: Meta<typeof BarList> = {
  title: 'Lists/BarList',
  component: BarList,
  // A fixed-width stage: the list is a width-filling table, so give it a real
  // width to fill (a bare story canvas would let the glyph tracks collapse).
  decorators: [
    (Story) => (
      <div style={{ width: 720 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof BarList>;

/** Hand-built rows: five hosts, two directions, one gap. */
const hosts: ListRow[] = [
  { key: 'web-1', values: { in: 62, out: 18 } },
  { key: 'web-2', values: { in: 95, out: 31 } },
  { key: 'db-1', values: { in: 40, out: 74 } },
  { key: 'cache-1', values: { in: 12, out: 6 } },
  { key: 'batch-1', values: { in: undefined, out: 22 } },
];

export const Default: Story = {
  render: () => (
    <BarList rows={hosts.slice(0, 4)} columns={[{ column: 'in' }]} />
  ),
};

/** Two bar lines per row — `in` on the default role, `out` on `secondary` —
 *  both on ONE shared scale so lengths compare across lines and rows. */
export const MultiColumn: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }, { column: 'out', as: 'secondary' }]}
    />
  ),
};

/** `sortBy` ranks the list (desc default — largest on top). With several
 *  columns, `sortBy` is the decision of which one drives the order. */
export const SortedDesc: Story = {
  render: () => (
    <BarList
      rows={hosts}
      columns={[{ column: 'in' }, { column: 'out', as: 'secondary' }]}
      sortBy="in"
    />
  ),
};

export const SortedAsc: Story = {
  render: () => (
    <BarList
      rows={hosts}
      columns={[{ column: 'in' }]}
      sortBy="in"
      sortDirection="asc"
    />
  ),
};

/** A full custom comparator overrides `sortBy` (here: by key, A→Z). */
export const CustomSort: Story = {
  render: () => (
    <BarList
      rows={hosts}
      columns={[{ column: 'in' }]}
      sort={(a, b) => a.key.localeCompare(b.key)}
    />
  ),
};

/** An explicit domain pins the scale (bars no longer fill to the data max —
 *  compare `web-2` here vs in Default). */
export const ExplicitDomain: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }]}
      domain={[0, 200]}
    />
  ),
};

/** Data cells flank the bars: a tag cell before, a right-aligned readout after. */
export const CellsBeforeAfter: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }]}
      before={[
        {
          key: 'tier',
          render: (r) => (r.key.startsWith('web') ? 'edge' : 'core'),
        },
      ]}
      after={[
        {
          key: 'in',
          align: 'right',
          render: (r) =>
            typeof r.values.in === 'number' ? `${r.values.in} Mbps` : '—',
        },
      ]}
    />
  ),
};

/** `renderExpanded` adds the chevron column; expansion is per-row and keyed,
 *  so it survives a re-sort. `web-2` starts open via `defaultExpanded`. */
export const Expander: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }, { column: 'out', as: 'secondary' }]}
      sortBy="in"
      defaultExpanded={['web-2']}
      renderExpanded={(r) => (
        <div style={{ display: 'flex', gap: 24, color: '#64748b' }}>
          <span>in {r.values.in ?? '—'} Mbps</span>
          <span>out {r.values.out ?? '—'} Mbps</span>
          <span>host {r.key}</span>
        </div>
      )}
    />
  ),
};

/** Consumer-owned selection: click a row to mark it (the inset accent edge in
 *  the marks register), click again to clear. */
export const SelectedRow: Story = {
  render: function SelectedRowStory() {
    const [selected, setSelected] = useState<string | null>('db-1');
    return (
      <BarList
        rows={hosts.slice(0, 4)}
        columns={[{ column: 'in' }]}
        selected={selected}
        onRowClick={(r) => setSelected(r.key === selected ? null : r.key)}
      />
    );
  },
};

/** A missing value is a gap: an empty track (never a zero-length bar), and it
 *  sorts last in either direction (`batch-1` here, despite sortBy asc). */
export const MissingData: Story = {
  render: () => (
    <BarList
      rows={hosts}
      columns={[{ column: 'in' }]}
      sortBy="in"
      sortDirection="asc"
    />
  ),
};

/** `divided={false}` drops the row rules (the dark splits look). */
export const Undivided: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }]}
      divided={false}
    />
  ),
};

/** The origin baseline is opt-in for bars (the tracks already show zero);
 *  `baseline` draws the same rule `<BoxList>` defaults on. */
export const Baseline: Story = {
  render: () => (
    <BarList rows={hosts.slice(0, 4)} columns={[{ column: 'in' }]} baseline />
  ),
};

/** Taller bar lines via `barHeight` (px per line). */
export const BarHeight: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }]}
      barHeight={16}
    />
  ),
};

/** The same list restyled by swapping the theme — the single styling channel. */
export const EstelaTheme: Story = {
  render: () => (
    <div style={{ background: '#06191D', padding: 16 }}>
      <BarList
        rows={hosts.slice(0, 4)}
        columns={[{ column: 'in' }, { column: 'out', as: 'secondary' }]}
        sortBy="in"
        theme={estelaTheme}
      />
    </div>
  ),
};
