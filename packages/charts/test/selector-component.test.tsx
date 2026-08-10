import { StrictMode, useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { Selector } from '../src/selectors.js';
import {
  ContainerContext,
  type ContainerFrame,
  type SelectInfo,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * `<Selector>` — selection as a mounted component (interaction RFC §7 /
 * §7.1 / A2.6 / A10 / Q8).
 *
 * Two rules pull in opposite directions, and both have to hold:
 *
 * - **Mounting enables the plot gesture.** With no `<Selector>` mounted a plot
 *   click does nothing — not even the uncontrolled internal highlight it used
 *   to do. That is the deliberate break §7.1 made.
 * - **`<Selector>` owns the state it drives** (A10.3): `selected` / `hovered`
 *   are its props, not the container's. `enabled={false}` disables the
 *   gesture while keeping the state — the legend-chip / external-list case
 *   that needs controlled highlighting with a deliberately inert plot.
 *
 * Everything here drives the **real components** through real DOM events. The
 * defect this wave keeps producing sits in the component wiring, not in the
 * pure functions underneath it, so a unit test of `effectiveSelectorEntries`
 * would not have caught any of it.
 */

const categories = [
  { label: 'alpha', value: 3 },
  { label: 'beta', value: 2 },
  { label: 'gamma', value: 1 },
];

/** Render a one-row chart; `children` goes inside the container (where a
 *  `<Selector>` mounts), `rowChildren` inside the `<ChartRow>`. `barId: null`
 *  omits the layer's `id` — an untagged layer is never hit-tested (Q8). */
function mount(
  props: Record<string, unknown> = {},
  children?: React.ReactNode,
  rowChildren?: React.ReactNode,
  barId: string | null = 'cap',
) {
  let cf: ContainerFrame | null = null;
  function Capture() {
    const c = useContext(ContainerContext);
    useEffect(() => {
      if (c) cf = c;
    });
    return null;
  }
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    const res = render(
      <ChartContainer width={300} {...props}>
        {children}
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} label="" />
          {rowChildren}
          <Layers>
            <BarChart
              categories={categories}
              {...(barId === null ? {} : { id: barId })}
            />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    dom = res.container;
  } finally {
    stub.restore();
  }
  const surface = dom.querySelector('canvas')!.parentElement!;
  /** A real plot click at `x` — the pointer pair first, since the click is only
   *  committed once the pair has established this wasn't a drag. */
  const click = (init: Partial<MouseEventInit> = {}, x = 40) => {
    fireEvent.pointerDown(surface, { clientX: x, clientY: 40 });
    fireEvent.pointerUp(surface, { clientX: x, clientY: 40 });
    fireEvent.click(surface, { clientX: x, clientY: 40, ...init });
  };
  const move = (x = 40) =>
    fireEvent.pointerMove(surface, { clientX: x, clientY: 40 });
  return { frame: () => cf!, surface, click, move };
}

/** Only the `<Selector>` migration warning — the other dev-warns (no `id`, …)
 *  are somebody else's test. */
const inertWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((c) => /no <Selector> is mounted/.test(String(c[0])));

describe('mounting <Selector> is what enables the plot click (§7.1)', () => {
  it('a mounted <Selector> reports the clicked mark', () => {
    const onSelect = vi.fn();
    const { click } = mount({}, <Selector onSelect={onSelect} />);
    click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const hit = onSelect.mock.calls[0]![0] as SelectInfo | null;
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('cap');
  });

  it('with NO selector mounted the click is inert — nothing is selected', () => {
    // The break. Before this change the container maintained an uncontrolled
    // `selected` whether or not anything was wired, so the bar lit up; now the
    // click does not even reach the internal state.
    const { frame, click } = mount();
    expect(frame().selected).toEqual([]);
    click();
    expect(frame().selected).toEqual([]);
  });

  it('…and the same click DOES select once a <Selector> is mounted', () => {
    // The mirror of the case above, so "inert" is pinned as *the mount's*
    // doing and not, say, a hit-test that stopped resolving.
    const { frame, click } = mount({}, <Selector />);
    click();
    expect(frame().selected).toHaveLength(1);
    expect(frame().selected[0]!.id).toBe('cap');
  });

  it('a bare <Selector> with no callbacks still enables the gesture', () => {
    // The mount is the enablement; the callbacks are reporting. A consumer
    // happy with the uncontrolled highlight mounts `<Selector />` and stops.
    const { frame, click } = mount({}, <Selector />);
    click();
    expect(frame().selected).toHaveLength(1);
  });

  it('reports a null hit for a click that resolves to no mark', () => {
    // Q8: "nothing identifiable here" is a null hit, which is the deselect
    // path — not a SelectInfo with a hole in it.
    const onSelect = vi.fn();
    const { frame, click } = mount(
      {},
      <Selector onSelect={onSelect} />,
      undefined,
      null, // no `id` on the bar ⇒ never hit-tested
    );
    click();
    expect(onSelect).toHaveBeenCalledWith(null, expect.anything());
    expect(frame().selected).toEqual([]);
  });

  it('scopes to its row when mounted inside a <ChartRow>', () => {
    const onSelect = vi.fn();
    const { click } = mount({}, undefined, <Selector onSelect={onSelect} />);
    click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('throws when mounted outside a <ChartContainer>', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Selector />)).toThrow(/<ChartContainer>/);
    err.mockRestore();
  });
});

