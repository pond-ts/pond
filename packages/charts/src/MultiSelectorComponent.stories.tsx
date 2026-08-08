import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sequence, TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { MultiSelector } from './selectors.js';
import { selectionContains } from './span.js';
import type { SelectInfo, SelectionEntry, SpanSelection } from './context.js';

/**
 * **`<MultiSelector>`** — sweep-select as a mounted component (interaction RFC
 * §8 / A4.2 / A5.2), the superset of `<Selector>`: a click still selects one
 * mark; a drag **sweeps** — the shared brush band extends, every covered mark
 * lights live through the plural `hovered`, and release reports
 * `(hits, modifiers, span)` once.
 *
 * The two currencies (A5.2): `hits` is every covered mark, materialised;
 * `span` is the compact descriptor the coverage demotes to — feed it back as
 * `selected` and every layer runs the same O(1)-per-mark containment test
 * `selectionContains` exports. **The library reports; you decide** — every
 * story's selection policy is a few lines of its own code.
 */
const meta = {
  title: 'Interactions/MultiSelector',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 6, 1);

/** Thirty daily interval bars — a deterministic random-ish walk. */
const daily = () =>
  new TimeSeries({
    name: 'daily',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 30 }, (_, i) => [
      [D0 + i * DAY, D0 + (i + 1) * DAY],
      6 + 4 * Math.sin(i / 3) + 1.5 * Math.sin(i * 1.7),
    ]) as [[number, number], number][],
  });

/** Six-hourly bars over ten days — four bars per calendar day, so a
 *  day-sequence sweep visibly captures whole days at a time. */
const sixHourly = () =>
  new TimeSeries({
    name: 'q',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 40 }, (_, i) => [
      [D0 + i * (DAY / 4), D0 + (i + 1) * (DAY / 4)],
      5 + 3 * Math.sin(i / 4) + Math.sin(i * 2.3),
    ]) as [[number, number], number][],
  });

const captionStyle = {
  font: '13px system-ui',
  color: '#667',
  marginTop: 4,
  maxWidth: 640,
} as const;

function describeSelection(sel: readonly SelectionEntry[]): string {
  if (sel.length === 0) return '—';
  return sel
    .map((e) =>
      'kind' in e && e.kind === 'span'
        ? `span [${new Date(e.x[0]).toISOString().slice(5, 10)} → ${new Date(
            e.x[1],
          )
            .toISOString()
            .slice(5, 10)})`
        : new Date((e as SelectInfo).key).toISOString().slice(5, 10),
    )
    .join(', ');
}

/**
 * **Sweep, freeform.** Mount a `<MultiSelector>` and drag across the bars: the
 * shared brush band tracks the drag (bin-snapped — a bar layer's own bins feed
 * the snap channel), release reports the covered marks plus the span, and the
 * consumer feeds the **span** back as `selected` — one compact entry, however
 * many bars it covers. A plain click still selects one bar; a click on empty
 * space clears.
 */
export const SweepBars: Story = {
  render: function SweepBarsStory() {
    const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
    const [count, setCount] = useState(0);
    return (
      <div>
        <ChartContainer width={640} selected={sel} range={[D0, D0 + 30 * DAY]}>
          <MultiSelector
            onSelect={(hits, _mods, span) => {
              setCount(hits.length);
              setSel(span !== null ? [span] : hits.slice(0, 1));
            }}
          />
          <ChartRow height={220}>
            <YAxis id="v" min={0} max={12} label="" />
            <Layers>
              <BarChart series={daily()} column="v" axis="v" id="daily" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={captionStyle}>
          Drag across the bars to sweep · click one bar to select just it ·
          click away to clear.
          <br />
          <strong>selected:</strong> {describeSelection(sel)} ({count} marks
          reported)
        </p>
      </div>
    );
  },
};

/**
 * **Sweep with a `sequence`.** The sweep extends **bucket by bucket** over the
 * declared sequence — here whole calendar days over six-hourly bars, so each
 * notch of the drag captures four bars at once and the committed span lands
 * exactly on day edges. This is `<RangeCursor sequence>`'s snap, on the
 * selection gesture (one shared snap channel, so band and sweep can never
 * disagree).
 */
