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

/**
 * **Controlled hover** — the pin, not the pointer. `hovered` names the lit row
 * key, so something *outside* the list (a chart bar, a map segment, a sibling
 * table) can light a row without the cursor ever entering it. Nothing here
 * moves: that is the point.
 */
export const HoveredRow: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }]}
      hovered="db-1"
    />
  ),
};

/**
 * **Plural hover** — `hovered` takes a *set* of keys as well as a single one
 * (the same union `<Selector hovered>` takes), so a sweep, or a filter
 * that matched several entities, lights every one of them at once.
 */
export const HoveredRows: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }]}
      hovered={['web-2', 'cache-1']}
    />
  ),
};

/**
 * **Uncontrolled hover** — omit `hovered` and the list tracks its own pointer,
 * exactly as it always has. `onHover` still reports out (into the readout
 * below), and wiring *only* the callback adds no click affordance: hover is
 * not a click.
 */
export const UncontrolledHover: Story = {
  render: function UncontrolledHoverStory() {
    const [row, setRow] = useState<ListRow | null>(null);
    return (
      <div>
        <BarList
          rows={hosts.slice(0, 4)}
          columns={[{ column: 'in' }]}
          onHover={(r) => setRow(r)}
        />
        <div style={{ font: '12px system-ui', color: '#64748b', padding: 12 }}>
          onHover → {row === null ? 'null' : row.key}
        </div>
      </div>
    );
  },
};

/**
 * **Hover mirrored from an external control** — the driving case of #608 with
 * the buttons standing in for the chart: hovering a button lights the row, and
 * hovering the row lights the button, both through one piece of consumer-owned
 * state. The library reports and renders; the consumer decides. (The real list
 * ↔ chart version is `Lists/Scenarios` → `HoverLinkedChart`.)
 */
export const HoverMirrored: Story = {
  render: function HoverMirroredStory() {
    const [key, setKey] = useState<string | null>(null);
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}>
          {hosts.slice(0, 4).map((h) => (
            <button
              key={h.key}
              type="button"
              onPointerEnter={() => setKey(h.key)}
              onPointerLeave={() => setKey(null)}
              style={{
                font: '12px system-ui',
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                border: '1px solid #cbd5e1',
                background: key === h.key ? '#e2e8f0' : 'transparent',
              }}
            >
              {h.key}
            </button>
          ))}
        </div>
        <BarList
          rows={hosts.slice(0, 4)}
          columns={[{ column: 'in' }]}
          hovered={key}
          onHover={(r) => setKey(r?.key ?? null)}
        />
      </div>
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

/** Reference markers: a dotted rule through every row in the marks register,
 *  label printed above, centred on the rule. The 150 Mbps capacity marker
 *  exceeds the data max, so it WIDENS the auto domain rather than clamping. */
export const Markers: Story = {
  render: () => (
    <BarList
      rows={hosts.slice(0, 4)}
      columns={[{ column: 'in' }]}
      sortBy="in"
      markers={[
        { value: 150, label: 'capacity' },
        { value: 52.25, label: 'avg' },
      ]}
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
