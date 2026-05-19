import { describe, it, expect } from 'vitest';
import { LiveSeries } from '../src/live/live-series.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'count', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const optionalSchema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'count', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'test', schema });
}

function makeLiveOptional() {
  return new LiveSeries({ name: 'test', schema: optionalSchema });
}

// ── diff ──────────────────────────────────────────────────────────

describe('LiveSeries.diff', () => {
  it('computes per-event differences for a single column', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a'], [2000, 25, 2, 'b'], [3000, 33, 3, 'c']);
    const d = live.diff('value');
    expect(d.length).toBe(3);
    expect(d.at(0)!.get('value')).toBeUndefined();
    expect(d.at(1)!.get('value')).toBe(15);
    expect(d.at(2)!.get('value')).toBe(8);
  });

  it('preserves non-target columns unchanged', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a'], [2000, 25, 2, 'b']);
    const d = live.diff('value');
    expect(d.at(0)!.get('host')).toBe('a');
    expect(d.at(1)!.get('count')).toBe(2);
    expect(d.at(1)!.get('host')).toBe('b');
  });

  it('supports multiple columns', () => {
    const live = makeLive();
    live.push([1000, 10, 100, 'a'], [2000, 25, 140, 'b']);
    const d = live.diff(['value', 'count']);
    expect(d.at(0)!.get('value')).toBeUndefined();
    expect(d.at(0)!.get('count')).toBeUndefined();
    expect(d.at(1)!.get('value')).toBe(15);
    expect(d.at(1)!.get('count')).toBe(40);
  });

  it('drops first event with drop: true', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a'], [2000, 25, 2, 'b']);
    const d = live.diff('value', { drop: true });
    expect(d.length).toBe(1);
    expect(d.at(0)!.get('value')).toBe(15);
  });

  it('processes new events incrementally', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a']);
    const d = live.diff('value');
    expect(d.length).toBe(1);

    live.push([2000, 25, 2, 'b']);
    expect(d.length).toBe(2);
    expect(d.at(1)!.get('value')).toBe(15);

    live.push([3000, 33, 3, 'c']);
    expect(d.length).toBe(3);
    expect(d.at(2)!.get('value')).toBe(8);
  });

  it('fires event listeners for new diffs', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a']);
    const d = live.diff('value');

    const received: number[] = [];
    d.on('event', (event) => {
      received.push(event.get('value') as number);
    });

    live.push([2000, 25, 2, 'b'], [3000, 33, 3, 'c']);
    expect(received).toEqual([15, 8]);
  });

  it('sets output schema columns to required: false', () => {
    const live = makeLive();
    const d = live.diff('value');
    const valCol = d.schema.find((c) => c.name === 'value')!;
    expect(valCol.kind).toBe('number');
    expect(valCol.required).toBe(false);
    const countCol = d.schema.find((c) => c.name === 'count')!;
    expect(countCol.required).not.toBe(false);
  });

  it('throws for empty columns', () => {
    const live = makeLive();
    expect(() => live.diff([] as any)).toThrow('requires at least one');
  });
});

// ── rate ──────────────────────────────────────────────────────────

describe('LiveSeries.rate', () => {
  it('computes per-second rate of change', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a'], [3000, 30, 2, 'b']);
    const r = live.rate('value');
    expect(r.at(0)!.get('value')).toBeUndefined();
    expect(r.at(1)!.get('value')).toBe(10); // 20 delta / 2 seconds
  });

  it('produces undefined for zero time gap', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a'], [1000, 30, 2, 'b']);
    const r = live.rate('value');
    expect(r.at(1)!.get('value')).toBeUndefined();
  });

  it('supports multiple columns', () => {
    const live = makeLive();
    live.push([0, 0, 0, 'a'], [2000, 10, 100, 'b']);
    const r = live.rate(['value', 'count']);
    expect(r.at(1)!.get('value')).toBe(5); // 10 / 2s
    expect(r.at(1)!.get('count')).toBe(50); // 100 / 2s
  });

  it('works incrementally', () => {
    const live = makeLive();
    live.push([0, 0, 0, 'a']);
    const r = live.rate('value');
    live.push([1000, 5, 1, 'b']);
    expect(r.at(1)!.get('value')).toBe(5); // 5 / 1s
    live.push([2000, 15, 2, 'c']);
    expect(r.at(2)!.get('value')).toBe(10); // 10 / 1s
  });
});

