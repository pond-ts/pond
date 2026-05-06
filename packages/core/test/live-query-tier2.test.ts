/**
 * Tier 2 query primitives on `LiveSeries` and `LiveView`. Mirrors
 * the matching `TimeSeries` methods (`find` / `some` / `every` /
 * `includesKey` / `bisect` / `atOrBefore` / `atOrAfter`).
 *
 * These methods are pure parity additions — same shape, same
 * return-type semantics. Tests focus on:
 *   - Empty buffer behavior (sane defaults)
 *   - Predicate / index argument plumbing
 *   - Binary-search edge cases (before, exact, after, between)
 *   - Live mutation: methods reflect the buffer's current state
 *   - LiveView (filtered / windowed) sees the post-process buffer
 */
import { describe, expect, it } from 'vitest';
import { Event, Interval, LiveSeries, Time } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'test', schema });
}

// ── LiveSeries.find / some / every ──────────────────────────────

describe('LiveSeries.find', () => {
  it('returns undefined on an empty buffer', () => {
    expect(makeLive().find(() => true)).toBeUndefined();
  });

  it('returns the first matching event', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 5],
      [3000, 10],
    ]);
    const found = live.find((e) => (e.get('value') as number) >= 5);
    expect(found?.begin()).toBe(2000);
  });

  it('passes the index to the predicate', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
      [3000, 3],
    ]);
    const indices: number[] = [];
    live.find((_, i) => {
      indices.push(i);
      return false;
    });
    expect(indices).toEqual([0, 1, 2]);
  });
});

describe('LiveSeries.some', () => {
  it('returns false on an empty buffer', () => {
    expect(makeLive().some(() => true)).toBe(false);
  });

  it('returns true when any event matches', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 5],
    ]);
    expect(live.some((e) => (e.get('value') as number) > 3)).toBe(true);
  });

  it('returns false when no event matches', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(live.some((e) => (e.get('value') as number) > 10)).toBe(false);
  });
});

describe('LiveSeries.every', () => {
  it('returns true on an empty buffer (vacuously true, matches Array)', () => {
    expect(makeLive().every(() => false)).toBe(true);
  });

  it('returns true when all events match', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 5],
      [2000, 10],
    ]);
    expect(live.every((e) => (e.get('value') as number) > 0)).toBe(true);
  });

  it('returns false when any event fails the predicate', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 5],
      [2000, -1],
    ]);
    expect(live.every((e) => (e.get('value') as number) > 0)).toBe(false);
  });
});

// ── LiveSeries.bisect / includesKey / atOrBefore / atOrAfter ────

describe('LiveSeries.bisect', () => {
  it('returns 0 for an empty buffer', () => {
    expect(makeLive().bisect(new Time(1000))).toBe(0);
  });

  it('returns 0 when the key is before all events', () => {
    const live = makeLive();
    live.pushMany([
      [2000, 1],
      [3000, 2],
    ]);
    expect(live.bisect(new Time(1000))).toBe(0);
  });

  it('returns length when the key is after all events', () => {
    const live = makeLive();
    live.pushMany([
      [2000, 1],
      [3000, 2],
    ]);
    expect(live.bisect(new Time(9999))).toBe(2);
  });

  it('returns the index of the matching key when present', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
      [3000, 3],
    ]);
    expect(live.bisect(new Time(2000))).toBe(1);
  });

  it('returns the insertion point between events', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [3000, 3],
      [5000, 5],
    ]);
    expect(live.bisect(new Time(2000))).toBe(1);
    expect(live.bisect(new Time(4000))).toBe(2);
  });

  it('accepts a numeric timestamp shorthand', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(live.bisect(2000)).toBe(1);
  });
});

describe('LiveSeries.includesKey', () => {
  it('returns false on an empty buffer', () => {
    expect(makeLive().includesKey(new Time(1000))).toBe(false);
  });

  it('returns true for an exact match', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(live.includesKey(new Time(2000))).toBe(true);
  });

  it('returns false for a key between events', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [3000, 3],
    ]);
    expect(live.includesKey(new Time(2000))).toBe(false);
  });

  it('accepts a numeric shorthand', () => {
    const live = makeLive();
    live.push([1000, 1]);
    expect(live.includesKey(1000)).toBe(true);
  });
});

