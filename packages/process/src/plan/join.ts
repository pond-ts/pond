/**
 * The join node — [PND-PROCJOIN].
 *
 * "One graph per binding" cannot hold a spec whose inputs come from two
 * sources — a spread, a ratio, a beta against a benchmark — so the
 * combination used to happen by hand, outside the plan, with no id, no
 * cache and no `explain`. And the obvious hand-roll is **wrong**: two
 * instruments do not share a time base (halts, holidays, venues), so
 * pairing row `i` with row `i` silently pairs different dates and
 * returns plausible numbers.
 *
 * A joined binding is n sources → **one join node** → one aligned
 * series, whose columns are qualified `SOURCE:column`. Everything above
 * the join is the ordinary single-series graph, so a cross-source spec
 * resolves, caches and explains like any other.
 *
 * ## The alignment policy is in the id, and has no default
 *
 * Inner and as-of give different answers on the same data, so the policy
 * is part of the join's identity — `p1:join(AAPL+MSFT;how=inner)` — and a
 * caller must name it. A library that picked one would silently pick
 * wrong for somebody.
 *
 * - **`inner`** keeps the timestamps every source has. A timestamp that
 *   repeats within a source has no single partner, so it is rejected
 *   rather than resolved by a rule nobody asked for.
 * - **`asof`** keeps every row of `base` and, for each other source,
 *   takes the latest row at or before that timestamp — before a source's
 *   first row its cells are missing. Row-wise, like pandas'
 *   `merge_asof`: a missing cell in the matched row stays missing rather
 *   than reaching further back.
 *
 * ## Binding keys are host names, never data identities
 *
 * `AAPL:close` names the **binding**, which a caller may equally call
 * `primary:close` and resolve per invocation (Tidal's late-bound roles,
 * `docs/notes/tidal-process-consumer-positions-2026-08.md` §6). The plan
 * keys on the role; the data behind it is the binding's business.
 */