describe('<Selector> owns controlled state (A10.3)', () => {
  it('`<Selector enabled={false} selected>` highlights with the gesture off', () => {
    // The case `enabled={false}` exists to protect: a legend chip or an
    // external filter list drives the chart, the plot is deliberately inert.
    const sel: SelectInfo = {
      id: 'cap',
      key: 0,
      value: 3,
      color: '#000',
      label: 'alpha',
      mark: 'alpha',
    };
    const { frame, click } = mount(
      {},
      <Selector enabled={false} selected={sel} />,
    );
    expect(frame().selected).toHaveLength(1);
    expect(frame().selected[0]!.mark).toBe('alpha');
    // And the gesture really is off — a click doesn't touch it.
    click();
    expect(frame().selected).toHaveLength(1);
    expect(frame().selected[0]!.mark).toBe('alpha');
  });

  it('`<Selector enabled={false} hovered>` lights with the gesture off', () => {
    const hov: SelectInfo = {
      id: 'cap',
      key: 0,
      value: 2,
      color: '#000',
      label: 'beta',
      mark: 'beta',
    };
    const { frame } = mount({}, <Selector enabled={false} hovered={hov} />);
    expect(frame().hovered).toHaveLength(1);
  });

  it('a controlled `selected` is not overwritten by a plot click', () => {
    const onSelect = vi.fn();
    const sel: SelectInfo[] = [];
    const { frame, click } = mount(
      {},
      <Selector selected={sel} onSelect={onSelect} />,
    );
    click();
    // Reported to the consumer, who owns the next set — the selector did not
    // take it upon itself to apply one.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(frame().selected).toBe(sel);
  });

  it('`onHover` on the selector reports the mark under the pointer', () => {
    const onHover = vi.fn();
    const { move } = mount({}, <Selector onHover={onHover} />);
    move(40);
    expect(onHover).toHaveBeenCalled();
    expect((onHover.mock.calls.at(-1)![0] as SelectInfo).id).toBe('cap');
  });

  it('the hover HIGHLIGHT works with no selector mounted', () => {
    // Hover is not gated: the highlight is internal state regardless, and
    // with nothing mounted there is simply nobody to report to.
    const { frame, move } = mount();
    move(40);
    expect(frame().hovered).toHaveLength(1);
  });
});