describe('LiveSeries.atOrBefore', () => {
  it('returns undefined on an empty buffer', () => {
    expect(makeLive().atOrBefore(new Time(1000))).toBeUndefined();
  });

  it('returns the exact match when present', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(live.atOrBefore(new Time(2000))?.get('value')).toBe(2);
  });

  it('returns the most recent prior event when no exact match', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [3000, 3],
    ]);
    expect(live.atOrBefore(new Time(2500))?.get('value')).toBe(1);
  });

  it('returns undefined when the key is before all events', () => {
    const live = makeLive();
    live.push([2000, 1]);
    expect(live.atOrBefore(new Time(1000))).toBeUndefined();
  });

  it('returns the last event when the key is after all events', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(live.atOrBefore(new Time(9999))?.get('value')).toBe(2);
  });
});

describe('LiveSeries.atOrAfter', () => {
  it('returns undefined on an empty buffer', () => {
    expect(makeLive().atOrAfter(new Time(1000))).toBeUndefined();
  });

  it('returns the exact match when present', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(live.atOrAfter(new Time(2000))?.get('value')).toBe(2);
  });

  it('returns the next event after the key when no exact match', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [3000, 3],
    ]);
    expect(live.atOrAfter(new Time(2500))?.get('value')).toBe(3);
  });

  it('returns the first event when the key is before all events', () => {
    const live = makeLive();
    live.pushMany([
      [2000, 1],
      [3000, 2],
    ]);
    expect(live.atOrAfter(new Time(1000))?.get('value')).toBe(1);
  });

  it('returns undefined when the key is after all events', () => {
    const live = makeLive();
    live.push([1000, 1]);
    expect(live.atOrAfter(new Time(9999))).toBeUndefined();
  });
});

// ── Live mutation: methods reflect current buffer state ─────────

describe('LiveSeries query methods reflect current buffer', () => {
  it('find / some / every update as events arrive', () => {
    const live = makeLive();
    expect(live.some(() => true)).toBe(false);
    live.push([1000, 5]);
    expect(live.some((e) => (e.get('value') as number) === 5)).toBe(true);
    expect(live.find((e) => (e.get('value') as number) === 5)?.begin()).toBe(
      1000,
    );
  });

  it('bisect / atOrBefore reflect retention evictions', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxEvents: 2 },
    });
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(live.atOrBefore(new Time(1500))?.begin()).toBe(1000);
    live.push([3000, 3]); // evicts 1000
    expect(live.atOrBefore(new Time(1500))).toBeUndefined();
    expect(live.atOrBefore(new Time(2500))?.begin()).toBe(2000);
  });
});

// ── LiveView parity ─────────────────────────────────────────────

describe('LiveView query primitives', () => {
  it('find on a filtered view sees only post-filter events', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 5],
      [3000, 10],
    ]);
    const positive = live.filter((e) => (e.get('value') as number) > 3);
    const found = positive.find(() => true);
    expect(found?.begin()).toBe(2000);
  });

  it('bisect on a windowed view binary-searches the windowed buffer', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
      [3000, 3],
      [4000, 4],
    ]);
    const view = live.window(2); // last 2 events
    expect(view.length).toBe(2);
    expect(view.bisect(new Time(3000))).toBe(0);
    expect(view.bisect(new Time(4000))).toBe(1);
    expect(view.bisect(new Time(2000))).toBe(0); // before view start
  });

  it('atOrBefore on a windowed view honors the window boundary', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
      [3000, 3],
      [4000, 4],
    ]);
    const view = live.window(2);
    // Buffer holds [3000, 4000]. atOrBefore(2500) should return undefined
    // since the view's earliest event is 3000.
    expect(view.atOrBefore(new Time(2500))).toBeUndefined();
    expect(view.atOrBefore(new Time(3500))?.begin()).toBe(3000);
  });

  it('every on a filtered view evaluates over the filtered subset', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 5],
      [3000, 10],
    ]);
    const positive = live.filter((e) => (e.get('value') as number) > 3);
    expect(positive.every((e) => (e.get('value') as number) > 3)).toBe(true);
  });

  it('includesKey on a filtered view returns false when the event was filtered out', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 5],
    ]);
    const positive = live.filter((e) => (e.get('value') as number) > 3);
    expect(positive.includesKey(new Time(1000))).toBe(false); // filtered out
    expect(positive.includesKey(new Time(2000))).toBe(true);
  });
});

