import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { LiveSeries } from 'pond-ts';
import { useLatest, useLiveVersion, useSnapshot } from '../src/index.js';

// [PND-HOOKSIGNAL] Mounted on a `LiveSeries`, these hooks must still update
// on every change but must not attach an 'event' / 'batch' listener: on the
// column-native backing any such listener makes every push build one
// `Event` per row, which the hooks never read.

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const make = (maxEvents = 100) =>
  new LiveSeries({ name: 's', schema, retention: { maxEvents } });
const rowListeners = (live: object) =>
  (live as { _rowListenerCount: number })._rowListenerCount;

describe('hooks on a LiveSeries use the payload-free change signal', () => {
  it('useSnapshot updates and attaches no row listener', () => {
    const live = make();
    const { result } = renderHook(() => useSnapshot(live, { throttle: 0 }));
    expect(rowListeners(live)).toBe(0);
    act(() =>
      live.pushMany([
        [1000, 1, 'a'],
        [2000, 2, 'b'],
      ]),
    );
    expect(result.current?.length).toBe(2);
    expect(result.current?.last()?.get('cpu')).toBe(2);
  });

  it('useSnapshot with throttle 0 shows the state the last event saw', () => {
    // The last 'event' fires before retention trims, so the snapshot taken
    // then can hold more rows than maxEvents. The signal fires at the same
    // point, so the snapshot is unchanged by this switch.
    const live = make(2);
    const seen: number[] = [];
    live.on('event', () => seen.push(live.length));
    const { result } = renderHook(() => useSnapshot(live, { throttle: 0 }));
    act(() =>
      live.pushMany([
        [1000, 1, 'a'],
        [2000, 2, 'b'],
        [3000, 3, 'a'],
      ]),
    );
    expect(result.current?.length).toBe(seen[seen.length - 1]);
  });

  it('useLatest updates and attaches no row listener', () => {
    const live = make();
    const { result } = renderHook(() => useLatest(live, { throttle: 0 }));
    expect(rowListeners(live)).toBe(0);
    act(() =>
      live.pushMany([
        [1000, 1, 'a'],
        [2000, 7, 'b'],
      ]),
    );
    expect(result.current?.get('cpu')).toBe(7);
  });

  it('useLiveVersion changes on append, retention eviction and clear, with no row listener', () => {
    const live = make(2);
    const { result } = renderHook(() => useLiveVersion(live, { throttle: 0 }));
    expect(rowListeners(live)).toBe(0);
    let v = result.current;
    act(() => live.pushMany([[1000, 1, 'a']]));
    expect(result.current).not.toBe(v);
    v = result.current;
    act(() =>
      live.pushMany([
        [2000, 2, 'a'],
        [3000, 3, 'a'],
      ]),
    ); // evicts 1
    expect(result.current).not.toBe(v);
    v = result.current;
    act(() => live.clear());
    expect(result.current).not.toBe(v);
  });

  it('falls back to an ordinary listener on a view', () => {
    const live = make();
    const view = live.filter((e) => e.get('cpu') > 1);
    const { result } = renderHook(() => useSnapshot(view, { throttle: 0 }));
    act(() =>
      live.pushMany([
        [1000, 1, 'a'],
        [2000, 2, 'b'],
      ]),
    );
    expect(result.current?.length).toBe(1);
  });
});
