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

// The version is an opaque change token — assert that it *changes*, not its
// absolute value (the subscribe-time bump that closes the render-before-
// subscribe gap means the initial committed value is not 0).
describe('useLiveVersion', () => {
  it('changes on each source append (throttle 0)', () => {
    const { live, view } = makeView();
    const { result } = renderHook(() => useLiveVersion(view, { throttle: 0 }));
    const v0 = result.current;
    act(() => {
      live.push([1000, 1, 'a']);
    });
    const v1 = result.current;
    expect(v1).not.toBe(v0);
    act(() => {
      live.push([1001, 2, 'a']);
    });
    expect(result.current).not.toBe(v1);
  });

  it('updates on clear() / eviction, not only append', () => {
    const { live, view } = makeView();
    live.push([1000, 1, 'a']); // something to evict (pre-mount)
    const { result } = renderHook(() => useLiveVersion(view, { throttle: 0 }));
    const before = result.current;
    act(() => {
      live.clear(); // emits 'evict', no 'event'
    });
    expect(result.current).not.toBe(before);
  });

  it('throttles React notifications but coalesces the immediate bumps', () => {
    vi.useFakeTimers();
    try {
      const { live, view } = makeView();
      const { result } = renderHook(() =>
        useLiveVersion(view, { throttle: 200 }),
      );
      const before = result.current;

      // Three appends inside one window — React not yet notified.
      act(() => {
        live.push([1000, 1, 'a']);
        live.push([1001, 2, 'a']);
        live.push([1002, 3, 'a']);
      });
      expect(result.current).toBe(before);

      // After the window, a single notification reflecting all three.
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is stable across renders with no source change', () => {
    const { view } = makeView();
    const { result, rerender } = renderHook(() =>
      useLiveVersion(view, { throttle: 0 }),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('stops updating after unmount', () => {
    const { live, view } = makeView();
    const { result, unmount } = renderHook(() =>
      useLiveVersion(view, { throttle: 0 }),
    );
    act(() => {
      live.push([1000, 1, 'a']);
    });
    const afterPush = result.current;
    unmount();
    act(() => {
      live.push([1001, 2, 'a']);
    });
    expect(result.current).toBe(afterPush);
  });
});
