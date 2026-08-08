import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import * as stories from '../src/MultiSelectorComponent.stories.js';
import type { StoryObj } from '@storybook/react-vite';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * Render smoke test for the `<MultiSelector>` stories: each must mount without
 * throwing. The fan-out covers the feature's axes (the systematic-coverage
 * rule): freeform sweep, sequence-snapped sweep, sweep + modifier, the
 * click-is-still-a-click superset, the live preview, A5.2's demote-on-edit
 * worked example, and the category-axis fold-in.
 */
describe('Interactions/MultiSelector stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('covers the sweep, snap, modifier, click, preview, edit and axis-kind axes', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CategorySweep',
      'ClickStillSelectsOne',
      'DemoteOnEdit',
      'LivePreviewDuringDrag',
      'SweepAdditive',
      'SweepBars',
      'SweepWithSequence',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stub = stubCanvasContext();
      try {
        const Render = story.render as () => ReactElement;
        expect(() => render(<Render />)).not.toThrow();
      } finally {
        stub.restore();
        warn.mockRestore();
      }
    });
  }
});

/**
 * The SweepAdditive story's consumer policy, driven end to end — because the
 * worked example is the thing people copy. An earlier revision handled only
 * spans (`span === null` returned `[]`), so a ⌘-click after a sweep — the
 * A5.2 headline gesture, "extend the selection by this bar" — silently threw
 * the whole selection away. The library reported `(hits, modifiers, null)`
 * correctly the entire time; the story's set arithmetic dropped it.
 */
describe('SweepAdditive story — ⌘-click after a sweep extends, not clears', () => {
  const DAY = 86_400_000;
  const D0 = Date.UTC(2026, 6, 1);

  function pointer(
    type: string,
    x: number,
    y: number,
    buttons: number,
    init: PointerEventInit = {},
  ) {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      buttons,
      ...init,
    });
  }

  it('sweep a run, then ⌘-click a bar outside it — both stay selected', () => {
    const story = stories.SweepAdditive as StoryObj;
    const Render = story.render as () => ReactElement;
    const stub = stubCanvasContext();
    let dom: HTMLElement;
    try {
      dom = render(<Render />).container;

      const surface = dom.querySelector('canvas')!.parentElement!;
      const w = Number.parseFloat((surface as HTMLElement).style.width);
      const pxAt = (day: number) => (day / 30) * w;
      const caption = () => dom.querySelector('p')!.textContent!;

      // 1. Sweep days 2..4 → one span entry.
      act(() =>
        surface.dispatchEvent(pointer('pointerdown', pxAt(2.5), 150, 1)),
      );
      act(() =>
        surface.dispatchEvent(pointer('pointermove', pxAt(4.5), 150, 1)),
      );
      act(() => surface.dispatchEvent(pointer('pointerup', pxAt(4.5), 150, 0)));
      expect(caption()).toContain('span [07-03 → 07-06)');

      // 2. ⌘-click bar 25 (a tall bar well outside the span, y inside its
      //    ink) — the span must SURVIVE and the mark join it.
      const cx = pxAt(25.5);
      act(() =>
        surface.dispatchEvent(
          pointer('pointerdown', cx, 150, 1, { metaKey: true }),
        ),
      );
      act(() =>
        surface.dispatchEvent(
          pointer('pointerup', cx, 150, 0, { metaKey: true }),
        ),
      );
      act(() =>
        surface.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: 150,
            metaKey: true,
          }),
        ),
      );
      expect(caption()).toContain('span [07-03 → 07-06), 07-26');

      // 3. A plain click on empty space above the bars clears everything —
      //    the empty-commit deselect path.
      act(() =>
        surface.dispatchEvent(pointer('pointerdown', pxAt(25.5), 5, 1)),
      );
      act(() => surface.dispatchEvent(pointer('pointerup', pxAt(25.5), 5, 0)));
      act(() =>
        surface.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: pxAt(25.5),
            clientY: 5,
          }),
        ),
      );
      expect(caption()).toContain('selected: —');
    } finally {
      stub.restore();
    }
  });
});
