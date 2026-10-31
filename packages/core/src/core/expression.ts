/**
 * Column expressions ([PND-EXPR], `docs/rfcs/expressions.md`): per-row
 * rules written as data, `col('value').gt(0)`, so a method can run them
 * over whole columns instead of calling a function once per row.
 *
 * An {@link Expr} is a plain tree ({@link ExprNode}); `toJSON()` gives it
 * as JSON, which is also how the pond-rs bridges carry it. This module
 * holds the builder, the schema check ({@link checkExpr}) and a per-row
 * evaluator for the live layer ({@link rowPredicate}). The column-wise
 * evaluator for batch series is `batch/operators/expression.ts`.
 *
 * Gaps follow what the function an expression replaces would do with
 * `undefined`: a comparison with a gap is false, `not` flips plainly (so
 * `not` of a comparison keeps gap rows), arithmetic with a gap is a gap.
 * Two places differ on purpose: `eq` with a gap on **either** side is
 * false (a function comparing two gaps gets `undefined === undefined`),
 * and a non-finite arithmetic result (division by zero) is a gap at once
 * rather than `Infinity`.
 */

/** The kind of value an expression gives; `'any'` when only the schema can say (a bare `col`). */
export type ExprKind = 'number' | 'string' | 'boolean' | 'any';

/** A plain value an expression can hold. */
export type ExprLiteral = number | string | boolean;

/** An expression, or a plain value (wrapped as `lit(value)`). */
export type ExprInput = Expr | ExprLiteral;

/** The JSON form of an expression. */
export type ExprNode =
  | { readonly col: string }
  | { readonly lit: ExprLiteral }
  | {
      readonly op: ExprOp;
      readonly args: readonly ExprNode[];
      /** `in` only: the values to match. */
      readonly values?: readonly ExprLiteral[];
    };

/** Every operation an {@link ExprNode} can name. */
export type ExprOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'in'
  | 'and'
  | 'or'
  | 'not'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'neg'
  | 'abs'
  | 'isMissing'
  | 'fill'
  | 'when';

const node = (v: ExprInput): ExprNode =>
  v instanceof Expr ? v.node : { lit: v };

/**
 * A column expression. Build one with {@link col}, {@link lit} or
 * {@link when}; pass it where a method takes a per-row function
 * (`filter`, `find`, `some`, `every`, `mapColumns`, `withColumn`, live
 * `filter`). `K` is the kind of value it gives, as far as the types know.
 */
export class Expr<K extends ExprKind = ExprKind> {
  /** The tree, as `toJSON()` gives it. */
  readonly node: ExprNode;
  /** Type-level only: the kind this expression gives. */
  declare readonly kind?: K;

  constructor(n: ExprNode) {
    this.node = n;
    Object.freeze(this);
  }

  #op<R extends ExprKind>(op: ExprOp, ...rest: ExprInput[]): Expr<R> {
    return new Expr<R>({ op, args: [this.node, ...rest.map(node)] });
  }

  /** Equal (`false` when either side is a gap). */
  eq(other: ExprInput): Expr<'boolean'> {
    return this.#op('eq', other);
  }
  /** Not equal: exactly `eq(other).not()`, so `true` when either side is a gap. */
  ne(other: ExprInput): Expr<'boolean'> {
    return this.#op('ne', other);
  }
  /** Greater than (numbers, or text in JavaScript's order). */
  gt(other: ExprInput): Expr<'boolean'> {
    return this.#op('gt', other);
  }
  /** Greater than or equal. */
  ge(other: ExprInput): Expr<'boolean'> {
    return this.#op('ge', other);
  }
  /** Less than. */
  lt(other: ExprInput): Expr<'boolean'> {
    return this.#op('lt', other);
  }
  /** Less than or equal. */
  le(other: ExprInput): Expr<'boolean'> {
    return this.#op('le', other);
  }
  /** One of `values` (`false` for a gap). */
  in(values: readonly ExprLiteral[]): Expr<'boolean'> {
    if (!Array.isArray(values)) {
      throw new TypeError('in(values): values must be an array');
    }
    return new Expr({ op: 'in', args: [this.node], values: [...values] });
  }
  /** Both true (a gap counts as false). */
  and(other: ExprInput): Expr<'boolean'> {
    return this.#op('and', other);
  }
  /** Either true (a gap counts as false). */
  or(other: ExprInput): Expr<'boolean'> {
    return this.#op('or', other);
  }
  /** Not (a gap counts as false, so `not` gives true). */
  not(): Expr<'boolean'> {
    return this.#op('not');
  }
  /** Plus. */
  add(other: ExprInput): Expr<'number'> {
    return this.#op('add', other);
  }
  /** Minus. */
  sub(other: ExprInput): Expr<'number'> {
    return this.#op('sub', other);
  }
  /** Times. */
  mul(other: ExprInput): Expr<'number'> {
    return this.#op('mul', other);
  }
  /** Divided by (division by zero gives a gap). */
  div(other: ExprInput): Expr<'number'> {
    return this.#op('div', other);
  }
  /** Negated. */
  neg(): Expr<'number'> {
    return this.#op('neg');
  }
  /** Absolute value. */
  abs(): Expr<'number'> {
    return this.#op('abs');
  }
  /** `true` where the value is a gap. */
  isMissing(): Expr<'boolean'> {
    return this.#op('isMissing');
  }
  /** Gaps replaced by `value` (an expression or a plain value of the same kind). */
  fill(value: ExprInput): Expr<K> {
    return this.#op('fill', value);
  }

  /** The JSON form. */
  toJSON(): ExprNode {
    return this.node;
  }
}