// ── pctChange ────────────────────────────────────────────────────

describe('LiveSeries.pctChange', () => {
  it('computes percentage change (curr - prev) / prev', () => {
    const live = makeLive();
    live.push([1000, 100, 1, 'a'], [2000, 150, 2, 'b']);
    const p = live.pctChange('value');
    expect(p.at(0)!.get('value')).toBeUndefined();
    expect(p.at(1)!.get('value')).toBe(0.5); // 50/100
  });

  it('produces undefined when previous value is zero', () => {
    const live = makeLive();
    live.push([1000, 0, 1, 'a'], [2000, 10, 2, 'b']);
    const p = live.pctChange('value');
    expect(p.at(1)!.get('value')).toBeUndefined();
  });

  it('handles negative changes', () => {
    const live = makeLive();
    live.push([1000, 200, 1, 'a'], [2000, 150, 2, 'b']);
    const p = live.pctChange('value');
    expect(p.at(1)!.get('value')).toBe(-0.25); // -50/200
  });

  it('supports drop option', () => {
    const live = makeLive();
    live.push([1000, 100, 1, 'a'], [2000, 200, 2, 'b']);
    const p = live.pctChange('value', { drop: true });
    expect(p.length).toBe(1);
    expect(p.at(0)!.get('value')).toBe(1.0);
  });
});

// ── fill ─────────────────────────────────────────────────────────

describe('LiveSeries.fill', () => {
  it('hold strategy carries forward last known value', () => {
    const live = makeLiveOptional();
    live.push(
      [1000, 10, 1, 'a'],
      [2000, undefined, 2, 'b'],
      [3000, undefined, 3, 'c'],
    );
    const f = live.fill('hold');
    expect(f.at(0)!.get('value')).toBe(10);
    expect(f.at(1)!.get('value')).toBe(10);
    expect(f.at(2)!.get('value')).toBe(10);
  });

  it('hold does not fill leading undefined (no known value)', () => {
    const live = makeLiveOptional();
    live.push([1000, undefined, 1, 'a'], [2000, 10, 2, 'b']);
    const f = live.fill('hold');
    expect(f.at(0)!.get('value')).toBeUndefined();
    expect(f.at(1)!.get('value')).toBe(10);
  });

  it('zero strategy fills with 0', () => {
    const live = makeLiveOptional();
    live.push([1000, undefined, 1, 'a'], [2000, 10, 2, 'b']);
    const f = live.fill('zero');
    expect(f.at(0)!.get('value')).toBe(0);
    expect(f.at(1)!.get('value')).toBe(10);
  });

  it('per-column mapping with literal values', () => {
    const live = makeLiveOptional();
    live.push([1000, undefined, undefined, undefined]);
    const f = live.fill({ value: 'zero', host: 'unknown' });
    expect(f.at(0)!.get('value')).toBe(0);
    expect(f.at(0)!.get('host')).toBe('unknown');
    expect(f.at(0)!.get('count')).toBeUndefined();
  });

  it('limit caps consecutive fills', () => {
    const live = makeLiveOptional();
    live.push(
      [1000, 10, 1, 'a'],
      [2000, undefined, 2, 'b'],
      [3000, undefined, 3, 'c'],
      [4000, undefined, 4, 'd'],
    );
    const f = live.fill('hold', { limit: 2 });
    expect(f.at(1)!.get('value')).toBe(10);
    expect(f.at(2)!.get('value')).toBe(10);
    expect(f.at(3)!.get('value')).toBeUndefined();
  });

  it('resets consecutive count after defined value', () => {
    const live = makeLiveOptional();
    live.push(
      [1000, 10, 1, 'a'],
      [2000, undefined, 2, 'b'],
      [3000, 20, 3, 'c'],
      [4000, undefined, 4, 'd'],
    );
    const f = live.fill('hold', { limit: 1 });
    expect(f.at(1)!.get('value')).toBe(10);
    expect(f.at(3)!.get('value')).toBe(20);
  });

  it('works incrementally', () => {
    const live = makeLiveOptional();
    live.push([1000, 10, 1, 'a']);
    const f = live.fill('hold');
    live.push([2000, undefined, 2, 'b']);
    expect(f.at(1)!.get('value')).toBe(10);
    live.push([3000, 30, 3, 'c']);
    live.push([4000, undefined, 4, 'd']);
    expect(f.at(3)!.get('value')).toBe(30);
  });

  it('throws on bfill strategy', () => {
    const live = makeLiveOptional();
    expect(() => live.fill('bfill' as any)).toThrow('not supported');
  });

  it('throws on linear strategy', () => {
    const live = makeLiveOptional();
    expect(() => live.fill('linear' as any)).toThrow('not supported');
  });

  it('throws on bfill in per-column mapping', () => {
    const live = makeLiveOptional();
    expect(() => live.fill({ value: 'bfill' } as any)).toThrow('not supported');
  });

  it('returns original event when no fill is needed', () => {
    const live = makeLiveOptional();
    live.push([1000, 10, 1, 'a']);
    const f = live.fill('hold');
    expect(f.at(0)!.get('value')).toBe(10);
    expect(f.at(0)!.get('count')).toBe(1);
  });
});

