import { describe, expect, it } from 'vitest';

import { Event } from '../../src/core/event.js';
import { Time } from '../../src/core/time.js';
import {
  EventArrayLiveStorage,
  type LiveStorage,
} from '../../src/live/live-storage.js';
import type { EventForSchema, SeriesSchema } from '../../src/schema/index.js';

/* -------------------------------------------------------------------------- */
/* Conformance suite — shared LiveStorage contract                             */
/*                                                                             */
/* This suite exercises the LiveStorage interface contract independent of the  */
/* concrete backing. PR-2a runs it against EventArrayLiveStorage; PR-2b adds   */
/* a RingLiveStorage factory to the same `backings` table so both backings     */
/* prove the identical contract.                                               */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

type S = typeof SCHEMA;

function ev(ms: number, value: number): EventForSchema<S> {
  return new Event(new Time(ms), { value }) as unknown as EventForSchema<S>;
}

interface Backing {
  name: string;
  make(schema: SeriesSchema): LiveStorage<SeriesSchema>;
  /** Does this backing support sorted mid-stream insertion (reorder)? */
  supportsSortedInsert: boolean;
}

const backings: Backing[] = [
  {
    name: 'EventArrayLiveStorage',
    make: (schema) => new EventArrayLiveStorage(schema),
    supportsSortedInsert: true,
  },
  // PR-2b appends a RingLiveStorage entry here.
];

for (const backing of backings) {
  describe(`LiveStorage conformance — ${backing.name}`, () => {
    const make = () => backing.make(SCHEMA) as LiveStorage<S>;

    it('starts empty', () => {
      const s = make();
      expect(s.length).toBe(0);
      expect(s.at(0)).toBeUndefined();
      expect(s.last()).toBeUndefined();
      expect(s.keyAt(0)).toBeUndefined();
      expect(s.beginAt(0)).toBeUndefined();
    });

    it('appendTrusted grows the buffer in order', () => {
      const s = make();
      s.appendTrusted(ev(1000, 10));
      s.appendTrusted(ev(2000, 20));
      s.appendTrusted(ev(3000, 30));
      expect(s.length).toBe(3);
      expect(s.at(0)!.get('value')).toBe(10);
      expect(s.at(2)!.get('value')).toBe(30);
      expect(s.last()!.get('value')).toBe(30);
    });

    it('beginAt / keyAt read positionally without mutation', () => {
      const s = make();
      s.appendTrusted(ev(1000, 10));
      s.appendTrusted(ev(2000, 20));
      expect(s.beginAt(0)).toBe(1000);
      expect(s.beginAt(1)).toBe(2000);
      expect(s.keyAt(0)!.equals(ev(1000, 0).key())).toBe(true);
      expect(s.length).toBe(2);
    });

    it('at() returns undefined for out-of-range indices', () => {
      const s = make();
      s.appendTrusted(ev(1000, 10));
      expect(s.at(-1)).toBeUndefined(); // caller normalizes negatives; storage sees raw
      expect(s.at(1)).toBeUndefined();
      expect(s.at(99)).toBeUndefined();
    });

    it('evictPrefix drops the oldest n and returns them', () => {
      const s = make();
      for (let i = 1; i <= 5; i += 1) s.appendTrusted(ev(i * 1000, i * 10));
      const evicted = s.evictPrefix(2);
      expect(evicted.map((e) => e.get('value'))).toEqual([10, 20]);
      expect(s.length).toBe(3);
      expect(s.at(0)!.get('value')).toBe(30);
      expect(s.last()!.get('value')).toBe(50);
    });

    it('evictPrefix(0) is a no-op', () => {
      const s = make();
      s.appendTrusted(ev(1000, 10));
      expect(s.evictPrefix(0)).toEqual([]);
      expect(s.length).toBe(1);
    });

    it('clear empties the buffer and returns everything', () => {
      const s = make();
      s.appendTrusted(ev(1000, 10));
      s.appendTrusted(ev(2000, 20));
      const cleared = s.clear();
      expect(cleared.map((e) => e.get('value'))).toEqual([10, 20]);
      expect(s.length).toBe(0);
      expect(s.at(0)).toBeUndefined();
    });

    it('snapshot produces an independent TimeSeries', () => {
      const s = make();
      s.appendTrusted(ev(1000, 10));
      s.appendTrusted(ev(2000, 20));
      const ts = s.snapshot('snap');
      expect(ts.name).toBe('snap');
      expect(ts.length).toBe(2);
      expect(ts.at(0)!.get('value')).toBe(10);
      // Mutating the storage after snapshot must not affect the snapshot.
      s.appendTrusted(ev(3000, 30));
      expect(ts.length).toBe(2);
    });

    it('snapshot of an empty buffer is an empty TimeSeries', () => {
      const s = make();
      const ts = s.snapshot('empty');
      expect(ts.length).toBe(0);
    });

    if (backing.supportsSortedInsert) {
      it('insertSortedTrusted places an event at its sorted position', () => {
        const s = make();
        s.appendTrusted(ev(1000, 10));
        s.appendTrusted(ev(3000, 30));
        s.insertSortedTrusted(ev(2000, 20));
        expect(s.length).toBe(3);
        expect(s.beginAt(0)).toBe(1000);
        expect(s.beginAt(1)).toBe(2000);
        expect(s.beginAt(2)).toBe(3000);
      });

      it('insertSortedTrusted at the front', () => {
        const s = make();
        s.appendTrusted(ev(2000, 20));
        s.appendTrusted(ev(3000, 30));
        s.insertSortedTrusted(ev(1000, 10));
        expect(s.beginAt(0)).toBe(1000);
        expect(s.length).toBe(3);
      });
    }
  });
}