describe('the library reports; the consumer decides', () => {
  it('hands over the modifiers and applies no policy to them', () => {
    const onSelect = vi.fn();
    const { frame, click } = mount({}, <Selector onSelect={onSelect} />);
    click({ metaKey: true }, 40);
    expect(onSelect.mock.calls.at(-1)![1]).toMatchObject({
      additive: true,
      metaKey: true,
      shiftKey: false,
    });
    // ⌘-click again: pond holds no set, so the second click replaces rather
    // than accumulating. Set arithmetic is the consumer's.
    click({ metaKey: true });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(frame().selected).toHaveLength(1);
  });

  it('keeps the callback arity for a programmatic (legend) select', () => {
    const onSelect = vi.fn();
    const { frame } = mount({}, <Selector onSelect={onSelect} />);
    frame().select(null);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('a programmatic select is NOT gated on a mounted selector', () => {
    // §7.1 gates the *plot*. An explicit `select()` — a `<Legend>` chip, a
    // consumer's own control — is intentional by construction.
    const { frame } = mount();
    const hit: SelectInfo = {
      id: 'cap',
      key: 0,
      value: 3,
      color: '#000',
      label: 'alpha',
      mark: 'alpha',
    };
    act(() => frame().select(hit));
    expect(frame().selected).toEqual([hit]);
  });
});

// Removed: `<ChartContainer selected>` / `hovered` / `onSelect` / `onHover`
// no longer exist — no deprecation shim, straight deletion (pre-1.0). See
// docs/rfcs/interaction.md Amendment 10 and the CHANGELOG's migration note.
// The five tests that lived here ("the container `onSelect` prop still
// enables and reports the click", its `onHover` counterpart, the migration
// warning, "does not warn when neither legacy prop is set", and "a mounted
// <Selector> overrides the legacy prop") all asserted behavior of a surface
// that is now gone.

describe('the §7.1 dev warning (A2.6)', () => {
  it('fires when a click hits a mark and no <Selector> is mounted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount().click();
    expect(inertWarnings(warn)).toHaveLength(1);
    expect(String(inertWarnings(warn)[0]![0])).toMatch(/<Selector onSelect/);
    warn.mockRestore();
  });

  it('does NOT fire when controlled `selected` is in effect — the endorsed setup', () => {
    // A2.6: the inert-plot signature is *also* the signature of controlled
    // highlighting (`<Selector enabled={false} selected={…}>`), and the
    // warning should not spend its loudness on people already doing that.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({}, <Selector enabled={false} selected={null} />).click();
    expect(inertWarnings(warn)).toHaveLength(0);
    warn.mockRestore();
  });

  it('does NOT fire for a click that hit no mark', () => {
    // No hit, nothing lost — an untagged layer reads as empty space (Q8).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({}, undefined, undefined, null).click();
    expect(inertWarnings(warn)).toHaveLength(0);
    warn.mockRestore();
  });

  it('does NOT fire when a <Selector> is mounted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({}, <Selector />).click();
    expect(inertWarnings(warn)).toHaveLength(0);
    warn.mockRestore();
  });

  it('fires once, not per click', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { click } = mount();
    click();
    click();
    click();
    expect(inertWarnings(warn)).toHaveLength(1);
    warn.mockRestore();
  });
});

/**
 * Controlled state now resolves from the **selector registry** rather than a
 * container prop (A10.3), which is a new resolution path and was shipped with
 * no coverage of its own (reviewer finding on #638). These pin the three
 * things that path decides.
 */
