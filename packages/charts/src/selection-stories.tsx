import { useMemo, useState, type ReactNode } from 'react';
import type { StoryObj } from '@storybook/react-vite';
import type { BoundedSequence, Sequence } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { YAxis } from './YAxis.js';
import { Selector, MultiSelector } from './selectors.js';
import { RangeCursor } from './cursors.js';
import type { SelectInfo, SelectionEntry } from './context.js';
import { caption, type ChartFixture } from './selection-fixtures.js';

/**
 * **The selection matrix's rows** — one feature set, rendered against every
 * chart fixture (`selection-fixtures.tsx` supplies the columns).
 *
 * Every story here is generated from one definition, so a difference between
 * two columns is a difference in the **library**, not in how someone happened
 * to write the story. That is what makes walking the matrix a review technique
 * rather than a gallery — see CLAUDE.md → "Storybook stories".
 *
 * Stories whose subject is *not* chart-type dependent (the deprecation shim,
 * for instance) deliberately live in one column only; running them against
 * every fixture would test nothing new.
 */

type Story = StoryObj;
const H = 240;

/** The chart under test, wired identically in every cell. */
function Chart({
  fx,
  children,
  height = H,
  ...container
}: {
  fx: ChartFixture;
  children?: React.ReactNode;
  height?: number;
  [k: string]: unknown;
}) {
  return (
    <ChartContainer width={640} {...fx.container} {...container}>
      {children}
      <ChartRow height={height}>
        <YAxis
          id={fx.axis.id}
          label={fx.axis.label}
          min={fx.axis.min}
          max={fx.axis.max}
        />
        <Layers>{fx.renderLayer('svc')}</Layers>
      </ChartRow>
    </ChartContainer>
  );
}

const list = (fx: ChartFixture, sel: readonly SelectInfo[]) =>
  sel.map((m) => fx.describe(m)).join(', ') || '—';

// ── <Selector> ─────────────────────────────────────────────────────────────

/**
 * The `<Selector>` feature set for one chart type. `<RangeCursor>` is mounted
 * only where the fixture declares it draws — on an ordinal axis it does not,
 * and mounting one there costs the row its cursor entirely.
 */
export interface SelectorStories {
  MountedAtContainer: Story;
  MountedInRow: Story;
  NoSelector: Story;
  ControlledNoSelector: Story;
  ModifiersReported: Story;
  HoverOnly: Story;
  BareSelector: Story;
}

