import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { Selector } from './selectors.js';
import type { SelectInfo } from './context.js';

/**
 * **`<Selector>` — click-select as a mounted component** (interaction RFC §7).
 *
 * Two rules, pulling in opposite directions, and both hold:
 *
 * - **Mounting is what enables the plot gesture** (§7.1). A plot click does
 *   nothing unless a `<Selector>` is mounted — selection turned out to be a
 *   whole subsystem (modifiers, a set, a de-emphasis slot, precedence against
 *   hover), and a subsystem that large should not switch itself on because a
 *   layer happened to be given an `id`. This is a **deliberate break**: charts
 *   that highlighted on click before now go inert until one is mounted.
 * - **`selected` / `hovered` stay on `<ChartContainer>`** (A1.2). The selector
 *   *reports*; the consumer owns the state and feeds it back. So controlled
 *   highlighting — a legend chip, an external filter list — keeps working with
 *   **no** `<Selector>` mounted at all.
 *
 * A layer `id` is **identity**; the mount is **enablement** (Q8). An untagged
 * layer is never hit-tested, so a click on one is a `null` hit — the same value
 * as a click on empty space, which is already the deselect path.
 *
 * The fan-out below walks the axes: the mount point (container / in-row / not
 * at all), the callbacks (`onSelect`, `onHover`, neither), the state (controlled
 * / uncontrolled), and the modifier-reporting case.
 */
