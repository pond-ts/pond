import { TimeSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import type { StudyDescriptor } from '../src/catalog/index.js';

/*
 * The fixture and descriptor-reading helpers shared by the catalog's two
 * guards: `catalog.test.ts` (descriptor against its study) and
 * `catalog-process.test.ts` (descriptor against `@pond-ts/process`).
 */

// A deterministic 120-bar OHLCV fixture with a session-id column stepping
// every 20 bars (for the session-anchored studies' column door).
export const schema = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
  { name: 'sess', kind: 'number' },
] as const;

export function fixture(): TimeSeries<typeof schema> {
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const rows: Array<[number, number, number, number, number, number, number]> =
    [];
  let close = 100;
  for (let i = 0; i < 120; i += 1) {
    const open = close;
    close = Math.max(1, open + (next() - 0.5) * 4);
    const high = Math.max(open, close) + next() * 2;
    const low = Math.min(open, close) - next() * 2;
    const volume = Math.round(1000 + next() * 9000);
    rows.push([i * 60_000, open, high, low, close, volume, Math.floor(i / 20)]);
  }
  return new TimeSeries({ name: 'bars', schema, rows });
}

export const bars = fixture() as unknown as TimeSeries<SeriesSchema>;

export function columnNames(s: TimeSeries<SeriesSchema>): string[] {
  return (s.schema as ReadonlyArray<{ name: string }>).map((c) => c.name);
}

export function columnValues(
  s: TimeSeries<SeriesSchema>,
  name: string,
): Array<number | undefined> {
  return (
    s as unknown as {
      events: ReadonlyArray<{ data(): Record<string, unknown> }>;
    }
  ).events.map((e) => {
    const v = e.data()[name];
    return typeof v === 'number' ? v : undefined;
  });
}

/** The smallest options that make the study runnable: required things only. */
export function minimalOptions(d: StudyDescriptor): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const input of d.inputs) {
    // A required column (a `benchmark`) must differ from the defaulted
    // source: `correlation` rejects a column correlated with itself.
    if (input.default === undefined) o[input.role] = 'open';
  }
  for (const [name, p] of Object.entries(d.params)) {
    // An `optional` param is left out: absent is the behaviour described.
    if (p.default === undefined && p.optional === undefined) {
      o[name] = p.example;
    }
  }
  if (d.anchor === 'session') o['session'] = 'sess';
  // The fixture's tenth bar, so the anchored line has bars on both sides.
  if (d.anchor === 'time') o['anchor'] = 10 * 60_000;
  return o;
}

/** Every default stated explicitly, on top of the minimal options. */
export function explicitOptions(d: StudyDescriptor): Record<string, unknown> {
  const o = minimalOptions(d);
  for (const input of d.inputs) {
    if (input.default !== undefined) o[input.role] = input.default;
  }
  for (const [name, p] of Object.entries(d.params)) {
    // A param that `requires` an option left out of the minimal set is
    // left out too: its default is only meaningful alongside that option.
    if (p.requires !== undefined && !(p.requires in o)) continue;
    if (p.default !== undefined) o[name] = p.default;
  }
  o[d.naming.kind] = d.naming.default;
  return o;
}

export function expectedColumns(d: StudyDescriptor): string[] {
  return d.naming.kind === 'output'
    ? [d.naming.default]
    : d.outputs.map((out) => `${d.naming.default}${out.id}`);
}
