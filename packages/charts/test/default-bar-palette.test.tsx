/**
 * The **bar interaction-state palette** on `defaultTheme`, and the drag band
 * that goes with it.
 *
 * Two things are pinned here, and the reason each is pinned differs:
 *
 * 1. **The palette values themselves.** `defaultTheme.bar.default` was the
 *    one part of the default theme nothing asserted — every bar test and every
 *    bar story themes off `docsTheme`, `estelaTheme`, or a locally-built
 *    override, so the values a consumer who passes *no* theme actually gets
 *    were unpinned. The palette's whole claim is a *semantic* one (rest is
 *    teal, selection is blue, hover is a brighter teal and deliberately not
 *    blue), and a claim that nothing asserts is a claim that drifts.
 * 2. **That the states resolve through the draw path**, not just that the
 *    theme object holds the right strings — including `emphasisOpacity`,
 *    which the palette relies on being `1` by default rather than setting.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { defaultTheme } from '../src/theme.js';
import { renderBrushBand } from '../src/brush.js';
import type { ChartTheme } from '../src/theme.js';
import type { ResolvedCursorFrame } from '../src/context.js';

describe('defaultTheme.bar.default — the interaction-state palette', () => {
  const bar = defaultTheme.bar.default;

  it('encodes state as a hue difference: teal at rest, blue when selected', () => {
    // The semantic shift this palette exists for. Before it, `fill` and
    // `highlight` were two shades of one blue, so a selection read as "the
    // same bar, slightly darker" rather than as a different state.
    expect(bar.fill).toBe('#2A9D8F');
    expect(bar.highlight).toBe('#3F5BE0');
  });

  it('rests at full opacity — the emphasis is carried in hue, not alpha', () => {
    expect(bar.opacity).toBe(1);
  });

  it('hovers to a brighter TEAL — blue stays reserved for committed selection', () => {
    expect(bar.hover).toBe('#3FBFAE');
    // The load-bearing half of the rule: hover must not be the selection hue.
    expect(bar.hover).not.toBe(bar.highlight);
  });

  it('dims to the resting teal at 0.32 alpha', () => {
    expect(bar.dimmed).toBe('rgba(42,157,143,0.32)');
  });

  it('leaves emphasisOpacity unset, taking the `1` default rather than pinning it', () => {
    // "Selected: always full opacity" is already what `?? 1` gives, so the
    // palette adds nothing here. Verified rather than assumed — if the
    // fallback ever moved off 1, a resting opacity of 1 would mean a selected
    // bar got *fainter* than a resting one.
    expect(bar.emphasisOpacity).toBeUndefined();
  });

  it('starts its threshold ladder on the bar’s own teal, not the old blue', () => {
    // `bands[0]` is the in-range band — it has to be the resting fill, or a
    // bar under its first threshold changes colour for no reason.
    expect(bar.bands?.[0]).toBe(bar.fill);
    expect(bar.bands).toEqual(['#2A9D8F', '#e8a13c', '#d64545']);
  });

  it('leaves `secondary` on the warm accent — the palette is the default role only', () => {
    expect(defaultTheme.bar.secondary!.fill).toBe('#e8836b');
  });
});

// ── the drag band ───────────────────────────────────────────────────────────

/** The minimum `ResolvedCursorFrame` `renderBrushBand` reads. `dragging`
 *  defaults to true — the band's edged form is the one a theme is describing,
 *  and the resting form is the deliberate exception each caller opts into. */
function frame(
  theme: ChartTheme,
  band: { x0: number; x1: number } | null,
  dragging = true,
) {
  return {
    bandDragging: dragging,
    cursorX: 40,
    cursorY: null,
    rowKey: null,
    hoveredRowKey: null,
    samples: [],
    flags: [],
    pointer: null,
    band,
    bandLine: false,
    formattedTime: null,
    plotWidth: 200,
    rowHeight: 100,
    isFirstRow: true,
    theme,
    xAxis: null,
  } satisfies ResolvedCursorFrame;
}

describe('theme.brush — the drag band routes through the theme', () => {
  it('paints defaultTheme’s band in the SELECTION blue at 7%, with 1px edges', () => {
    // The coherence the palette asks for: a live sweep is a selection being
    // made, so the band is the selection hue — not the resting teal, and not
    // the neutral cursor ink it used to be.
    const { container } = render(
      <svg>{renderBrushBand(frame(defaultTheme, { x0: 20, x1: 80 }))}</svg>,
    );
    const rect = container.querySelector('rect')!;
    expect(rect.getAttribute('fill')).toBe('rgba(63,91,224,0.07)');
    // The alpha is baked into the colour, so the element is fully opaque —
    // otherwise 7% would be multiplied by the legacy 0.12 and vanish.
    expect(rect.getAttribute('opacity')).toBe('1');

    const edges = Array.from(container.querySelectorAll('line'));
    expect(edges).toHaveLength(2);
    expect(edges.map((l) => l.getAttribute('x1'))).toEqual(['20', '80']);
    for (const l of edges) {
      expect(l.getAttribute('stroke')).toBe('rgba(63,91,224,0.45)');
      expect(l.getAttribute('stroke-width')).toBe('1');
    }
  });

  it('falls back to the pre-token look when a theme sets no `brush`', () => {
    // Back-compat by construction: a hand-built theme's band must not shift.
    const { brush: _dropped, ...noBrush } = defaultTheme;
    const { container } = render(
      <svg>{renderBrushBand(frame(noBrush, { x0: 20, x1: 80 }))}</svg>,
    );
    const rect = container.querySelector('rect')!;
    expect(rect.getAttribute('fill')).toBe(defaultTheme.cursor);
    expect(rect.getAttribute('opacity')).toBe('0.12');
    // …and no edges, which is what it drew before the token existed.
    expect(container.querySelectorAll('line')).toHaveLength(0);
  });

  it('draws no edges with no band, however the theme is set', () => {
    const { container } = render(
      <svg>{renderBrushBand(frame(defaultTheme, null))}</svg>,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(container.querySelectorAll('line')).toHaveLength(0);
  });

  it('a RESTING band is the wash alone — the edges belong to the gesture', () => {
    // The band renders in two states: previewing the block a drag would
    // select, and tracking a drag in flight. The edges are what separate
    // them — they mark a boundary the pointer has actually grabbed, so
    // drawing them at rest would assert a range nobody has made.
    const { container } = render(
      <svg>
        {renderBrushBand(frame(defaultTheme, { x0: 20, x1: 80 }, false))}
      </svg>,
    );
    // The wash still paints, identically — only the edges are withheld.
    const rect = container.querySelector('rect')!;
    expect(rect.getAttribute('fill')).toBe('rgba(63,91,224,0.07)');
    expect(rect.getAttribute('opacity')).toBe('1');
    expect(container.querySelectorAll('line')).toHaveLength(0);
  });
});