export function makeSelectorStories(fx: ChartFixture): SelectorStories {
  const Cursor = () => (fx.rangeCursor ? <RangeCursor /> : null);

  return {
    /** **Mounted at the container** — the ordinary case: one `<Selector>` as a
     *  child of `<ChartContainer>`, enabling the click for every row. It
     *  reports; this story's `useState` is the selection. */
    MountedAtContainer: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectInfo[]>([]);
        return (
          <div>
            <Chart fx={fx} selected={sel}>
              <Cursor />
              <Selector onSelect={(h) => setSel(h === null ? [] : [h])} />
            </Chart>
            <p style={caption}>
              Click a mark to select it, empty space to clear.{' '}
              <strong>selected:</strong> {list(fx, sel)}
            </p>
          </div>
        );
      },
    },

    /** **Mounted inside a row** — nearest mount wins, mirroring the cursor
     *  components. The top row selects; the bottom row's clicks are inert even
     *  though its layer carries an `id`. */
    MountedInRow: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectInfo[]>([]);
        return (
          <div>
            <ChartContainer width={640} {...fx.container} selected={sel}>
              <ChartRow height={150}>
                <YAxis
                  id={fx.axis.id}
                  label={fx.axis.label || 'primary'}
                  min={fx.axis.min}
                  max={fx.axis.max}
                />
                <Cursor />
                <Selector onSelect={(h) => setSel(h === null ? [] : [h])} />
                <Layers>{fx.renderLayer('svc')}</Layers>
              </ChartRow>
              <ChartRow height={110}>
                <YAxis
                  id={fx.secondary.axis.id}
                  label={fx.secondary.axis.label}
                  min={fx.secondary.axis.min}
                  max={fx.secondary.axis.max}
                />
                <Layers>{fx.secondary.renderLayer('err')}</Layers>
              </ChartRow>
            </ChartContainer>
            <p style={caption}>
              The top row selects; the bottom row has no{' '}
              <code>&lt;Selector&gt;</code> in scope. <strong>selected:</strong>{' '}
              {list(fx, sel)}
            </p>
          </div>
        );
      },
    },

    /** **No selector — the plot is inert.** An id-bearing, hit-testable layer
     *  whose clicks go nowhere: what a chart that selected on click *before*
     *  §7.1 now looks like until one is mounted. In dev the first such click
     *  logs a one-time migration warning. */
    NoSelector: {
      render: () => (
        <div>
          <Chart fx={fx}>
            <Cursor />
          </Chart>
          <p style={caption}>
            Click anywhere — nothing selects. Check the console for the one-time
            migration warning.
          </p>
        </div>
      ),
    },

    /** **Controlled selection with no selector mounted** — the case A1.2
     *  exists to protect. The buttons stand in for the legend chip / filter
     *  list that really drives this: the chart *displays* a selection owned
     *  elsewhere, and the plot is deliberately inert. This is also why §7.1's
     *  warning suppresses whenever `selected` is supplied (A2.6). */
    ControlledNoSelector: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectInfo[]>([
          fx.picks[0]!.info,
        ]);
        const btn = {
          font: '13px system-ui',
          padding: '4px 10px',
          marginRight: 6,
          cursor: 'pointer',
        } as const;
        const same = (a: SelectInfo, b: SelectInfo) =>
          a.mark !== undefined ? a.mark === b.mark : a.key === b.key;
        return (
          <div>
            <div style={{ marginBottom: 8 }}>
              {fx.picks.map((p) => (
                <button
                  key={p.label}
                  style={btn}
                  onClick={() =>
                    setSel((cur) =>
                      cur.some((m) => same(m, p.info))
                        ? cur.filter((m) => !same(m, p.info))
                        : [...cur, p.info],
                    )
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Chart fx={fx} selected={sel} />
            <p style={caption}>
              The buttons drive the highlight; clicking the plot does nothing.{' '}
              <strong>selected:</strong> {list(fx, sel)}
            </p>
          </div>
        );
      },
    },

    /** **The modifiers are reported; the policy is yours.** `onSelect`'s second
     *  argument carries `additive` (⌘ on macOS, Ctrl elsewhere) plus the raw
     *  keys. pond applies no policy and holds no set — the toggle below is this
     *  story's few lines, not the library's. */
    ModifiersReported: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectInfo[]>([]);
        const [last, setLast] = useState('—');
        const same = (a: SelectInfo, b: SelectInfo) =>
          a.mark !== undefined ? a.mark === b.mark : a.key === b.key;
        return (
          <div>
            <Chart fx={fx} selected={sel}>
              <Cursor />
              <Selector
                onSelect={(hit, mods) => {
                  setLast(
                    hit === null
                      ? 'null hit → clear'
                      : `${fx.describe(hit)} · additive=${mods?.additive ?? false}` +
                          ` shift=${mods?.shiftKey ?? false}` +
                          ` alt=${mods?.altKey ?? false}`,
                  );
                  setSel((cur) => {
                    if (hit === null) return [];
                    if (!(mods?.additive ?? false)) return [hit];
                    return cur.some((m) => same(m, hit))
                      ? cur.filter((m) => !same(m, hit))
                      : [...cur, hit];
                  });
                }}
              />
            </Chart>
            <p style={caption}>
              ⌘/Ctrl-click to add or remove; try shift and alt too.{' '}
              <strong>reported:</strong> {last}
              <br />
              <strong>selected:</strong> {list(fx, sel)}
            </p>
          </div>
        );
      },
    },

    /** **`onHover` only** — the readout-driving case. The click still selects
     *  (the *mount* is the enablement, not the callback), driving the
     *  container's own uncontrolled highlight since no `selected` is supplied. */
    HoverOnly: {
      render: function Render() {
        const [hov, setHov] = useState<SelectInfo | null>(null);
        return (
          <div>
            <Chart fx={fx} hovered={hov}>
              <Cursor />
              <Selector onHover={setHov} />
            </Chart>
            <p style={caption}>
              <strong>hovered:</strong>{' '}
              {hov === null ? '—' : `${fx.describe(hov)} (${hov.value})`}
            </p>
          </div>
        );
      },
    },

    /** **A bare `<Selector />`** — no callbacks at all; the mount is the whole
     *  statement. With no `selected` prop the container keeps the selection
     *  itself: the smallest working chart under the new model. */
    BareSelector: {
      render: () => (
        <div>
          <Chart fx={fx}>
            <Cursor />
            <Selector />
          </Chart>
          <p style={caption}>
            Uncontrolled: <code>&lt;Selector /&gt;</code> with no props, no{' '}
            <code>selected</code>.
          </p>
        </div>
      ),
    },
  };
}

