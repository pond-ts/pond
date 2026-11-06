import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeSeries } from '../src/index.js';

// [PND-TRIMCOL] `trim` clips on the key buffers instead of trimming an
// `Event` per row. Each case compares with what the event path gave:
// `Event.trim` per event, then a stable re-sort.

type Kind = 'time' | 'timeRange' | 'interval';
const schema = (kind: Kind) =>
  [
    { name: 'k', kind },
    { name: 'x', kind: 'number', required: false },
    { name: 's', kind: 'string', required: false },
  ] as const;

// Spans of different lengths, so clipping at 25 moves [0, 30] to [25, 30]
// past [20, 26] (now [25, 26]) and the result has to be re-sorted.
const spans: Array<[number, number]> = [
  [0, 30],
  [10, 12],
  [20, 26],
  [24, 40],
  [35, 50],
  [60, 70],
];

function make(kind: Kind) {
  const rows = spans.map(([b, e], i) => [
    kind === 'time' ? b : kind === 'timeRange' ? [b, e] : [`L${i}`, b, e],
    i === 1 ? undefined : i * 1.5,
    `v${i}`,
  ]);
  return new TimeSeries({
    name: 'c',
    schema: schema(kind),
    rows: rows as never,
  }) as TimeSeries<any>;
}

// What the event path gave: `Event.trim` on each event, then a stable
// re-sort by begin then end.
function trimmedByEvents(s: TimeSeries<any>, range: unknown) {
  const out = s.events
    .map((e: any) => e.trim(range))
    .filter((e: any) => e !== undefined);
  out.sort((a: any, b: any) => a.begin() - b.begin() || a.end() - b.end());
  return out.map((e: any) => [
    e.key().constructor.name,
    e.begin(),
    e.end(),
    e.key().value,
    { ...e.data() },
  ]);
}
const describeRows = (s: TimeSeries<any>) =>
  s.events.map((e: any) => [
    e.key().constructor.name,
    e.begin(),
    e.end(),
    e.key().value,
    { ...e.data() },
  ]);

afterEach(() => vi.restoreAllMocks());

describe('trim reads the key buffers [PND-TRIMCOL]', () => {
  for (const kind of ['time', 'timeRange', 'interval'] as const) {
    for (const range of [
      [25, 65],
      [11, 25],
      [-5, 100],
      [41, 55],
      [100, 200],
    ] as const) {
      it(`${kind} key, trim(${JSON.stringify(range)}) matches the event path`, () => {
        const s = make(kind);
        const spy = vi.spyOn(TimeSeries.prototype, 'events', 'get');
        const out = s.trim(range as never);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        expect(describeRows(out)).toEqual(trimmedByEvents(make(kind), range));
      });
    }
  }

  it('re-sorts when clipping breaks the key order', () => {
    const out = make('timeRange').trim([25, 65]);
    expect(out.toJSON().rows.map((r: any) => r[0])).toEqual([
      [25, 26],
      [25, 30],
      [25, 40],
      [35, 50],
      [60, 65],
    ]);
    expect(out.toJSON().rows.map((r: any) => r[2])).toEqual([
      'v2',
      'v0',
      'v3',
      'v4',
      'v5',
    ]);
  });

  it('time keys keep the source key objects; events are new objects', () => {
    const s = make('time');
    const out = s.trim([20, 60]);
    expect(out.length).toBe(4);
    for (let j = 0; j < out.length; j += 1) {
      const src = s.at(j + 2)!;
      expect(out.at(j)).not.toBe(src);
      expect(out.at(j)!.key()).toBe(src.key());
      expect(out.rows[j]![0]).toBe(src.key());
    }
  });

  it('a bad range throws as before on a non-empty series, never on an empty one', () => {
    let oldMessage = '';
    try {
      make('timeRange')
        .at(0)!
        .trim([9, 2] as never);
    } catch (e) {
      oldMessage = (e as Error).message;
    }
    expect(oldMessage).not.toBe('');
    expect(() => make('timeRange').trim([9, 2] as never)).toThrow(oldMessage);
    expect(
      make('time')
        .slice(0, 0)
        .trim([9, 2] as never).length,
    ).toBe(0);
  });
});

describe('long chains of selections stay one step deep', () => {
  const steps: Array<[string, (s: TimeSeries<any>, i: number) => any]> = [
    ['after', (s) => s.after(-1)],
    ['tail', (s) => s.tail('1h')],
    ['dedupe', (s) => s.dedupe()],
    ['trim', (s) => s.trim([-1, 1e9])],
    ['after and trim', (s, i) => (i % 2 ? s.trim([-1, 1e9]) : s.after(-1))],
  ];
  for (const [name, step] of steps) {
    it(`10,000 x ${name}`, () => {
      const src = make('time');
      let s = src;
      for (let i = 0; i < 10_000; i += 1) s = step(s, i);
      expect(s.at(0)!.key()).toBe(src.at(0)!.key());
      expect(s.rows[0]![0]).toBe(src.at(0)!.key());
      if (name !== 'trim' && name !== 'after and trim') {
        expect(s.at(0)).toBe(src.at(0));
      }
    });
  }
});