/** The value of column `name` in each row. */
export function col(name: string): Expr<'any'> {
  if (typeof name !== 'string') {
    throw new TypeError('col(name): name must be a string');
  }
  return new Expr({ col: name });
}

type LitKind<V> = V extends number
  ? 'number'
  : V extends string
    ? 'string'
    : V extends boolean
      ? 'boolean'
      : never;

/** A fixed value (plain values are wrapped for you; needed only when the value comes first: `lit(100).sub(col('pct'))`). */
export function lit<V extends ExprLiteral>(value: V): Expr<LitKind<V>> {
  checkLiteral(value, 'lit(value)');
  return new Expr({ lit: value });
}

type WhenKind<A, B> =
  A extends Expr<infer KA> ? KA : B extends Expr<infer KB> ? KB : LitKind<A>;

/** `then` where `condition` is true, else `otherwise` (a gap in `condition` counts as false). */
export function when<A extends ExprInput, B extends ExprInput>(
  condition: Expr,
  then: A,
  otherwise: B,
): Expr<WhenKind<A, B> & ExprKind> {
  return new Expr({
    op: 'when',
    args: [node(condition), node(then), node(otherwise)],
  });
}

function checkLiteral(v: unknown, where: string): void {
  const ok =
    (typeof v === 'number' && Number.isFinite(v)) ||
    typeof v === 'string' ||
    typeof v === 'boolean';
  if (!ok) {
    throw new TypeError(
      `${where}: expected a finite number, text or true/false, got ${String(v)}`,
    );
  }
}

// ─── Checking ───────────────────────────────────────────────────────

/** A column an expression may read: its name and kind. */
export type ExprColumn = { readonly name: string; readonly kind: string };

/** The concrete kind of a checked expression. */
export type CheckedKind = 'number' | 'string' | 'boolean';

const COMPARE = new Set(['gt', 'ge', 'lt', 'le']);
const ARITH = new Set(['add', 'sub', 'mul', 'div']);
const ARITY: Record<ExprOp, number> = {
  eq: 2,
  ne: 2,
  gt: 2,
  ge: 2,
  lt: 2,
  le: 2,
  in: 1,
  and: 2,
  or: 2,
  not: 1,
  add: 2,
  sub: 2,
  mul: 2,
  div: 2,
  neg: 1,
  abs: 1,
  isMissing: 1,
  fill: 2,
  when: 3,
};

/**
 * The kind `n` gives over `columns` (the value columns), or a
 * `TypeError` naming what is wrong: an unknown column (listing the real
 * ones), an array column, or operands of the wrong kind. `where` names
 * the method in the message.
 */