// ── Symmetry with TimeSeries ────────────────────────────────────

describe('LiveSeries query parity with TimeSeries', () => {
  it('snapshotting a live buffer to TimeSeries yields identical query results', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
      [3000, 3],
    ]);
    const snap = live.toTimeSeries();
    expect(live.bisect(new Time(2000))).toBe(snap.bisect(new Time(2000)));
    expect(live.includesKey(new Time(2000))).toBe(
      snap.includesKey(new Time(2000)),
    );
    expect(live.atOrBefore(new Time(2500))?.begin()).toBe(
      snap.atOrBefore(new Time(2500))?.begin(),
    );
    expect(live.atOrAfter(new Time(2500))?.begin()).toBe(
      snap.atOrAfter(new Time(2500))?.begin(),
    );
  });
});

// ── Interval-keyed series (Layer 2 gap pin) ─────────────────────

const intervalSchema = [
  { name: 'time', kind: 'interval' },
  { name: 'value', kind: 'number' },
] as const;

describe('LiveSeries query primitives on interval-keyed series', () => {
  it('bisect / includesKey / atOrBefore / atOrAfter work on Interval keys', () => {
    const live = new LiveSeries({ name: 'test', schema: intervalSchema });
    live.pushMany([
      [{ value: 1000, start: 1000, end: 2000 }, 1],
      [{ value: 2000, start: 2000, end: 3000 }, 2],
      [{ value: 3000, start: 3000, end: 4000 }, 3],
    ]);
    const k2 = new Interval({ value: 2000, start: 2000, end: 3000 });
    expect(live.bisect(k2)).toBe(1);
    expect(live.includesKey(k2)).toBe(true);
    expect(live.atOrBefore(k2)?.begin()).toBe(2000);
    expect(live.atOrAfter(k2)?.begin()).toBe(2000);

    // Between events
    const k25 = new Interval({ value: 2500, start: 2500, end: 3500 });
    expect(live.bisect(k25)).toBe(2);
    expect(live.includesKey(k25)).toBe(false);
    expect(live.atOrBefore(k25)?.begin()).toBe(2000);
    expect(live.atOrAfter(k25)?.begin()).toBe(3000);
  });

  it('Codex regression pin: same-span intervals with different values are queryable', () => {
    // Bug Codex caught on PR #125 review: `compareKeys` in
    // LiveSeries used to compare only begin/end, but
    // `Interval.compare` adds a value tie-break. So pushing
    // intervals at the same span but different values left the
    // buffer in arrival order while `bisect` expected value-
    // ascending order — `includesKey` returned false on
    // events that were definitely there.
    //
    // Fix: comparator delegates to `EventKey.compare`, matching
    // the bisect lookup. Pin: pushing [b, a] (same span,
    // descending value) and querying for either still returns
    // both correctly.
    const live = new LiveSeries({ name: 'test', schema: intervalSchema });
    live.pushMany([
      [{ value: 1000, start: 1000, end: 2000 }, 1],
      [{ value: 1500, start: 1000, end: 2000 }, 2], // same span, different value
    ]);
    expect(live.length).toBe(2);
    const ka = new Interval({ value: 1000, start: 1000, end: 2000 });
    const kb = new Interval({ value: 1500, start: 1000, end: 2000 });
    // Both keys must be findable.
    expect(live.includesKey(ka)).toBe(true);
    expect(live.includesKey(kb)).toBe(true);
    // bisect returns the lower-bound — interval with value=1000
    // sorts before value=1500.
    expect(live.bisect(ka)).toBe(0);
    expect(live.bisect(kb)).toBe(1);
  });
});