export const SweepWithSequence: Story = {
  render: function SweepWithSequenceStory() {
    const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
    return (
      <div>
        <ChartContainer width={640} selected={sel} range={[D0, D0 + 10 * DAY]}>
          <MultiSelector
            sequence={Sequence.calendar('day')}
            onSelect={(_hits, _mods, span) =>
              setSel(span !== null ? [span] : [])
            }
          />
          <ChartRow height={220}>
            <YAxis id="v" min={0} max={10} label="" />
            <Layers>
              <BarChart series={sixHourly()} column="v" axis="v" id="q" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={captionStyle}>
          Drag: the sweep snaps to whole days (four bars per notch).
          <br />
          <strong>selected:</strong> {describeSelection(sel)}
        </p>
      </div>
    );
  },
};

/**
 * **Sweep + modifier.** pond reports the modifiers and applies no policy
 * (A4.1): this consumer unions — a plain sweep replaces the selection, a
 * ⌘/Ctrl-sweep **adds** another span to it. The whole policy is the ternary
 * in `onSelect`.
 */
export const SweepAdditive: Story = {
  render: function SweepAdditiveStory() {
    const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
    return (
      <div>
        <ChartContainer width={640} selected={sel} range={[D0, D0 + 30 * DAY]}>
          <MultiSelector
            onSelect={(_hits, mods, span) =>
              setSel((cur) =>
                span === null ? [] : mods?.additive ? [...cur, span] : [span],
              )
            }
          />
          <ChartRow height={220}>
            <YAxis id="v" min={0} max={12} label="" />
            <Layers>
              <BarChart series={daily()} column="v" axis="v" id="daily" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={captionStyle}>
          Sweep to select a run · hold ⌘/Ctrl and sweep again to add another ·
          click away to clear.
          <br />
          <strong>selected:</strong> {describeSelection(sel)}
        </p>
      </div>
    );
  },
};

/**
 * **A click still selects one mark.** `<MultiSelector>` is a superset of
 * `<Selector>` (§8): a press that never travels past the drag slop is a click
 * — one hit, `span: null` — so mounting the sweep costs nothing on the
 * gesture people already use. The readout shows which shape each gesture
 * reported.
 */
export const ClickStillSelectsOne: Story = {
  render: function ClickStillSelectsOneStory() {
    const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
    const [last, setLast] = useState('—');
    return (
      <div>
        <ChartContainer width={640} selected={sel} range={[D0, D0 + 30 * DAY]}>
          <MultiSelector
            onSelect={(hits, _mods, span) => {
              setLast(
                span !== null
                  ? `sweep: ${hits.length} marks + span`
                  : hits.length === 1
                    ? 'click: one mark, span null'
                    : 'click on empty space: deselect',
              );
              setSel(span !== null ? [span] : hits.slice(0, 1));
            }}
          />
          <ChartRow height={220}>
            <YAxis id="v" min={0} max={12} label="" />
            <Layers>
              <BarChart series={daily()} column="v" axis="v" id="daily" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={captionStyle}>
          Click a bar, then drag a run — same component, two payload shapes.
          <br />
          <strong>last gesture:</strong> {last}
        </p>
      </div>
    );
  },
};

/**
 * **Live preview during the drag.** `onHover` fires with the covered marks as
 * the sweep crosses them (frame-coalesced, delta-gated — RFC A1.4), and the
 * same set lights on the canvas through the plural `hovered`: the library owns
 * the state, each layer draws its own hover treatment (A3.4). Nothing else
 * crosses the boundary until release.
 */