// ── cumulative ───────────────────────────────────────────────────

describe('LiveSeries.cumulative', () => {
  it('sum accumulates running total', () => {
    const live = makeLive();
    live.push([1000, 5, 1, 'a'], [2000, 3, 2, 'b'], [3000, 7, 3, 'c']);
    const c = live.cumulative({ value: 'sum' });
    expect(c.at(0)!.get('value')).toBe(5);
    expect(c.at(1)!.get('value')).toBe(8);
    expect(c.at(2)!.get('value')).toBe(15);
  });

  it('max tracks running maximum', () => {
    const live = makeLive();
    live.push([1000, 5, 1, 'a'], [2000, 3, 2, 'b'], [3000, 7, 3, 'c']);
    const c = live.cumulative({ value: 'max' });
    expect(c.at(0)!.get('value')).toBe(5);
    expect(c.at(1)!.get('value')).toBe(5);
    expect(c.at(2)!.get('value')).toBe(7);
  });

  it('min tracks running minimum', () => {
    const live = makeLive();
    live.push([1000, 5, 1, 'a'], [2000, 3, 2, 'b'], [3000, 7, 3, 'c']);
    const c = live.cumulative({ value: 'min' });
    expect(c.at(0)!.get('value')).toBe(5);
    expect(c.at(1)!.get('value')).toBe(3);
    expect(c.at(2)!.get('value')).toBe(3);
  });

  it('count increments per event', () => {
    const live = makeLive();
    live.push([1000, 5, 1, 'a'], [2000, 3, 2, 'b'], [3000, 7, 3, 'c']);
    const c = live.cumulative({ value: 'count' });
    expect(c.at(0)!.get('value')).toBe(1);
    expect(c.at(1)!.get('value')).toBe(2);
    expect(c.at(2)!.get('value')).toBe(3);
  });

  it('supports custom accumulator function', () => {
    const live = makeLive();
    live.push([1000, 5, 1, 'a'], [2000, 3, 2, 'b']);
    const c = live.cumulative({ value: (acc, v) => acc * v });
    expect(c.at(0)!.get('value')).toBe(5);
    expect(c.at(1)!.get('value')).toBe(15);
  });

  it('preserves non-target columns', () => {
    const live = makeLive();
    live.push([1000, 5, 1, 'a'], [2000, 3, 2, 'b']);
    const c = live.cumulative({ value: 'sum' });
    expect(c.at(0)!.get('host')).toBe('a');
    expect(c.at(1)!.get('count')).toBe(2);
  });

  it('supports multiple columns', () => {
    const live = makeLive();
    live.push([1000, 5, 10, 'a'], [2000, 3, 20, 'b']);
    const c = live.cumulative({ value: 'sum', count: 'max' });
    expect(c.at(1)!.get('value')).toBe(8);
    expect(c.at(1)!.get('count')).toBe(20);
  });

  it('works incrementally', () => {
    const live = makeLive();
    live.push([1000, 5, 1, 'a']);
    const c = live.cumulative({ value: 'sum' });
    expect(c.at(0)!.get('value')).toBe(5);
    live.push([2000, 3, 2, 'b']);
    expect(c.at(1)!.get('value')).toBe(8);
  });

  it('sets output schema columns to required: false', () => {
    const live = makeLive();
    const c = live.cumulative({ value: 'sum' });
    const valCol = c.schema.find((c) => c.name === 'value')!;
    expect(valCol.required).toBe(false);
    const countCol = c.schema.find((c) => c.name === 'count')!;
    expect(countCol.required).not.toBe(false);
  });

  it('throws for empty spec', () => {
    const live = makeLive();
    expect(() => live.cumulative({} as any)).toThrow('requires at least one');
  });
});

