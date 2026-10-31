/**
 * Column-wise evaluation of column expressions ([PND-EXPR]) over a
 * columnar store: each operation runs as one loop over whole columns,
 * with no per-row `Event` and no function call per row. Same answers as
 * the per-row `evaluateRow` in `core/expression.ts` (tests check both).
 *
 * Values in flight:
 * - number: `Float64Array`, `NaN` is a gap;
 * - boolean: `Int8Array`, 1 true, 0 false, -1 gap;
 * - string: `(string | undefined)[]`.
 * A literal is spread to a full array; cheap next to the loops (about
 * 1 ms per million rows) and it keeps one loop per operation.
 */
import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  Float64Column,
  StringColumn,
  booleanColumnFromArray,
  stringColumnFromArray,
} from '../../columnar/index.js';
import {
  type CheckedKind,
  type ExprColumn,
  type ExprLiteral,
  type ExprNode,
  type ExprOp,
  checkExpr,
} from '../../core/expression.js';
import {
  float64ColumnFromTypedArray,
  packedNumericSource,
} from './numeric-io.js';

export type ColumnValues =
  | { readonly kind: 'number'; readonly v: Float64Array }
  | { readonly kind: 'boolean'; readonly v: Int8Array }
  | { readonly kind: 'string'; readonly v: (string | undefined)[] };

/**
 * Rows `[start, end)` of `col`, as values in flight. Never marked
 * {@link fresh}, even when copied: one read serves every use of the
 * column in a tree, so no step may write over it.
 */
function readColumn(
  col: Column,
  kind: CheckedKind,
  start: number,
  end: number,
): ColumnValues {
  const n = end - start;
  if (kind === 'number') {
    const packed = packedNumericSource(col);
    if (packed !== null) {
      const raw = packed.values.subarray(start, end);
      if (packed.allFinite) return { kind, v: raw };
      // A gap may be stored as ±Infinity (a column built with
      // `fromColumns` keeps what it was given); in flight every gap is
      // NaN. Copy only when there is an infinity, never write the source.
      let inf = false;
      for (let i = 0; i < n; i += 1) {
        const x = raw[i]!;
        if (x - x !== 0 && x === x) {
          inf = true;
          break;
        }
      }
      if (!inf) return { kind, v: raw };
      const v = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        const x = raw[i]!;
        v[i] = x - x === 0 ? x : NaN;
      }
      return { kind, v };
    }
    const v = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = col.read(start + i);
      v[i] = typeof x === 'number' && x - x === 0 ? x : NaN;
    }
    return { kind, v };
  }
  if (kind === 'boolean') {
    const v = new Int8Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = col.read(start + i);
      v[i] = x === true ? 1 : x === false ? 0 : -1;
    }
    return { kind, v };
  }
  const v = new Array<string | undefined>(n);
  if (col instanceof StringColumn && col.indices !== undefined) {
    const dict = col.dictionary!;
    const idx = col.indices;
    const ok = col.validity;
    for (let i = 0; i < n; i += 1) {
      const r = start + i;
      v[i] = ok === undefined || ok.isDefined(r) ? dict[idx[r]!] : undefined;
    }
    return { kind, v };
  }
  for (let i = 0; i < n; i += 1) {
    const x = col.read(start + i);
    v[i] = typeof x === 'string' ? x : undefined;
  }
  return { kind, v };
}

/**
 * Text test against fixed values on a dictionary-coded column: decide
 * once per dictionary entry, then loop over the codes. `null` when the
 * column is not dictionary-coded.
 */
function dictionaryTest(
  col: Column,
  keep: (s: string) => boolean,
  gap: 0 | 1,
  start: number,
  end: number,
  tables: Map<ExprNode, Int8Array>,
  node: ExprNode,
): Int8Array | null {
  if (!(col instanceof StringColumn) || col.indices === undefined) return null;
  // One table per expression node, kept across the stretches `find` /
  // `some` / `every` evaluate.
  let table = tables.get(node);
  if (table === undefined) {
    const dict = col.dictionary!;
    table = new Int8Array(dict.length);
    for (let k = 0; k < dict.length; k += 1) table[k] = keep(dict[k]!) ? 1 : 0;
    tables.set(node, table);
  }
  const idx = col.indices;
  const ok = col.validity;
  const out = new Int8Array(end - start);
  for (let i = 0; i < out.length; i += 1) {
    const r = start + i;
    out[i] = ok === undefined || ok.isDefined(r) ? table[idx[r]!]! : gap;
  }
  return out;
}