const meta = {
  title: 'Interactions/Selector',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

const W = 620;

const SERVICES = [
  { label: 'api', value: 2.7 },
  { label: 'auth', value: 1.4 },
  { label: 'cache', value: 0.6 },
  { label: 'db', value: 3.2 },
  { label: 'queue', value: 1.05 },
  { label: 'search', value: 0.3 },
];

const ERRORS = [
  { label: 'api', value: 0.9 },
  { label: 'auth', value: 0.2 },
  { label: 'cache', value: 1.6 },
  { label: 'db', value: 0.4 },
  { label: 'queue', value: 1.1 },
  { label: 'search', value: 0.8 },
];

const caption = {
  font: '13px system-ui',
  color: '#667',
  marginTop: 4,
  maxWidth: W,
} as const;

/** A `SelectInfo` for one category — what an *external* control (a legend chip,
 *  a filter list) hands the chart. */
const svc = (label: string): SelectInfo => ({
  id: 'svc',
  key: 0,
  value: 0,
  color: '#000',
  label,
  mark: label,
});

/**
 * **Mounted at the container.** The ordinary case: one `<Selector>` as a child
 * of `<ChartContainer>`, enabling the click for every row. It reports; this
 * story's `useState` is the selection.
 */
export const MountedAtContainer: Story = {
  render: function Render() {
    const [sel, setSel] = useState<readonly SelectInfo[]>([]);
    return (
      <div>
        <ChartContainer width={W} selected={sel}>
          <Selector onSelect={(hit) => setSel(hit === null ? [] : [hit])} />
          <ChartRow height={240}>
            <YAxis id="v" label="" min={0} max={3.6} />
            <Layers>
              <BarChart categories={SERVICES} id="svc" gap={6} />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={caption}>
          Click a bar to select it, empty space to clear.{' '}
          <strong>selected:</strong> {sel.map((m) => m.mark).join(', ') || '—'}
        </p>
      </div>
    );
  },
};

/**
 * **Mounted inside a row.** A `<Selector>` inside a `<ChartRow>` scopes the
 * gesture to *that row* — nearest mount wins, mirroring the cursor components.
 * The top row here selects; the bottom row has no selector in scope and its
 * clicks are inert, even though its layer carries an `id`.
 */
export const MountedInRow: Story = {
  render: function Render() {
    const [sel, setSel] = useState<readonly SelectInfo[]>([]);
    return (
      <div>
        <ChartContainer width={W} selected={sel}>
          <ChartRow height={150}>
            <YAxis id="v" label="latency" min={0} max={3.6} />
            <Selector onSelect={(hit) => setSel(hit === null ? [] : [hit])} />
            <Layers>
              <BarChart categories={SERVICES} id="svc" gap={6} />
            </Layers>
          </ChartRow>
          <ChartRow height={110}>
            <YAxis id="e" label="errors" min={0} max={2} />
            <Layers>
              <BarChart categories={ERRORS} id="err" gap={6} as="warn" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={caption}>
          The top row selects; the bottom row's clicks do nothing — no{' '}
          <code>&lt;Selector&gt;</code> in its scope. <strong>selected:</strong>{' '}
          {sel.map((m) => m.mark).join(', ') || '—'}
        </p>
      </div>
    );
  },
};

/**
 * **No selector — the plot is inert.** The same chart with no `<Selector>`
 * mounted: an id-bearing, hit-testable layer whose clicks go nowhere. This is
 * what a chart that selected on click *before* this change now looks like until
 * one is mounted, and it is the shape §7.1 accepted deliberately.
 *
 * In a dev build the first such click logs a one-time warning naming
 * `<Selector>` — scoped to the deprecation window, since an `id` without a
 * selector is a legitimate configuration afterwards (identity without
 * enablement).
 */
export const NoSelector: Story = {
  render: () => (
    <div>
      <ChartContainer width={W}>
        <ChartRow height={240}>
          <YAxis id="v" label="" min={0} max={3.6} />
          <Layers>
            <BarChart categories={SERVICES} id="svc" gap={6} />
          </Layers>
        </ChartRow>
      </ChartContainer>
      <p style={caption}>
        Click anywhere — nothing selects. Check the console for the one-time
        migration warning.
      </p>
    </div>
  ),
};

/**
 * **Controlled selection with no selector mounted** — the case A1.2 exists to
 * protect. The buttons stand in for the legend chip / filter list that really
 * drives this pattern: the chart is a *display* of a selection owned elsewhere,
 * and the plot is deliberately inert.
 *
 * Note what is *not* here: no `<Selector>`, no `onSelect`. The highlight is
 * `selected` alone, and it keeps working — which is why the §7.1 warning
 * suppresses whenever `selected` is supplied (A2.6). Warning here would fire at
 * people doing exactly the endorsed thing.
 */
export const ControlledNoSelector: Story = {
  render: function Render() {
    const [sel, setSel] = useState<readonly SelectInfo[]>([svc('db')]);
    const btn = {
      font: '13px system-ui',
      padding: '4px 10px',
      marginRight: 6,
      cursor: 'pointer',
    } as const;
    return (
      <div>
        <div style={{ marginBottom: 8 }}>
          {SERVICES.map((c) => (
            <button
              key={c.label}
              style={btn}
              onClick={() =>
                setSel((cur) =>
                  cur.some((m) => m.mark === c.label)
                    ? cur.filter((m) => m.mark !== c.label)
                    : [...cur, svc(c.label)],
                )
              }
            >
              {c.label}
            </button>
          ))}
        </div>
        <ChartContainer width={W} selected={sel}>
          <ChartRow height={240}>
            <YAxis id="v" label="" min={0} max={3.6} />
            <Layers>
              <BarChart categories={SERVICES} id="svc" gap={6} />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={caption}>
          The buttons drive the highlight; clicking the plot does nothing.{' '}
          <strong>selected:</strong> {sel.map((m) => m.mark).join(', ') || '—'}
        </p>
      </div>
    );
  },
};

/**
 * **The modifiers are reported; the policy is yours.** `onSelect`'s second
 * argument carries `additive` (⌘ on macOS, Ctrl elsewhere) plus the raw keys.
 * pond applies no policy to them and **holds no set** — the toggle below is
 * this story's six lines, not the library's.
 *
 * The raw keys are reported too, deliberately without a derived meaning:
 * `shift` is already the region-drag chord, so think before you give it a
 * second one.
 */
export const ModifiersReported: Story = {
  render: function Render() {
    const [sel, setSel] = useState<readonly SelectInfo[]>([]);
    const [last, setLast] = useState('—');
    return (
      <div>
        <ChartContainer width={W} selected={sel}>
          <Selector
            onSelect={(hit, mods) => {
              setLast(
                hit === null
                  ? 'null hit → clear'
                  : `${hit.mark} · additive=${mods?.additive ?? false}` +
                      ` shift=${mods?.shiftKey ?? false}` +
                      ` alt=${mods?.altKey ?? false}`,
              );
              setSel((cur) => {
                if (hit === null) return [];
                if (!(mods?.additive ?? false)) return [hit];
                return cur.some((m) => m.mark === hit.mark)
                  ? cur.filter((m) => m.mark !== hit.mark)
                  : [...cur, hit];
              });
            }}
          />
          <ChartRow height={240}>
            <YAxis id="v" label="" min={0} max={3.6} />
            <Layers>
              <BarChart categories={SERVICES} id="svc" gap={6} />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={caption}>
          ⌘/Ctrl-click to add or remove; try shift and alt too.{' '}
          <strong>reported:</strong> {last}
          <br />
          <strong>selected:</strong> {sel.map((m) => m.mark).join(', ') || '—'}
        </p>
      </div>
    );
  },
};

/**
 * **`onHover` only.** A selector that reports hover and nothing else — the
 * readout-driving case. Note the click still selects (the mount is the
 * enablement, not the callback), driving the container's own uncontrolled
 * highlight since no `selected` is supplied.
 */
export const HoverOnly: Story = {
  render: function Render() {
    const [hov, setHov] = useState<SelectInfo | null>(null);
    return (
      <div>
        <ChartContainer width={W} hovered={hov}>
          <Selector onHover={setHov} />
          <ChartRow height={240}>
            <YAxis id="v" label="" min={0} max={3.6} />
            <Layers>
              <BarChart categories={SERVICES} id="svc" gap={6} />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={caption}>
          <strong>hovered:</strong> {hov?.mark ?? '—'}{' '}
          {hov === null ? '' : `(${hov.value})`}
        </p>
      </div>
    );
  },
};

/**
 * **A bare `<Selector />`.** No callbacks at all — the mount is the whole
 * statement: "clicks select here". With no `selected` prop the container keeps
 * the selection itself, which is the smallest possible working chart under the
 * new model.
 */
export const BareSelector: Story = {
  render: () => (
    <div>
      <ChartContainer width={W}>
        <Selector />
        <ChartRow height={240}>
          <YAxis id="v" label="" min={0} max={3.6} />
          <Layers>
            <BarChart categories={SERVICES} id="svc" gap={6} />
          </Layers>
        </ChartRow>
      </ChartContainer>
      <p style={caption}>
        Uncontrolled: `&lt;Selector /&gt;` with no props, no `selected`.
      </p>
    </div>
  ),
};

/**
 * **The deprecation shim.** `onSelect` / `onHover` on `<ChartContainer>` keep
 * working for one more minor: the container synthesizes an equivalent
 * registration, so this chart still selects — and dev-warns once, naming
 * `<Selector>` as the replacement. Mounting a real `<Selector>` in the same
 * scope overrides the props.
 */
export const LegacyContainerProps: Story = {
  render: function Render() {
    const [sel, setSel] = useState<readonly SelectInfo[]>([]);
    return (
      <div>
        <ChartContainer
          width={W}
          selected={sel}
          onSelect={(hit) => setSel(hit === null ? [] : [hit])}
        >
          <ChartRow height={240}>
            <YAxis id="v" label="" min={0} max={3.6} />
            <Layers>
              <BarChart categories={SERVICES} id="svc" gap={6} />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={caption}>
          Still works, still warns. <strong>selected:</strong>{' '}
          {sel.map((m) => m.mark).join(', ') || '—'}
        </p>
      </div>
    );
  },
};
