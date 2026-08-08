import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import * as stories from '../src/CursorsRange.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * The `Cursors/Range` (drag) stories: each must mount without throwing, and
 * the interactive ones are DRIVEN — a drag dispatched at the story's real
 * plot surface — so the story pins the wiring (component → brush recognizer
 * → release), not just the render. Twice this wave a defect sat above a
 * well-tested helper; driving the stories is the net for that.
 */
describe('Cursors/Range stories', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the drag fan-out (one story per knob + the zoom scenario)', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'DragDisabled',
      'DragModifierPanOff',
      'DragModifierWithPan',
      'DragToZoom',
      'DragWithSequence',
      'FreeformDrag',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }

  function pointer(type: string, x: number, buttons: number): Event {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: 40,
      buttons,
    });
  }

  it('DragWithSequence: a drag at the story surface updates the released-span readout', () => {
    const el = (stories.DragWithSequence.render as () => ReactElement)();
    const { container } = render(el);
    const surface = container.querySelector('canvas')!.parentElement!;
    expect(container.textContent).toContain('drag across the plot');
    act(() => surface.dispatchEvent(pointer('pointerdown', 60, 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', 200, 1)));
    act(() => surface.dispatchEvent(pointer('pointerup', 200, 0)));
    expect(container.textContent).toContain('released: [');
  });

  it('DragDisabled: the same drag commits nothing while the OFF switch is off', () => {
    const el = (stories.DragDisabled.render as () => ReactElement)();
    const { container } = render(el);
    const surface = container.querySelector('canvas')!.parentElement!;
    act(() => surface.dispatchEvent(pointer('pointerdown', 60, 1)));
    act(() => surface.dispatchEvent(pointer('pointermove', 200, 1)));
    act(() => surface.dispatchEvent(pointer('pointerup', 200, 0)));
    expect(container.textContent).not.toContain('released: [');
  });

  it('DragToZoom: the release zooms (Reset becomes enabled)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const el = (stories.DragToZoom.render as () => ReactElement)();
      const { container, getByRole } = render(el);
      const surface = container.querySelector('canvas')!.parentElement!;
      const reset = getByRole('button', { name: 'Reset zoom' });
      expect(reset).toHaveProperty('disabled', true);
      act(() => surface.dispatchEvent(pointer('pointerdown', 60, 1)));
      act(() => surface.dispatchEvent(pointer('pointermove', 200, 1)));
      act(() => surface.dispatchEvent(pointer('pointerup', 200, 0)));
      expect(reset).toHaveProperty('disabled', false);
    } finally {
      warn.mockRestore();
    }
  });
});