/**
 * Results the evaluator allocated. Nothing else holds them, so a later
 * step may write over one in place (saving a fresh 8 MB per million rows)
 * and a column may take one as is.
 */
const fresh = new WeakSet<Float64Array>();

/** `p` when the evaluator owns it, else a new array. */
const reuse = (p: Float64Array, n: number): Float64Array =>
  fresh.has(p) ? p : new Float64Array(n);

function spread(x: ExprLiteral, n: number): ColumnValues {
  if (typeof x === 'number')
    return { kind: 'number', v: new Float64Array(n).fill(x) };
  if (typeof x === 'boolean')
    return { kind: 'boolean', v: new Int8Array(n).fill(x ? 1 : 0) };
  return { kind: 'string', v: new Array<string | undefined>(n).fill(x) };
}

const isGap = (c: ColumnValues, i: number): boolean =>
  c.kind === 'number'
    ? c.v[i]! !== c.v[i]!
    : c.kind === 'boolean'
      ? c.v[i] === -1
      : c.v[i] === undefined;

/** A value as JavaScript sees it (for text / true-false comparisons). */
const cell = (c: ColumnValues, i: number): unknown =>
  c.kind === 'boolean' ? c.v[i] === 1 : c.v[i];

/**
 * `node` over rows `[start, end)` of the store's value columns, reading
 * only the columns it names. The caller checks it first; this assumes a
 * well-kinded tree. `tables` keeps per-node dictionary tables between
 * calls on the same store.
 */