// ── Same-timestamp duplicates (lower-bound semantics) ───────────

describe('LiveSeries.bisect lower-bound pinning on same-timestamp duplicates', () => {
  it('returns the index of the FIRST event matching the key when duplicates exist', () => {
    // LiveSeries default ordering is 'strict' — out-of-order rejects.
    // Duplicates at the same timestamp ARE accepted (`compareKeys`
    // returns 0, the new event appends after the existing one).
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
      [2000, 99], // dup at 2000
      [3000, 3],
    ]);
    expect(live.length).toBe(4);
    // bisect returns the LOWEST index where the key would be inserted
    // — so for an existing key, that's the index of the FIRST matching
    // event. Mirrors `TimeSeries.bisect`'s lower-bound semantics.
    expect(live.bisect(new Time(2000))).toBe(1);
    // includesKey works regardless of duplicates.
    expect(live.includesKey(new Time(2000))).toBe(true);
    // atOrBefore returns the first match (same as bisect's index).
    expect(live.atOrBefore(new Time(2000))?.get('value')).toBe(2);
    // atOrAfter also returns the first match.
    expect(live.atOrAfter(new Time(2000))?.get('value')).toBe(2);
  });
});

// ── LiveView non-monotonic map (Codex regression pin) ──────────

describe('LiveView re-keying map runtime check', () => {
  it('throws ValidationError on a map that produces non-monotonic keys', () => {
    // Bug Codex caught on PR #125 review: `LiveView.map` accepts
    // any user fn; if the fn rewrites keys non-monotonically, the
    // view appended in source order without re-sort. The four
    // binary-search query primitives then returned wrong answers
    // silently.
    //
    // Fix: append-time check in `#appendChecked` throws a clear
    // `ValidationError` on non-monotonic mapped events. Sane
    // transforms (data-only maps, time-axis shifts that preserve
    // order) still work; only genuine reorderings throw.
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
      [3000, 3],
    ]);
    // Re-keying map that flips relative order: this must throw.
    expect(() =>
      live.map((event) => {
        const t = event.begin();
        // Rewrite t=2000 → t=500 to push the second event before
        // the first in keyspace.
        if (t === 2000) {
          return new Event(new Time(500), event.data() as any) as any;
        }
        return event;
      }),
    ).toThrow(/non-monotonic|older than the previous tail/);
  });

  it('does NOT throw on a key-preserving map (data-only transform)', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(() =>
      live.map((event) => {
        return new Event(event.key(), {
          ...(event.data() as Record<string, unknown>),
          value: ((event.data() as Record<string, number>).value ?? 0) * 2,
        } as any) as any;
      }),
    ).not.toThrow();
  });

  it('does NOT throw on a monotonic time-shifting map', () => {
    const live = makeLive();
    live.pushMany([
      [1000, 1],
      [2000, 2],
    ]);
    expect(() =>
      live.map((event) => {
        // Shift every timestamp by +5000 — preserves order.
        return new Event(
          new Time(event.begin() + 5000),
          event.data() as any,
        ) as any;
      }),
    ).not.toThrow();
  });
});

// ── Reorder-mode insertion ──────────────────────────────────────

describe('LiveSeries query primitives under ordering: reorder', () => {
  it('bisect reflects the post-insertion sorted buffer when late events arrive', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      ordering: 'reorder',
      graceWindow: '10s',
    });
    live.push([1000, 1]);
    live.push([5000, 5]);
    // A late event arrives — under reorder it gets inserted at its
    // sorted position (between 1000 and 5000), not appended.
    live.push([3000, 3]);
    expect(live.length).toBe(3);
    expect(live.at(1)?.begin()).toBe(3000); // sorted position
    // bisect / atOrBefore / atOrAfter all see the post-insertion sort.
    expect(live.bisect(new Time(3000))).toBe(1);
    expect(live.includesKey(new Time(3000))).toBe(true);
    expect(live.atOrBefore(new Time(3500))?.begin()).toBe(3000);
    expect(live.atOrAfter(new Time(2500))?.begin()).toBe(3000);
  });
});
