import { createElement, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/AutoHeight.stories.js';
import type { StoryObj } from '@storybook/react-vite';

/**
 * happy-dom has no layout engine, so an auto-sizing story mounts with every
 * measurement at 0 — gated, with **none of its chart content executed**. A
 * bare mount-without-throwing smoke over that proves only that the empty gate
 * renders; a story whose chart is broken (a wrong column name, a bad axis id)
 * passes headless and explodes in the browser. That is not hypothetical: this
 * file's first version did exactly that, and the bug surfaced only in the
 * Storybook pass.
 *
 * So this smoke stubs `getBoundingClientRect` to report a real size for
 * everything — the gates open, the flex rows resolve, and the stories'
 * actual chart content renders headless.
 */
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(
      () => ({ width: 600, height: 300, top: 0, left: 0 }) as DOMRect,
    );
});
afterEach(() => {
  cleanup();
  rectSpy?.mockRestore();
});

describe('Container height stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'FlexRatios',
      'MixedFixedFlex',
      'NumericHeight',
      'ResizablePanels',
      'SingleRowZeroProps',
      'StripChangesHeight',
      'TooShort',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      expect(() =>
        render(createElement(story.render as ComponentType)),
      ).not.toThrow();
    });
  }
});