export const LivePreviewDuringDrag: Story = {
  render: function LivePreviewStory() {
    const [preview, setPreview] = useState<readonly SelectInfo[]>([]);
    const [committed, setCommitted] = useState(0);
    return (
      <div>
        <ChartContainer width={640} range={[D0, D0 + 30 * DAY]}>
          <MultiSelector
            onHover={setPreview}
            onSelect={(hits) => setCommitted(hits.length)}
          />
          <ChartRow height={220}>
            <YAxis id="v" min={0} max={12} label="" />
            <Layers>
              <BarChart series={daily()} column="v" axis="v" id="daily" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={captionStyle}>
          Drag and watch the count track the band before you release.
          <br />
          <strong>previewing:</strong> {preview.length} marks ·{' '}
          <strong>last commit:</strong> {committed} marks
        </p>
      </div>
    );
  },
};

/**
 * **Sweep, then ⌘-click one out — A5.2's demote-on-edit worked example.** The
 * whole reason the release carries *both* currencies: the sweep commits the
 * compact span (and the consumer stashes the hits); to edit *inside* it, swap
 * the span entry for the stashed marks and filter — plain array arithmetic, no
 * interval math, and `selectionContains` keeps answering membership for
 * whatever mix results.
 */
export const DemoteOnEdit: Story = {
  render: function DemoteOnEditStory() {
    const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
    const [stash, setStash] = useState<readonly SelectInfo[]>([]);
    return (
      <div>
        <ChartContainer width={640} selected={sel} range={[D0, D0 + 30 * DAY]}>
          <MultiSelector
            onSelect={(hits, mods, span) => {
              if (span !== null) {
                // A sweep: hold the span, stash the marks it covered.
                setStash(hits);
                setSel([span]);
                return;
              }
              const hit = hits[0] ?? null;
              if (hit === null) {
                setSel([]);
                return;
              }
              if (mods?.additive) {
                setSel((cur) => {
                  if (selectionContains(cur, hit)) {
                    // Demote: the span becomes its stashed marks, minus the
                    // clicked one; mark entries just filter.
                    const marks = cur.some(
                      (e) => (e as SpanSelection).kind === 'span',
                    )
                      ? stash
                      : (cur as readonly SelectInfo[]);
                    return marks.filter(
                      (m) => m.key !== hit.key || m.id !== hit.id,
                    );
                  }
                  return [...cur, hit];
                });
                return;
              }
              setSel([hit]);
            }}
          />
          <ChartRow height={220}>
            <YAxis id="v" min={0} max={12} label="" />
            <Layers>
              <BarChart series={daily()} column="v" axis="v" id="daily" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={captionStyle}>
          Sweep a run of days, then ⌘/Ctrl-click one of the selected bars: the
          span demotes to its marks minus that bar. ⌘-click an unselected bar to
          add it back.
          <br />
          <strong>selected:</strong> {describeSelection(sel)}
        </p>
      </div>
    );
  },
};

/**
 * **The category axis sweeps the same gesture** — the `[PND-CATRANGE]`
 * fold-in (§8): because the payload is *marks*, ordinal and continuous are one
 * gesture. "Select the top four services" is a single drag; the span stores
 * slot units nobody has to read, and the hits carry the stable category
 * `mark` names.
 */
export const CategorySweep: Story = {
  render: function CategorySweepStory() {
    const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
    const [names, setNames] = useState<readonly string[]>([]);
    const services = [
      { label: 'api', value: 3.2 },
      { label: 'auth', value: 2.7 },
      { label: 'db', value: 2.1 },
      { label: 'cache', value: 1.4 },
      { label: 'queue', value: 0.9 },
      { label: 'search', value: 0.4 },
    ];
    return (
      <div>
        <ChartContainer width={640} selected={sel}>
          <MultiSelector
            onSelect={(hits, _mods, span) => {
              setNames(hits.map((h) => h.label));
              setSel(span !== null ? [span] : hits.slice(0, 1));
            }}
          />
          <ChartRow height={220}>
            <YAxis id="v" min={0} max={3.6} label="" />
            <Layers>
              <BarChart categories={services} id="svc" gap={6} />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <p style={captionStyle}>
          Drag across the ranked bars — one gesture instead of N ctrl-clicks.
          <br />
          <strong>swept:</strong> {names.join(', ') || '—'}
        </p>
      </div>
    );
  },
};