// ── <MultiSelector> ────────────────────────────────────────────────────────

const describeEntries = (
  fx: ChartFixture,
  sel: readonly SelectionEntry[],
): string => {
  if (sel.length === 0) return '—';
  return sel
    .map((e) =>
      'kind' in e && e.kind === 'span'
        ? `span [${fx.describe({ key: e.x[0] } as SelectInfo)} → ${fx.describe({ key: e.x[1] } as SelectInfo)})`
        : fx.describe(e as SelectInfo),
    )
    .join(', ');
};

/**
 * The `<MultiSelector>` feature set for one chart type. `SweepWithSequence` is
 * generated only where the fixture declares a `sequence` — an ordinal axis has
 * no time bucketing, so that cell is a **gap in the matrix rather than a story
 * that quietly does nothing**.
 */
export interface MultiSelectorStories {
  SweepMarks: Story;
  ClickStillSelectsOne: Story;
  LivePreviewDuringDrag: Story;
  SweepAdditive: Story;
  DemoteOnEdit: Story;
  /** Only where the fixture declares a `sequence` — see the factory's doc. */
  SweepWithSequence?: Story;
}

export function makeMultiSelectorStories(
  fx: ChartFixture,
): MultiSelectorStories {
  const stories: MultiSelectorStories = {
    /** **Sweep, freeform.** Drag across the marks: the shared brush band
     *  tracks the drag (bin-snapped — a bar layer's own bins feed the snap
     *  channel), release reports the covered marks plus the span, and the
     *  consumer feeds the **span** back as `selected` — one compact entry
     *  however many marks it covers. A click still selects one. */
    SweepMarks: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
        const [count, setCount] = useState(0);
        return (
          <div>
            <Chart fx={fx} selected={sel} height={220}>
              <MultiSelector
                onSelect={(hits, _mods, span) => {
                  setCount(hits.length);
                  setSel(span !== null ? [span] : hits.slice(0, 1));
                }}
              />
            </Chart>
            <p style={caption}>
              Drag to sweep · click one mark to select just it · click away to
              clear.
              <br />
              <strong>selected:</strong> {describeEntries(fx, sel)} ({count}{' '}
              marks)
            </p>
          </div>
        );
      },
    },

    /** **A click still selects one.** `<MultiSelector>` is a *superset* of
     *  `<Selector>`: below `DRAG_SLOP` the gesture is a click and reports
     *  `([hit], modifiers, null)` — a null span, since there is no range. */
    ClickStillSelectsOne: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
        const [shape, setShape] = useState('—');
        return (
          <div>
            <Chart fx={fx} selected={sel} height={220}>
              <MultiSelector
                onSelect={(hits, _mods, span) => {
                  setShape(
                    span === null
                      ? `click → ${hits.length} hit, span null`
                      : `sweep → ${hits.length} hits, span present`,
                  );
                  setSel(span !== null ? [span] : hits);
                }}
              />
            </Chart>
            <p style={caption}>
              Click, then drag, and watch the shape of the report change.{' '}
              <strong>last:</strong> {shape}
            </p>
          </div>
        );
      },
    },

    /** **Live preview.** Every covered mark lights through the plural
     *  `hovered` while the drag is in flight — and at rest the block a drag
     *  *would* select is already previewed. The count tracks the band before
     *  release; on release the commit equals what was lit. */
    LivePreviewDuringDrag: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
        const [preview, setPreview] = useState(0);
        const [committed, setCommitted] = useState(0);
        return (
          <div>
            <Chart fx={fx} selected={sel} height={220}>
              <MultiSelector
                onHover={(hits) => setPreview(hits.length)}
                onSelect={(hits, _mods, span) => {
                  setCommitted(hits.length);
                  setSel(span !== null ? [span] : hits);
                }}
              />
            </Chart>
            <p style={caption}>
              Hover, then drag, and watch the count track the band before you
              release.
              <br />
              <strong>previewing:</strong> {preview} marks ·{' '}
              <strong>last commit:</strong> {committed} marks
            </p>
          </div>
        );
      },
    },

    /** **Additive sweep, then edit.** ⌘/Ctrl-drag adds a span to the
     *  selection. The policy is the consumer's — and note it must handle the
     *  **click** case too: click and sweep arrive through one callback, so a
     *  policy that only handles spans deletes the selection on the very
     *  gesture meant to extend it. */
    SweepAdditive: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
        return (
          <div>
            <Chart fx={fx} selected={sel} height={220}>
              <MultiSelector
                onSelect={(hits, mods, span) => {
                  const add = mods?.additive ?? false;
                  if (span !== null) {
                    setSel((cur) => (add ? [...cur, span] : [span]));
                    return;
                  }
                  if (hits.length === 0) return setSel([]);
                  setSel((cur) => (add ? [...cur, hits[0]!] : [hits[0]!]));
                }}
              />
            </Chart>
            <p style={caption}>
              Sweep a range, then ⌘/Ctrl-click a mark to add it — and
              plain-click to replace. <strong>selected:</strong>{' '}
              {describeEntries(fx, sel)}
            </p>
          </div>
        );
      },
    },

    /** **Demote on edit (RFC A5.2).** A span is editable only *as a whole*; to
     *  edit inside one, swap the span entry for the marks stashed at commit
     *  time and filter. Plain array arithmetic — pond computes no policy, which
     *  is exactly why the descriptor has this shape. */
    DemoteOnEdit: {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
        const [stash, setStash] = useState<readonly SelectInfo[]>([]);
        return (
          <div>
            <Chart fx={fx} selected={sel} height={220}>
              <MultiSelector
                onSelect={(hits, mods, span) => {
                  if (span !== null) {
                    setStash(hits);
                    setSel([span]);
                    return;
                  }
                  const hit = hits[0];
                  if (hit === undefined) return setSel([]);
                  if (!(mods?.additive ?? false)) return setSel([hit]);
                  // Demote: the span becomes the marks it covered, minus this one.
                  setSel((cur) =>
                    cur.flatMap((e) =>
                      'kind' in e && e.kind === 'span'
                        ? stash.filter((m) => m.key !== hit.key)
                        : [e],
                    ),
                  );
                }}
              />
            </Chart>
            <p style={caption}>
              Sweep a run, then ⌘/Ctrl-click one inside it to knock it out — the
              span demotes to its marks. <strong>selected:</strong>{' '}
              {describeEntries(fx, sel)}
            </p>
          </div>
        );
      },
    },
  };

  if (fx.sequence !== undefined) {
    const seq = fx.sequence;
    /** **Sweep, snapped to a sequence.** The band, the preview and the
     *  committed span all snap to whole buckets — at rest the block under the
     *  pointer is already previewed, so what will be selected is visible before
     *  the drag starts. Only fixtures with a time bucketing generate this. */
    stories.SweepWithSequence = {
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
        const [count, setCount] = useState(0);
        return (
          <div>
            <Chart fx={fx} selected={sel} height={220}>
              <MultiSelector
                sequence={seq()}
                onSelect={(hits, _mods, span) => {
                  setCount(hits.length);
                  setSel(span !== null ? [span] : hits);
                }}
              />
            </Chart>
            <p style={caption}>
              The sweep snaps to whole buckets — hover first and the whole block
              previews. <strong>selected:</strong> {describeEntries(fx, sel)} (
              {count} marks)
            </p>
          </div>
        );
      },
    };
  }

  return stories;
}