describe('resolving the controlled-state owner (A10.3)', () => {
  const mk = (label: string, value: number): SelectInfo => ({
    id: 'cap',
    key: 0,
    value,
    color: '#000',
    label,
    mark: label,
  });

  it('a `gestureEnabled: false` selector still owns the state', () => {
    // The whole point of A10.2: the resolvers deliberately do NOT filter on
    // `gestureEnabled`, while `effectiveSelectorEntries` does. If that split
    // ever collapses, `enabled={false} selected={…}` silently stops working.
    const { frame } = mount(
      {},
      <Selector enabled={false} selected={mk('alpha', 3)} />,
    );
    expect(frame().selected).toHaveLength(1);
    expect(frame().selected[0]!.mark).toBe('alpha');
  });

  it('a selector that declares nothing leaves the chart uncontrolled', () => {
    // `declaresSelected` is about the PROP being passed, not about the value
    // being non-null — a bare `<Selector />` must not read as "controlled with
    // nothing selected", or a click could never light anything.
    const { frame, click } = mount({}, <Selector />);
    click();
    expect(frame().selected).toHaveLength(1);
  });

  it('distinguishes `selected={null}` from an absent `selected`', () => {
    // The other side of the same three-state shape: an explicit `null` IS
    // controlled, and pins the selection empty against a click.
    const { frame, click } = mount({}, <Selector selected={null} />);
    click();
    expect(frame().selected).toEqual([]);
  });

  it('first registered wins when two selectors declare `selected`, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { frame } = mount(
        {},
        <>
          <Selector enabled={false} selected={mk('first', 1)} />
          <Selector enabled={false} selected={mk('second', 2)} />
        </>,
      );
      expect(frame().selected[0]!.mark).toBe('first');
      const ambiguous = warn.mock.calls.filter((c) =>
        /more than one mounted <Selector>/.test(String(c[0])),
      );
      expect(ambiguous).toHaveLength(1);
      expect(String(ambiguous[0]![0])).toMatch(/`selected`/);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when only one selector declares `selected`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mount(
        {},
        <>
          <Selector selected={mk('alpha', 3)} />
          <Selector />
        </>,
      );
      expect(
        warn.mock.calls.filter((c) =>
          /more than one mounted <Selector>/.test(String(c[0])),
        ),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('`hovered` resolves independently of `selected`', () => {
    // Two selectors, one owning each channel — nothing couples them, so this
    // must work rather than one silently winning both.
    const { frame } = mount(
      {},
      <>
        <Selector enabled={false} selected={mk('alpha', 3)} />
        <Selector enabled={false} hovered={mk('beta', 2)} />
      </>,
    );
    expect(frame().selected[0]!.mark).toBe('alpha');
    expect(frame().hovered[0]!.mark).toBe('beta');
  });
});

/**
 * The cases the Codex pass on #638 found uncovered — and which turned out to
 * be exactly where the two High-severity bugs were hiding. All three are
 * revert-verified against the fixes they pin.
 */
describe('registry lifecycle and reference churn (Codex findings, #638)', () => {
  const mk = (label: string, value: number): SelectInfo => ({
    id: 'cap',
    key: 0,
    value,
    color: '#000',
    label,
    mark: label,
  });

  it('a fresh `selected` array with equal contents does not churn the registry', () => {
    // The loop's first link: an inline `selected={[…]}` mints a new reference
    // every render, so a reference-only register guard updates the registry
    // every time. `selectorEntryEqual` compares by VALUE, so a re-render with
    // an equal selection must leave the frame's identity alone — that identity
    // holding is what stops a context-consuming descendant from spinning.
    const seen: unknown[] = [];
    function Probe() {
      const c = useContext(ContainerContext);
      if (c) seen.push(c.selected);
      return null;
    }
    const stub = stubCanvasContext();
    const tree = () => (
      <ChartContainer width={300}>
        {/* a NEW array literal every render, same contents */}
        <Selector enabled={false} selected={[mk('alpha', 3)]}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={4} label="" />
            <Layers>
              <BarChart categories={categories} id="cap" />
            </Layers>
          </ChartRow>
        </Selector>
        <Probe />
      </ChartContainer>
    );
    let rerender: (ui: React.ReactElement) => void;
    try {
      ({ rerender } = render(tree()));
      seen.length = 0;
      rerender(tree());
      rerender(tree());
    } finally {
      stub.restore();
    }
    // Every observation after the settled first render is the same array
    // identity — no registry update, so nothing for a descendant to react to.
    const distinct = new Set(seen);
    expect(distinct.size).toBe(1);
    expect([...distinct][0]).toHaveLength(1);
  });

  it('a changed `selected` value still propagates', () => {
    // The other half — the guard must not be so eager that a real change is
    // swallowed. Without this, "no churn" could pass by never updating at all.
    const stub = stubCanvasContext();
    let frame: ContainerFrame | null = null;
    function Probe() {
      const c = useContext(ContainerContext);
      useEffect(() => {
        if (c) frame = c;
      });
      return null;
    }
    const tree = (label: string) => (
      <ChartContainer width={300}>
        <Selector enabled={false} selected={[mk(label, 3)]}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={4} label="" />
            <Layers>
              <BarChart categories={categories} id="cap" />
            </Layers>
          </ChartRow>
        </Selector>
        <Probe />
      </ChartContainer>
    );
    try {
      const { rerender } = render(tree('alpha'));
      expect(frame!.selected[0]!.mark).toBe('alpha');
      rerender(tree('beta'));
      expect(frame!.selected[0]!.mark).toBe('beta');
    } finally {
      stub.restore();
    }
  });

  it('unmounting the owner returns the chart to uncontrolled', () => {
    // **Scope note, because this test is weaker than it looks:** it pins that
    // removal takes effect, but it does NOT distinguish layout cleanup from
    // passive cleanup — reverting `unregisterSelector` to `useEffect` leaves it
    // green. The difference the Codex finding names is *paint* timing (a layout
    // cleanup runs before paint, a passive one after), and jsdom paints
    // nothing, so no assertion here can see it. The fix rests on documented
    // React phase semantics plus the symmetry argument, not on this test.
    const stub = stubCanvasContext();
    let frame: ContainerFrame | null = null;
    function Probe() {
      const c = useContext(ContainerContext);
      useEffect(() => {
        if (c) frame = c;
      });
      return null;
    }
    const row = (
      <ChartRow height={100}>
        <YAxis id="a" min={0} max={4} label="" />
        <Layers>
          <BarChart categories={categories} id="cap" />
        </Layers>
      </ChartRow>
    );
    const tree = (mounted: boolean) => (
      <ChartContainer width={300}>
        {mounted ? (
          <Selector enabled={false} selected={[mk('alpha', 3)]}>
            {row}
          </Selector>
        ) : (
          row
        )}
        <Probe />
      </ChartContainer>
    );
    try {
      const { rerender } = render(tree(true));
      expect(frame!.selected).toHaveLength(1);
      rerender(tree(false));
      // Uncontrolled again the moment the owner leaves — not one frame later.
      expect(frame!.selected).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it('survives StrictMode double-invocation without losing its owner', () => {
    // StrictMode mounts, tears down, and remounts effects. With layout
    // register + passive unregister that sequence could leave the Map holding
    // a dead entry ahead of the live one, and "first registered wins" would
    // hand out the stale value.
    const stub = stubCanvasContext();
    let frame: ContainerFrame | null = null;
    function Probe() {
      const c = useContext(ContainerContext);
      useEffect(() => {
        if (c) frame = c;
      });
      return null;
    }
    try {
      render(
        <StrictMode>
          <ChartContainer width={300}>
            <Selector enabled={false} selected={[mk('alpha', 3)]}>
              <ChartRow height={100}>
                <YAxis id="a" min={0} max={4} label="" />
                <Layers>
                  <BarChart categories={categories} id="cap" />
                </Layers>
              </ChartRow>
            </Selector>
            <Probe />
          </ChartContainer>
        </StrictMode>,
      );
    } finally {
      stub.restore();
    }
    expect(frame!.selected).toHaveLength(1);
    expect(frame!.selected[0]!.mark).toBe('alpha');
  });
});