export function evaluateColumns(
  node: ExprNode,
  store: ColumnarStore<ColumnSchema>,
  kinds: ReadonlyMap<string, CheckedKind>,
  start = 0,
  end = store.length,
  tables = new Map<ExprNode, Int8Array>(),
): ColumnValues {
  const n = end - start;
  const cache = new Map<string, ColumnValues>();
  const walk = (x: ExprNode): ColumnValues => {
    if ('col' in x) {
      let c = cache.get(x.col);
      if (c === undefined) {
        c = readColumn(
          store.columns.get(x.col)!,
          kinds.get(x.col)!,
          start,
          end,
        );
        cache.set(x.col, c);
      }
      return c;
    }
    if ('lit' in x) return spread(x.lit, n);
    const fast = scalarCase(x);
    if (fast !== null) return fast;
    const args = x.args.map(walk);
    const a = args[0]!;
    switch (x.op) {
      case 'gt':
      case 'ge':
      case 'lt':
      case 'le':
      case 'eq':
      case 'ne':
        return compare(x.op, a, args[1]!, n);
      case 'in': {
        const set = new Set<unknown>(x.values ?? []);
        const out = new Int8Array(n);
        for (let i = 0; i < n; i += 1)
          out[i] = !isGap(a, i) && set.has(cell(a, i)) ? 1 : 0;
        return { kind: 'boolean', v: out };
      }
      case 'and':
      case 'or':
      case 'not': {
        const p = a.v as Int8Array;
        const out = new Int8Array(n);
        if (x.op === 'not') {
          for (let i = 0; i < n; i += 1) out[i] = p[i] === 1 ? 0 : 1;
        } else {
          const q = args[1]!.v as Int8Array;
          if (x.op === 'and') {
            for (let i = 0; i < n; i += 1)
              out[i] = p[i] === 1 && q[i] === 1 ? 1 : 0;
          } else {
            for (let i = 0; i < n; i += 1)
              out[i] = p[i] === 1 || q[i] === 1 ? 1 : 0;
          }
        }
        return { kind: 'boolean', v: out };
      }
      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
        return {
          kind: 'number',
          v: arithmetic(
            x.op,
            a.v as Float64Array,
            args[1]!.v as Float64Array,
            n,
          ),
        };
      case 'neg':
      case 'abs': {
        const p = a.v as Float64Array;
        const out = reuse(p, n);
        if (x.op === 'neg') for (let i = 0; i < n; i += 1) out[i] = -p[i]!;
        else for (let i = 0; i < n; i += 1) out[i] = Math.abs(p[i]!);
        fresh.add(out);
        return { kind: 'number', v: out };
      }
      case 'isMissing': {
        const out = new Int8Array(n);
        for (let i = 0; i < n; i += 1) out[i] = isGap(a, i) ? 1 : 0;
        return { kind: 'boolean', v: out };
      }
      case 'fill':
        return pick(a, (i) => !isGap(a, i), a, args[1]!, n);
      case 'when': {
        const c = a.v as Int8Array;
        return pick(args[1]!, (i) => c[i] === 1, args[1]!, args[2]!, n);
      }
    }
  };
  /**
   * Shapes with one literal side, done without spreading the literal:
   * number comparison / arithmetic against a number, and text tests
   * (`eq`, `ne`, `in`) against fixed values on a dictionary-coded column.
   */
  const scalarCase = (
    x: Extract<ExprNode, { op: ExprOp }>,
  ): ColumnValues | null => {
    if (x.op === 'in') {
      const arg = x.args[0]!;
      if (!('col' in arg)) return null;
      const set = new Set<unknown>(x.values ?? []);
      const v = dictionaryTest(
        store.columns.get(arg.col)!,
        (s) => set.has(s),
        0,
        start,
        end,
        tables,
        x,
      );
      return v === null ? null : { kind: 'boolean', v };
    }
    if (!COMPARE.has(x.op) && !ARITH.has(x.op)) return null;
    const [l, r] = x.args as [ExprNode, ExprNode];
    const litRight = 'lit' in r;
    const litLeft = 'lit' in l;
    if (litLeft === litRight) return null;
    const other = litRight ? l : r;
    const value = (litRight ? r : l) as { lit: ExprLiteral };
    if (typeof value.lit === 'string') {
      if ((x.op !== 'eq' && x.op !== 'ne') || !('col' in other)) return null;
      const want = value.lit;
      const eq = x.op === 'eq';
      const v = dictionaryTest(
        store.columns.get(other.col)!,
        (s) => (s === want) === eq,
        eq ? 0 : 1,
        start,
        end,
        tables,
        x,
      );
      return v === null ? null : { kind: 'boolean', v };
    }
    if (typeof value.lit !== 'number') return null;
    const side = walk(other);
    if (side.kind !== 'number') return null;
    const k = value.lit;
    if (ARITH.has(x.op)) {
      const out = arithmeticScalar(x.op as ArithOp, side.v, k, litLeft, n);
      return { kind: 'number', v: out };
    }
    // `5 < v` is `v > 5`.
    const op = litLeft ? FLIP[x.op as CompareOp] : (x.op as CompareOp);
    return { kind: 'boolean', v: compareScalar(op, side.v, k, n) };
  };
  return walk(node);
}

type CompareOp = 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne';
type ArithOp = 'add' | 'sub' | 'mul' | 'div';
const COMPARE = new Set<string>(['gt', 'ge', 'lt', 'le', 'eq', 'ne']);
const ARITH = new Set<string>(['add', 'sub', 'mul', 'div']);
const FLIP: Record<CompareOp, CompareOp> = {
  gt: 'lt',
  ge: 'le',
  lt: 'gt',
  le: 'ge',
  eq: 'eq',
  ne: 'ne',
};

function compareScalar(
  op: CompareOp,
  p: Float64Array,
  k: number,
  n: number,
): Int8Array {
  const out = new Int8Array(n);
  switch (op) {
    case 'gt':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! > k ? 1 : 0;
      break;
    case 'ge':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! >= k ? 1 : 0;
      break;
    case 'lt':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! < k ? 1 : 0;
      break;
    case 'le':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! <= k ? 1 : 0;
      break;
    case 'eq':
      for (let i = 0; i < n; i += 1) out[i] = p[i] === k ? 1 : 0;
      break;
    case 'ne':
      for (let i = 0; i < n; i += 1) out[i] = p[i] === k ? 0 : 1;
      break;
  }
  return out;
}