import { ProcessError } from '../errors.js';
import { TimeSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import { esc } from './identity.js';

/** How a joined binding aligns its sources. Required — see the module doc. */
export type JoinPolicy =
  | { readonly how: 'inner' }
  | { readonly how: 'asof'; readonly base: string };

/** What a joined graph reports about its join. */
export interface JoinInfo {
  /** Content-addressed, policy included — `p1:join(AAPL+MSFT;how=inner)`. */
  readonly id: string;
  readonly policy: JoinPolicy;
  /** Binding keys, sorted. */
  readonly sources: readonly string[];
}

/** Separates a binding key from a column in a joined graph's column names. */
export const SOURCE_SEPARATOR = ':';

/** Validates a joined binding's shape before anything is built. */
export function checkJoin(
  sources: Readonly<Record<string, TimeSeries<SeriesSchema>>>,
  policy: JoinPolicy,
): void {
  const keys = Object.keys(sources);
  if (keys.length === 0) {
    throw new ProcessError('a joined binding needs at least one source');
  }
  for (const key of keys) {
    if (key === '' || key.includes(SOURCE_SEPARATOR)) {
      throw new ProcessError(
        `binding key '${key}' must be non-empty and contain no '${SOURCE_SEPARATOR}' — columns are named '<key>${SOURCE_SEPARATOR}<column>'`,
      );
    }
    checkSource(key, sources[key]!);
  }
  const how = (policy as { how?: unknown } | undefined)?.how;
  if (how !== 'inner' && how !== 'asof') {
    throw new ProcessError(
      `join needs an explicit policy, 'inner' or 'asof' — got ${JSON.stringify(how)}; they give different answers, so there is no default`,
    );
  }
  if (policy.how === 'asof' && !keys.includes(policy.base)) {
    throw new ProcessError(
      `as-of join base '${String(policy.base)}' is not a source — sources are ${keys.map((k) => `'${k}'`).join(', ')}`,
    );
  }
}

/** One source's shape: time-keyed, number or string value columns. */
export function checkSource(
  key: string,
  series: TimeSeries<SeriesSchema>,
): void {
  const [keyDef, ...values] = series.schema;
  if (keyDef?.kind !== 'time') {
    throw new ProcessError(
      `source '${key}' is keyed by '${keyDef?.kind}' — a join aligns on timestamps, so every source must be 'time'-keyed`,
    );
  }
  for (const c of values) {
    if (c.kind !== 'number' && c.kind !== 'string') {
      throw new ProcessError(
        `source '${key}' column '${c.name}' is '${c.kind}' — a joined binding carries number and string columns only`,
      );
    }
  }
}

/** The join's id. Sources are sorted, so record key order does not matter. */
export function joinId(sources: readonly string[], policy: JoinPolicy): string {
  const names = [...sources]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(esc)
    .join('+');
  const params =
    policy.how === 'asof' ? `base=${esc(policy.base)},how=asof` : 'how=inner';
  return `p1:join(${names};${params})`;
}

function keysOf(series: TimeSeries<SeriesSchema>): Float64Array {
  const kc = series.keyColumn() as unknown as {
    at(i: number): number;
    begin?: unknown;
  };
  // A time key column's own buffer, read-only here — copying it was most
  // of what aligning cost.
  if (kc.begin instanceof Float64Array && kc.begin.length === series.length) {
    return kc.begin;
  }
  const out = new Float64Array(series.length);
  for (let i = 0; i < out.length; i += 1) out[i] = kc.at(i);
  return out;
}

/** The aligned result: keys, plus one row index per source (`-1` = none). */
export interface Alignment {
  readonly keys: Float64Array;
  readonly rows: ReadonlyMap<string, Int32Array>;
}

/**
 * Aligns sources onto one time base. `O(Σ rows)` — every source is
 * already sorted by key, so both policies are a pointer walk.
 */
export function align(
  sources: ReadonlyMap<string, TimeSeries<SeriesSchema>>,
  policy: JoinPolicy,
): Alignment {
  const names = [...sources.keys()];
  const keyed = new Map(names.map((n) => [n, keysOf(sources.get(n)!)]));

  if (policy.how === 'asof') {
    const base = keyed.get(policy.base)!;
    const rows = new Map<string, Int32Array>();
    for (const name of names) {
      const ks = keyed.get(name)!;
      const out = new Int32Array(base.length);
      if (name === policy.base) {
        for (let i = 0; i < out.length; i += 1) out[i] = i;
      } else {
        let j = -1;
        for (let i = 0; i < base.length; i += 1) {
          while (j + 1 < ks.length && ks[j + 1]! <= base[i]!) j += 1;
          out[i] = j;
        }
      }
      rows.set(name, out);
    }
    return { keys: base, rows };
  }

  for (const name of names) {
    const ks = keyed.get(name)!;
    for (let i = 1; i < ks.length; i += 1) {
      if (ks[i] === ks[i - 1]) {
        throw new ProcessError(
          `source '${name}' repeats timestamp ${new Date(ks[i]!).toISOString()} — an inner join has no single partner for it`,
        );
      }
    }
  }
  // k-way intersection: advance every pointer to the largest current key
  // until they agree.
  const at = names.map(() => 0);
  const lists = names.map((n) => keyed.get(n)!);
  const keys: number[] = [];
  const picks: number[][] = names.map(() => []);
  outer: for (;;) {
    let hi = -Infinity;
    for (let s = 0; s < lists.length; s += 1) {
      if (at[s]! >= lists[s]!.length) break outer;
      hi = Math.max(hi, lists[s]![at[s]!]!);
    }
    let agree = true;
    for (let s = 0; s < lists.length; s += 1) {
      while (at[s]! < lists[s]!.length && lists[s]![at[s]!]! < hi) at[s]! += 1;
      if (at[s]! >= lists[s]!.length) break outer;
      if (lists[s]![at[s]!] !== hi) agree = false;
    }
    if (!agree) continue;
    keys.push(hi);
    for (let s = 0; s < lists.length; s += 1) {
      picks[s]!.push(at[s]!);
      at[s]! += 1;
    }
  }
  return {
    keys: Float64Array.from(keys),
    rows: new Map(names.map((n, s) => [n, Int32Array.from(picks[s]!)])),
  };
}

/** `true` when two key bases are identical, cell for cell. */
export function sameKeys(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Builds the aligned series: one `SOURCE:column` per source column. */
export function assembleJoined(
  sources: ReadonlyMap<string, TimeSeries<SeriesSchema>>,
  alignment: Alignment,
  name: string,
): TimeSeries<SeriesSchema> {
  const schema: { name: string; kind: string }[] = [
    { name: 'time', kind: 'time' },
  ];
  const columns: Record<string, unknown> = { time: alignment.keys };
  const n = alignment.keys.length;
  for (const [source, series] of sources) {
    const rows = alignment.rows.get(source)!;
    for (const def of series.schema.slice(1)) {
      const qualified = `${source}${SOURCE_SEPARATOR}${def.name}`;
      const col = series.column(def.name as never) as unknown as {
        at(i: number): unknown;
        toFloat64Array?: () => Float64Array;
      };
      if (def.kind === 'number') {
        const src = col.toFloat64Array!();
        const out = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
          const r = rows[i]!;
          out[i] = r < 0 ? NaN : src[r]!;
        }
        columns[qualified] = out;
      } else {
        const out = new Array<unknown>(n);
        for (let i = 0; i < n; i += 1) {
          const r = rows[i]!;
          out[i] = r < 0 ? undefined : col.at(r);
        }
        columns[qualified] = out;
      }
      schema.push({ name: qualified, kind: def.kind });
    }
  }
  return TimeSeries.fromColumns({
    name,
    schema: schema as never,
    columns: columns as never,
  }) as unknown as TimeSeries<SeriesSchema>;
}