export function checkExpr(
  n: ExprNode,
  columns: readonly ExprColumn[],
  where: string,
): CheckedKind {
  const fail = (msg: string): never => {
    throw new TypeError(`${where}: ${msg}`);
  };
  const walk = (x: ExprNode): CheckedKind => {
    if (x === null || typeof x !== 'object') {
      return fail(`not an expression: ${JSON.stringify(x)}`);
    }
    if ('col' in x) {
      const c = columns.find((d) => d.name === x.col);
      if (c === undefined) {
        return fail(
          `unknown column '${x.col}' (columns: ${columns.map((d) => d.name).join(', ')})`,
        );
      }
      if (c.kind === 'number' || c.kind === 'string' || c.kind === 'boolean') {
        return c.kind;
      }
      return fail(
        `column '${x.col}' is ${c.kind}; expressions read number, string and boolean columns`,
      );
    }
    if ('lit' in x) {
      checkLiteral(x.lit, where);
      return typeof x.lit as CheckedKind;
    }
    const op = x.op;
    if (!(op in ARITY)) return fail(`unknown operation '${String(op)}'`);
    if (!Array.isArray(x.args) || x.args.length !== ARITY[op]) {
      return fail(`${op} takes ${ARITY[op]} operand(s)`);
    }
    const kinds = x.args.map(walk);
    const [a, b, c] = kinds;
    const same = (what: string) => {
      if (a !== b)
        fail(
          `${op} needs two values of the same kind, got ${a} and ${b}${what}`,
        );
    };
    if (op === 'eq' || op === 'ne') {
      same('');
      return 'boolean';
    }
    if (COMPARE.has(op)) {
      same('');
      if (a === 'boolean')
        fail(`${op} compares numbers or text, not true/false`);
      return 'boolean';
    }
    if (op === 'in') {
      const values = x.values;
      if (!Array.isArray(values)) return fail('in needs a list of values');
      for (const v of values) {
        checkLiteral(v, where);
        if (typeof v !== a) fail(`in: ${JSON.stringify(v)} is not a ${a}`);
      }
      return 'boolean';
    }
    if (op === 'and' || op === 'or' || op === 'not') {
      if (kinds.some((k) => k !== 'boolean'))
        fail(`${op} needs true/false values, got ${kinds.join(' and ')}`);
      return 'boolean';
    }
    if (ARITH.has(op) || op === 'neg' || op === 'abs') {
      if (kinds.some((k) => k !== 'number'))
        fail(`${op} needs numbers, got ${kinds.join(' and ')}`);
      return 'number';
    }
    if (op === 'isMissing') return 'boolean';
    if (op === 'fill') {
      same(' (fill value)');
      return a!;
    }
    // when
    if (a !== 'boolean') fail(`when needs a true/false condition, got ${a}`);
    if (b !== c)
      fail(`when needs both branches of the same kind, got ${b} and ${c}`);
    return b!;
  };
  return walk(n);
}

// ─── Per-row evaluation (live layer) ────────────────────────────────

/** One row's value: a number (`NaN` is a gap), text, true/false, or `undefined` (a gap). */
type RowValue = number | string | boolean | undefined;

const missing = (v: RowValue): boolean =>
  v === undefined || (typeof v === 'number' && v !== v);

const finiteOrGap = (v: number): number => (v - v === 0 ? v : NaN);

/** `n` on one row, reading cells through `get` (a gap is `undefined`). */
export function evaluateRow(
  n: ExprNode,
  get: (column: string) => unknown,
): RowValue {
  if ('col' in n) {
    const v = get(n.col);
    return v === undefined || v === null ? undefined : (v as RowValue);
  }
  if ('lit' in n) return n.lit;
  const args = n.args;
  const at = (i: number): RowValue => evaluateRow(args[i]!, get);
  const num = (i: number): number => {
    const v = at(i);
    return typeof v === 'number' ? v : NaN;
  };
  const truthy = (i: number): boolean => at(i) === true;
  switch (n.op) {
    case 'eq': {
      const a = at(0);
      const b = at(1);
      return !missing(a) && !missing(b) && a === b;
    }
    case 'ne': {
      const a = at(0);
      const b = at(1);
      return !(!missing(a) && !missing(b) && a === b);
    }
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      const a = at(0);
      const b = at(1);
      if (missing(a) || missing(b)) return false;
      const x = a as number | string;
      const y = b as number | string;
      return n.op === 'gt'
        ? x > y
        : n.op === 'ge'
          ? x >= y
          : n.op === 'lt'
            ? x < y
            : x <= y;
    }
    case 'in': {
      const a = at(0);
      return !missing(a) && (n.values ?? []).includes(a as ExprLiteral);
    }
    case 'and':
      return truthy(0) && truthy(1);
    case 'or':
      return truthy(0) || truthy(1);
    case 'not':
      return !truthy(0);
    case 'add':
      return finiteOrGap(num(0) + num(1));
    case 'sub':
      return finiteOrGap(num(0) - num(1));
    case 'mul':
      return finiteOrGap(num(0) * num(1));
    case 'div':
      return finiteOrGap(num(0) / num(1));
    case 'neg':
      return -num(0);
    case 'abs':
      return Math.abs(num(0));
    case 'isMissing':
      return missing(at(0));
    case 'fill': {
      const a = at(0);
      return missing(a) ? at(1) : a;
    }
    case 'when':
      return truthy(0) ? at(1) : at(2);
  }
}

/**
 * A per-event predicate for `expr`, checked once against `columns`
 * (for the live layer's `filter`). Must give a true/false expression.
 */
export function rowPredicate(
  expr: Expr,
  columns: readonly ExprColumn[],
  where: string,
): (event: { get(column: string): unknown }) => boolean {
  const kind = checkExpr(expr.node, columns, where);
  if (kind !== 'boolean') {
    throw new TypeError(`${where}: needs a true/false expression, got ${kind}`);
  }
  const n = expr.node;
  return (event) => evaluateRow(n, (c) => event.get(c)) === true;
}