/** `p op k`, or `k op p` when `litLeft`. Non-finite results are gaps. */
function arithmeticScalar(
  op: ArithOp,
  p: Float64Array,
  k: number,
  litLeft: boolean,
  n: number,
): Float64Array {
  const out = reuse(p, n);
  switch (op) {
    case 'add':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! + k;
      break;
    case 'mul':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! * k;
      break;
    case 'sub':
      if (litLeft) for (let i = 0; i < n; i += 1) out[i] = k - p[i]!;
      else for (let i = 0; i < n; i += 1) out[i] = p[i]! - k;
      break;
    case 'div':
      if (litLeft) for (let i = 0; i < n; i += 1) out[i] = k / p[i]!;
      else for (let i = 0; i < n; i += 1) out[i] = p[i]! / k;
      break;
  }
  return finiteOrGap(out);
}

function finiteOrGap(out: Float64Array): Float64Array {
  // A non-finite result (division by zero, overflow) is a gap at once.
  for (let i = 0; i < out.length; i += 1) {
    const v = out[i]!;
    if (v - v !== 0) out[i] = NaN;
  }
  fresh.add(out);
  return out;
}

function compare(
  op: 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne',
  a: ColumnValues,
  b: ColumnValues,
  n: number,
): ColumnValues {
  const out = new Int8Array(n);
  if (a.kind === 'number' && b.kind === 'number') {
    // NaN (a gap) compares false, as `undefined > 0` does.
    const p = a.v;
    const q = b.v;
    switch (op) {
      case 'gt':
        for (let i = 0; i < n; i += 1) out[i] = p[i]! > q[i]! ? 1 : 0;
        break;
      case 'ge':
        for (let i = 0; i < n; i += 1) out[i] = p[i]! >= q[i]! ? 1 : 0;
        break;
      case 'lt':
        for (let i = 0; i < n; i += 1) out[i] = p[i]! < q[i]! ? 1 : 0;
        break;
      case 'le':
        for (let i = 0; i < n; i += 1) out[i] = p[i]! <= q[i]! ? 1 : 0;
        break;
      case 'eq':
        for (let i = 0; i < n; i += 1) out[i] = p[i] === q[i] ? 1 : 0;
        break;
      case 'ne':
        for (let i = 0; i < n; i += 1) out[i] = p[i] === q[i] ? 0 : 1;
        break;
    }
    return { kind: 'boolean', v: out };
  }
  for (let i = 0; i < n; i += 1) {
    if (isGap(a, i) || isGap(b, i)) {
      out[i] = op === 'ne' ? 1 : 0;
      continue;
    }
    const x = cell(a, i) as string | boolean;
    const y = cell(b, i) as string | boolean;
    const r =
      op === 'eq'
        ? x === y
        : op === 'ne'
          ? x !== y
          : op === 'gt'
            ? x > y
            : op === 'ge'
              ? x >= y
              : op === 'lt'
                ? x < y
                : x <= y;
    out[i] = r ? 1 : 0;
  }
  return { kind: 'boolean', v: out };
}

function arithmetic(
  op: 'add' | 'sub' | 'mul' | 'div',
  p: Float64Array,
  q: Float64Array,
  n: number,
): Float64Array {
  const out = fresh.has(p) ? p : reuse(q, n);
  switch (op) {
    case 'add':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! + q[i]!;
      break;
    case 'sub':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! - q[i]!;
      break;
    case 'mul':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! * q[i]!;
      break;
    case 'div':
      for (let i = 0; i < n; i += 1) out[i] = p[i]! / q[i]!;
      break;
  }
  return finiteOrGap(out);
}