// ── Session breaks ─────────────────────────────────────────────────────────

/**
 * **The two session-break cells** — generated only for a fixture whose axis
 * collapses closed-market time (`fx.sessions`).
 *
 * Every other cell in the matrix runs on an axis with no internal structure,
 * where a snap block is just an interval. A trading-time axis has **seams**,
 * and a wall-clock bucketing knows nothing about them — so "what does a
 * selection block do at a session break?" becomes a real question with two
 * answers worth seeing side by side. Both stories draw `sessionDividers`, so
 * the grid a block either respects or ignores is on screen.
 *
 * These live in one column by construction: there is nothing to compare them
 * against in a column whose axis has no seams.
 */
export interface SessionStories {
  SequenceConformsToSessions: Story;
  SequenceCrossesSessions: Story;
}

export function makeSessionStories(fx: ChartFixture): SessionStories | null {
  const sessions = fx.sessions;
  if (sessions === undefined) return null;

  /** Both cells are the same chart under a different bucketing — the only
   *  variable is the sequence, which is the whole comparison. */
  const cell = (sequence: () => Sequence | BoundedSequence, note: ReactNode) =>
    ({
      render: function Render() {
        const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
        const [count, setCount] = useState(0);
        const [preview, setPreview] = useState(0);
        const seq = useMemo(sequence, []);
        return (
          <div>
            <Chart fx={fx} selected={sel} height={220}>
              <MultiSelector
                sequence={seq}
                onHover={(hits) => setPreview(hits.length)}
                onSelect={(hits, _mods, span) => {
                  setCount(hits.length);
                  setSel(span !== null ? [span] : hits);
                }}
              />
            </Chart>
            <p style={caption}>
              {note}
              <br />
              <strong>previewing:</strong> {preview} bars ·{' '}
              <strong>selected:</strong> {describeEntries(fx, sel)} ({count}{' '}
              bars)
            </p>
          </div>
        );
      },
    }) satisfies Story;

  return {
    /** **The bucketing agrees with the sessions.** One block per session, so
     *  every block edge lands exactly on a divider and no block spans a
     *  collapsed gap. Hover a bar and its whole session lights; a click
     *  commits that session. */
    SequenceConformsToSessions: cell(
      sessions.conforming,
      <>
        One bucket <em>per session</em>: the band's edges land on the dividers,
        and no block ever spans a break.
      </>,
    ),

    /**
     * **The bucketing doesn't.** A wall-clock day anchored mid-session, so a
     * block is the afternoon of one session plus the morning of the next, and
     * the band crosses a divider. The collapsed gap has zero width, so the
     * block still draws as one rectangle — what it *contains* is two runs of
     * bars from different days.
     *
     * The weekend is where that stops being cosmetic. Wall-clock buckets keep
     * marching through Saturday and Sunday while the axis has no sessions to
     * give them, so the uniform run of 7-bar blocks breaks into **4, then an
     * empty bucket with no trading time in it at all, then 3** — a bucketing
     * that ignores the session grid cannot keep its blocks the same size.
     */
    SequenceCrossesSessions: cell(
      sessions.crossing,
      <>
        A wall-clock day anchored <em>mid-session</em>: each block takes one
        afternoon plus the next morning, so the band crosses a divider. Hover
        either side of the <strong>weekend</strong> divider — the blocks there
        are 4 bars and 3, not 7, and the bucket between them holds no trading
        time at all.
      </>,
    ),
  };
}