// ── LiveView chaining ────────────────────────────────────────────

describe('LiveView chaining', () => {
  it('diff works on a filtered view', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a'], [2000, 20, 2, 'b'], [3000, 35, 3, 'a']);
    const d = live.filter((e) => e.get('host') === 'a').diff('value');
    expect(d.length).toBe(2);
    expect(d.at(0)!.get('value')).toBeUndefined();
    expect(d.at(1)!.get('value')).toBe(25);
  });

  it('fill works on a diff view', () => {
    const live = makeLive();
    live.push([1000, 10, 1, 'a'], [2000, 25, 2, 'b']);
    const filled = live.diff('value').fill('zero');
    expect(filled.at(0)!.get('value')).toBe(0);
    expect(filled.at(1)!.get('value')).toBe(15);
  });

  it('cumulative works on a windowed view', () => {
    const live = makeLive();
    live.push([1000, 1, 1, 'a'], [2000, 2, 2, 'b'], [3000, 3, 3, 'c']);
    const c = live.window(2).cumulative({ value: 'sum' });
    // Window keeps last 2 events: [2000, 2] and [3000, 3]
    expect(c.length).toBe(2);
    expect(c.at(0)!.get('value')).toBe(2);
    expect(c.at(1)!.get('value')).toBe(5);
  });

  it('rate on a mapped view', () => {
    const live = makeLive();
    live.push([0, 100, 1, 'a'], [2000, 200, 2, 'b']);
    const scaled = live
      .map((e) => e.set('value', (e.get('value') as number) * 2))
      .rate('value');
    // values are 200, 400; delta = 200, dt = 2s, rate = 100
    expect(scaled.at(1)!.get('value')).toBe(100);
  });

  it('multi-stage pipeline: filter → diff → fill', () => {
    const live = makeLive();
    live.push(
      [1000, 10, 1, 'a'],
      [2000, 20, 2, 'b'],
      [3000, 35, 3, 'a'],
      [4000, 40, 4, 'b'],
      [5000, 50, 5, 'a'],
    );
    const pipeline = live
      .filter((e) => e.get('host') === 'a')
      .diff('value')
      .fill('zero');

    // Filtered: [1000,10], [3000,35], [5000,50]
    // Diff: [undefined, 25, 15]
    // Fill zero: [0, 25, 15]
    expect(pipeline.length).toBe(3);
    expect(pipeline.at(0)!.get('value')).toBe(0);
    expect(pipeline.at(1)!.get('value')).toBe(25);
    expect(pipeline.at(2)!.get('value')).toBe(15);
  });

  it('incremental pipeline receives new events', () => {
    const live = makeLive();
    const pipeline = live.diff('value').fill('zero');

    live.push([1000, 10, 1, 'a']);
    expect(pipeline.length).toBe(1);
    expect(pipeline.at(0)!.get('value')).toBe(0);

    live.push([2000, 25, 2, 'b']);
    expect(pipeline.length).toBe(2);
    expect(pipeline.at(1)!.get('value')).toBe(15);
  });
});
