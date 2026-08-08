import { useContext, useEffect } from 'react';
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
 * `<Selector>` — click-select as a mounted component (interaction RFC §7 /
 * §7.1 / A1.2 / A2.6 / Q8).
 *
 * Two rules pull in opposite directions, and both have to hold:
 *
 * - **Mounting enables the plot gesture.** With no `<Selector>` mounted a plot
 *   click does nothing — not even the uncontrolled internal highlight it used
 *   to do. That is the deliberate break.
 * - **The state stays on the container.** `selected` / `hovered` are still
 *   container props, so controlled highlighting works with no `<Selector>` at
 *   all — the legend-chip / external-list case A1.2 exists to protect.
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

describe('the state stays on the container (A1.2)', () => {
  it('controlled `selected` still highlights with NO selector mounted', () => {
    // The case A1.2 exists to protect: a legend chip or an external filter
    // list drives the chart, the plot is deliberately inert.
    const sel: SelectInfo = {
      id: 'cap',
      key: 0,
      value: 3,
      color: '#000',
      label: 'alpha',
      mark: 'alpha',
    };
    const { frame } = mount({ selected: sel });
    expect(frame().selected).toHaveLength(1);
    expect(frame().selected[0]!.mark).toBe('alpha');
  });

  it('controlled `hovered` still lights with NO selector mounted', () => {
    const hov: SelectInfo = {
      id: 'cap',
      key: 0,
      value: 2,
      color: '#000',
      label: 'beta',
      mark: 'beta',
    };
    expect(mount({ hovered: hov }).frame().hovered).toHaveLength(1);
  });

  it('a controlled `selected` is not overwritten by a plot click', () => {
    const onSelect = vi.fn();
    const sel: SelectInfo[] = [];
    const { frame, click } = mount(
      { selected: sel },
      <Selector onSelect={onSelect} />,
    );
    click();
    // Reported to the consumer, who owns the next set — the container did not
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
    // Hover is not gated: the highlight is container state, and with nothing
    // mounted there is simply nobody to report to.
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

describe('the deprecation shim', () => {
  it('the container `onSelect` prop still enables and reports the click', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSelect = vi.fn();
    const { frame, click } = mount({ onSelect });
    click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(frame().selected).toHaveLength(1);
    warn.mockRestore();
  });

  it('the container `onHover` prop still reports hover', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onHover = vi.fn();
    const { move } = mount({ onHover });
    move(40);
    expect(onHover).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('dev-warns once, naming <Selector> as the replacement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({ onSelect: () => {}, onHover: () => {} });
    const migration = warn.mock.calls.filter((c) =>
      /deprecated — move/.test(String(c[0])),
    );
    expect(migration).toHaveLength(1);
    expect(String(migration[0]![0])).toMatch(/<Selector/);
    expect(String(migration[0]![0])).toMatch(/onSelect and onHover/);
    warn.mockRestore();
  });

  it('does not warn when neither legacy prop is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({}, <Selector onSelect={() => {}} />);
    expect(
      warn.mock.calls.filter((c) => /deprecated — move/.test(String(c[0]))),
    ).toHaveLength(0);
    warn.mockRestore();
  });

  it('a mounted <Selector> overrides the legacy prop in the same scope', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = vi.fn();
    const mounted = vi.fn();
    const { click } = mount(
      { onSelect: legacy },
      <Selector onSelect={mounted} />,
    );
    click();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the §7.1 dev warning (A2.6)', () => {
  it('fires when a click hits a mark and no <Selector> is mounted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount().click();
    expect(inertWarnings(warn)).toHaveLength(1);
    expect(String(inertWarnings(warn)[0]![0])).toMatch(/<Selector onSelect/);
    warn.mockRestore();
  });

  it('does NOT fire when `selected` is supplied — the endorsed setup', () => {
    // A2.6: after A1.2 the inert-plot signature is *also* the signature of
    // controlled highlighting, and the deprecation window should not spend its
    // loudness on people already doing the right thing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({ selected: null }).click();
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

  it('does NOT fire when the legacy `onSelect` prop is carrying the click', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({ onSelect: () => {} }).click();
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
