import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { LiveSeries } from 'pond-ts';
import { useLiveVersion } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeView() {
  const live = new LiveSeries({ name: 's', schema, ordering: 'strict' });
  return { live, view: live.window(100) };
}

describe('useLiveVersion', () => {
  it('starts at 0 and bumps per source event with throttle 0', () => {
    const { live, view } = makeView();
    const { result } = renderHook(() => useLiveVersion(view, { throttle: 0 }));
    expect(result.current).toBe(0);

    act(() => {
      live.push([1000, 1, 'a']);
    });
    expect(result.current).toBe(1);

    act(() => {
      live.push([1001, 2, 'a']);
    });
    expect(result.current).toBe(2);
  });

  it('throttles React notifications but bumps immediately under the hood', () => {
    vi.useFakeTimers();
    try {
      const { live, view } = makeView();
      const { result } = renderHook(() =>
        useLiveVersion(view, { throttle: 200 }),
      );
      expect(result.current).toBe(0);

      // Three events inside one throttle window — React not yet notified.
      act(() => {
        live.push([1000, 1, 'a']);
        live.push([1001, 2, 'a']);
        live.push([1002, 3, 'a']);
      });
      expect(result.current).toBe(0);

      // After the window, React sees the LATEST version (3), not 1.
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stable reference signal across renders with no events', () => {
    const { view } = makeView();
    const { result, rerender } = renderHook(() =>
      useLiveVersion(view, { throttle: 0 }),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('unsubscribes from the source on unmount', () => {
    const { live, view } = makeView();
    const { result, unmount } = renderHook(() =>
      useLiveVersion(view, { throttle: 0 }),
    );
    act(() => {
      live.push([1000, 1, 'a']);
    });
    expect(result.current).toBe(1);
    unmount();
    // No throw / no update after unmount.
    act(() => {
      live.push([1001, 2, 'a']);
    });
    expect(result.current).toBe(1);
  });
});
