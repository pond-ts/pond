import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';
import type { ChartTheme } from './theme.js';
import type { SelectInfo } from './context.js';

/**
 * **Multi-selection** ([PND-MULTISEL]) — the three pieces that let a consumer
 * own a multi-valued selection:
 *
 * - **`onSelect(hit, modifiers)`** reports the keyboard modifiers the click
 *   carried. Without them a consumer cannot implement ⌘/Ctrl-click-adds at all:
 *   the click has already been reduced to a hit, so every click had to be
 *   treated as a replace.
 * - **`selected` accepts a set** — `SelectInfo[]` as well as a single mark, so
 *   the library can *render* the multi-valued state the consumer holds.
 * - **`theme.bar.default.dimmed`** — one themed answer to "not in the
 *   selection", instead of every component inventing its own.
 *
 * **The library applies no set arithmetic.** There is no `selectionMode` and no
 * built-in toggle: it reports what happened and renders what it's given, and
 * the consumer owns the policy. Every story below does its own accumulate /
 * toggle in a handful of lines — that's the intended shape, not a workaround.
 */
const meta = {
  title: 'Interactions/MultiSelection',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const SERVICES = [
  { label: 'api', value: 2.7 },
  { label: 'auth', value: 1.4 },
  { label: 'cache', value: 0.6 },
  { label: 'db', value: 3.2 },
  { label: 'queue', value: 1.05 },
  { label: 'search', value: 0.3 },
];

/** `docsTheme` plus an explicit de-emphasis for out-of-selection bars. */
const dimTheme: ChartTheme = {
  ...docsTheme,
  bar: {
    ...docsTheme.bar,
    default: {
      ...docsTheme.bar.default,
      highlight: '#2f6fb5',
      dimmed: '#dfe4ea',
    },
  },
};

/** The whole consumer-side policy: replace, or ⌘/Ctrl-click to accumulate. */
function applyClick(
  cur: readonly SelectInfo[],
  hit: SelectInfo | null,
  additive: boolean,
): readonly SelectInfo[] {
  if (hit === null) return []; // empty click clears
  if (!additive) return [hit]; // plain click replaces
  return cur.some((m) => m.mark === hit.mark) // ⌘-click toggles
    ? cur.filter((m) => m.mark !== hit.mark)
    : [...cur, hit];
}

function Demo({
  theme,
  caption,
}: {
  theme: ChartTheme;
  caption: string;
}): React.ReactElement {
  const [sel, setSel] = useState<readonly SelectInfo[]>([]);
  return (
    <div>
      <ChartContainer
        width={640}
        theme={theme}
        selected={sel}
        onSelect={(hit, mods) =>
          setSel((cur) => applyClick(cur, hit, mods?.additive ?? false))
        }
      >
        <ChartRow height={240}>
          <YAxis id="v" label="" min={0} max={3.6} />
          <Layers>
            <BarChart categories={SERVICES} id="svc" gap={6} />
          </Layers>
        </ChartRow>
      </ChartContainer>
      <p style={{ font: '13px system-ui', color: '#667', marginTop: 4 }}>
        {caption}
        <br />
        <strong>selected:</strong> {sel.map((m) => m.mark).join(', ') || '—'}
      </p>
    </div>
  );
}

/**
 * **⌘/Ctrl-click accumulates.** Click a bar to select it; hold ⌘ (macOS) or
 * Ctrl and click others to add them; ⌘-click a selected bar to remove it;
 * click empty space to clear. All of that is the ~6-line `applyClick` in this
 * file — the library only supplied `modifiers.additive`.
 */
export const AdditiveClick: Story = {
  render: () => (
    <Demo
      theme={docsTheme}
      caption="Click to select · ⌘/Ctrl-click to add or remove · click away to clear."
    />
  ),
};

/**
 * **With a themed de-emphasis.** The same interaction against a theme that
 * defines `bar.default.dimmed`. Everything outside a non-empty selection
 * recedes to one themed colour — the state that was previously re-invented per
 * component (one consumer had three charts using `color-mix` at 22%, 28% and
 * 30% for this, in the same week).
 *
 * Nothing dims while the selection is empty: with nothing selected there is
 * nothing to recede from.
 */
export const DimmedOutOfSelection: Story = {
  render: () => (
    <Demo
      theme={dimTheme}
      caption="Select some bars — the rest recede to theme.bar.default.dimmed."
    />
  ),
};

/**
 * **Opt-in by construction.** The identical chart on a theme with no `dimmed`
 * value: selection still highlights, nothing dims. A theme that says nothing
 * about de-emphasis gets none — the library never invents one (RFC
 * `selection.md` A2.3).
 */
export const DimmingIsOptIn: Story = {
  render: () => (
    <Demo
      theme={docsTheme}
      caption="Same chart, a theme with no `dimmed` — selection lights, nothing recedes."
    />
  ),
};

/**
 * **Controlled from outside the chart.** `selected` is just a prop, so a set
 * can be driven by anything — here buttons, standing in for the filter model a
 * chart-as-filter-control is usually bound to. This is the case single
 * selection could not represent at all.
 */
function ExternalDemo(): React.ReactElement {
  const [sel, setSel] = useState<readonly SelectInfo[]>([]);
  const pick = (labels: string[]) =>
    setSel(
      labels.map((label) => ({
        id: 'svc',
        key: 0,
        value: 0,
        color: '#000',
        label,
        mark: label,
      })),
    );
  const btn = {
    font: '13px system-ui',
    padding: '4px 10px',
    marginRight: 6,
    cursor: 'pointer',
  } as const;
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <button style={btn} onClick={() => pick(['api', 'db'])}>
          Over 2.0
        </button>
        <button style={btn} onClick={() => pick(['cache', 'search'])}>
          Under 1.0
        </button>
        <button style={btn} onClick={() => pick([])}>
          Clear
        </button>
      </div>
      <ChartContainer
        width={640}
        theme={dimTheme}
        selected={sel}
        onSelect={(hit, mods) =>
          setSel((cur) => applyClick(cur, hit, mods?.additive ?? false))
        }
      >
        <ChartRow height={220}>
          <YAxis id="v" label="" min={0} max={3.6} />
          <Layers>
            <BarChart categories={SERVICES} id="svc" gap={6} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const ControlledFromOutside: Story = {
  render: () => <ExternalDemo />,
};

/**
 * **A single `SelectInfo` still works.** The prop is a *union*, so every
 * pre-existing single-selection caller is untouched — this story passes one
 * mark, not an array, and means exactly what it always did. That is what makes
 * the widening non-breaking.
 */
export const SingleMarkStillWorks: Story = {
  render: () => (
    <ChartContainer
      width={640}
      theme={docsTheme}
      selected={{
        id: 'svc',
        key: 0,
        value: 3.2,
        color: '#000',
        label: 'db',
        mark: 'db',
      }}
    >
      <ChartRow height={220}>
        <YAxis id="v" label="" min={0} max={3.6} />
        <Layers>
          <BarChart categories={SERVICES} id="svc" gap={6} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