/** `yes[i]` where `take(i)`, else `no[i]`; `like` gives the kind. */
function pick(
  like: ColumnValues,
  take: (i: number) => boolean,
  yes: ColumnValues,
  no: ColumnValues,
  n: number,
): ColumnValues {
  if (like.kind === 'number') {
    const y = yes.v as Float64Array;
    const z = no.v as Float64Array;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) out[i] = take(i) ? y[i]! : z[i]!;
    fresh.add(out);
    return { kind: 'number', v: out };
  }
  if (like.kind === 'boolean') {
    const y = yes.v as Int8Array;
    const z = no.v as Int8Array;
    const out = new Int8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = take(i) ? y[i]! : z[i]!;
    return { kind: 'boolean', v: out };
  }
  const y = yes.v as (string | undefined)[];
  const z = no.v as (string | undefined)[];
  const out = new Array<string | undefined>(n);
  for (let i = 0; i < n; i += 1) out[i] = take(i) ? y[i] : z[i];
  return { kind: 'string', v: out };
}

/** The schema's value columns, as {@link checkExpr} reads them. */
export function exprColumns(
  schema: readonly { name: string; kind: string }[],
): ExprColumn[] {
  return schema.slice(1).map((d) => ({ name: d.name, kind: d.kind }));
}

/** Checks `node` against the schema and evaluates it over the store. */
export function evaluateStoreExpr(
  node: ExprNode,
  store: ColumnarStore<ColumnSchema>,
  schema: readonly { name: string; kind: string }[],
  where: string,
  want?: CheckedKind,
): ColumnValues {
  return prepareStoreExpr(node, store, schema, where, want)(0, store.length);
}

/**
 * Checks `node` against the schema once, then evaluates any row range
 * `[start, end)` of the store on demand (for `find` / `some` / `every`,
 * which look at growing stretches).
 */
export function prepareStoreExpr(
  node: ExprNode,
  store: ColumnarStore<ColumnSchema>,
  schema: readonly { name: string; kind: string }[],
  where: string,
  want?: CheckedKind,
): (start: number, end: number) => ColumnValues {
  const columns = exprColumns(schema);
  const kind = checkExpr(node, columns, where);
  if (want !== undefined && kind !== want) {
    throw new TypeError(
      want === 'boolean'
        ? `${where}: needs a true/false expression, got ${kind}`
        : `${where}: the expression gives ${kind}, the column is ${want}`,
    );
  }
  const kinds = new Map<string, CheckedKind>();
  for (const c of columns) {
    if (c.kind === 'number' || c.kind === 'string' || c.kind === 'boolean')
      kinds.set(c.name, c.kind);
  }
  const tables = new Map<ExprNode, Int8Array>();
  return (start, end) =>
    evaluateColumns(node, store, kinds, start, end, tables);
}

/** Evaluated values as a column; gaps where `keepGapsOf` has them, when given. */
export function columnOf(
  values: ColumnValues,
  keepGapsOf?: ColumnValues,
): Column {
  const n = values.v.length;
  const gapAt = (i: number) => keepGapsOf !== undefined && isGap(keepGapsOf, i);
  if (values.kind === 'number') {
    // A store column read as is must be copied; the evaluator's own
    // results are already finite-or-NaN and nobody else holds them.
    if (!fresh.has(values.v)) {
      const v = values.v.slice();
      if (keepGapsOf !== undefined)
        for (let i = 0; i < n; i += 1) if (gapAt(i)) v[i] = NaN;
      return float64ColumnFromTypedArray(v);
    }
    const v = values.v;
    fresh.delete(v);
    if (keepGapsOf?.kind === 'number') {
      const g = keepGapsOf.v;
      for (let i = 0; i < n; i += 1) if (g[i]! !== g[i]!) v[i] = NaN;
    } else if (keepGapsOf !== undefined) {
      for (let i = 0; i < n; i += 1) if (gapAt(i)) v[i] = NaN;
    }
    let allFinite = true;
    for (let i = 0; i < n; i += 1) {
      if (v[i]! !== v[i]!) {
        allFinite = false;
        break;
      }
    }
    return new Float64Column(v, n, allFinite);
  }
  if (values.kind === 'boolean') {
    const out = new Array<boolean | undefined>(n);
    for (let i = 0; i < n; i += 1) {
      const x = values.v[i];
      out[i] = gapAt(i) || x === -1 ? undefined : x === 1;
    }
    return booleanColumnFromArray(out);
  }
  const out = new Array<string | undefined>(n);
  for (let i = 0; i < n; i += 1) out[i] = gapAt(i) ? undefined : values.v[i];
  return stringColumnFromArray(out);
}
