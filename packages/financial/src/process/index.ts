/**
 * `@pond-ts/financial/process` — the study catalog as `@pond-ts/process`
 * steps.
 *
 * A finance MCP server answers an agent by running a process plan, and a
 * plan can only name ops its registry holds. The catalog already carries
 * every fact a registry needs (params with ranges, input roles, outputs
 * with units), but the code turning a descriptor into an op lived only in
 * a test, with `params: {}`, so every server would have re-written it —
 * and the twelve multi-output studies that claim a bare suffix make the
 * obvious version throw at load (see `StudyOutput.id`).
 *
 * ```ts
 * import { BASIC_OPS, SUMMARY_FOLDS, createRegistry } from '@pond-ts/process';
 * import { studyOps } from '@pond-ts/financial/process';
 *
 * let registry = createRegistry();
 * for (const def of [...studyOps({ sessions: nyse }), ...BASIC_OPS, ...SUMMARY_FOLDS])
 *   registry = registry.define(def);
 * ```
 *
 * `@pond-ts/process` is needed for its **types** only; nothing here imports
 * it at run time, so it is an optional peer.
 *
 * ## What the bridge decides
 *
 * - **Column inputs become input roles**, in the catalog's order, so an
 *   ATR spec lists `['high', 'low', 'close']`. A plan names every column
 *   explicitly; the catalog's column defaults are not applied.
 * - **A param with no default takes its catalog `example` as the default**
 *   (`sma`'s `period` is 20). Process requires every param to have one, and
 *   the default lands in the spec id and its explanation, so nothing is
 *   hidden from the agent.
 * - **An `optional` param is left out**, with any param that `requires`
 *   it: process has no way to say "absent". Only `balanceOfPower` has one;
 *   its step is the raw per-bar ratio.
 * - **Output columns are named by the spec id**, so a study's own default
 *   name (`rsi`) can never collide with a column already on the series.
 * - **A bare suffix on a multi-output study becomes `'value'`** (the
 *   twelve whose primary line has no suffix); every other suffix is kept.
 * - **Session studies** (`sessionVwap`, `pivotPoints`) are included only
 *   when `sessions` is given, and use it for every request.
 *   `pivotPoints`' `'camarilla'` method computes its `R4`/`S4` too, but only
 *   the default method's seven outputs are declared, so those two are not
 *   reachable.
 * - **`anchoredVwap` is left out**: its anchor is an instant, and a process
 *   param can only be a number, a fixed choice or a flag.
 * - **No lookback is declared**, so `requiredHistory` reports a plan using
 *   these as unknown rather than guessing.
 */

import type { OpContext, OpDef, OutputDef, ParamDef } from '@pond-ts/process';
import { STUDIES } from '../catalog/index.js';
import type {
  StudyDescriptor,
  StudyOutput,
  StudyParam,
} from '../catalog/index.js';
import type { SessionSource } from '../contract/session-anchor.js';

export interface StudyOpsOptions {
  /**
   * Where the session-anchored studies find their sessions — a
   * `TradingCalendar` or a `Session[]`. Without it, `sessionVwap` and
   * `pivotPoints` are not in the returned list.
   */
  readonly sessions?: SessionSource;
  /** Bar-stamp convention for `sessions` — `'open'` (default) or `'close'`. */
  readonly stamped?: 'open' | 'close';
}

/** Studies the bridge cannot express, and why — reported, not hidden. */
export const UNBRIDGED_STUDIES: Readonly<Record<string, string>> = {
  anchoredVwap:
    'its anchor is an instant, and a process param can only be a number, a fixed choice or a flag',
};

function outletId(d: StudyDescriptor, output: StudyOutput): string {
  return d.outputs.length > 1 && output.id === '' ? 'value' : output.id;
}

function toParam(p: StudyParam): ParamDef {
  if (p.kind === 'enum') {
    return { kind: 'enum', default: (p.default ?? p.example)!, of: p.of };
  }
  return {
    kind: p.kind,
    default: (p.default ?? p.example)!,
    ...(p.min !== undefined && { min: p.min }),
    ...(p.max !== undefined && { max: p.max }),
    ...(p.suggest !== undefined && { suggest: p.suggest }),
  };
}

function paramsOf(d: StudyDescriptor): Record<string, ParamDef> {
  const dropped = new Set(
    Object.entries(d.params)
      .filter(([, p]) => p.optional === true)
      .map(([k]) => k),
  );
  const out: Record<string, ParamDef> = {};
  for (const [key, p] of Object.entries(d.params)) {
    if (dropped.has(key)) continue;
    if (p.requires !== undefined && dropped.has(p.requires)) continue;
    out[key] = toParam(p);
  }
  return out;
}

/** One study as a process op. */
export function studyOp(
  d: StudyDescriptor,
  options: StudyOpsOptions = {},
): OpDef {
  if (d.anchor === 'time') {
    throw new Error(`${d.name}: ${UNBRIDGED_STUDIES[d.name] ?? 'not bridged'}`);
  }
  if (d.anchor === 'session' && options.sessions === undefined) {
    throw new Error(
      `${d.name} needs sessions — pass studyOp(d, { sessions: calendar })`,
    );
  }
  const params = paramsOf(d);
  const names = Object.keys(params);
  return {
    name: d.name,
    family: d.family,
    summary: d.summary,
    params,
    inputs: d.inputs.map((i) => ({ role: i.role })),
    outputs: d.outputs.map(
      (o): OutputDef => ({ id: outletId(d, o), unit: o.unit }),
    ),
    run: (ctx: OpContext) => {
      const call: Record<string, unknown> = {};
      for (const key of names) call[key] = ctx.params[key];
      for (const input of d.inputs) call[input.role] = ctx.inputs[input.role];
      if (d.anchor === 'session') {
        call['sessions'] = options.sessions;
        if (options.stamped !== undefined) call['stamped'] = options.stamped;
      }
      // Named by the spec id, which nothing on the series can already be.
      call[d.naming.kind] = ctx.id;
      const out = d.run(ctx.series, call);
      if (d.naming.kind === 'output') return out.column(ctx.id);
      return d.outputs.map((o) => out.column(`${ctx.id}${o.id}`));
    },
  };
}

/**
 * Every bridgeable study as a process op, in catalog order.
 *
 * `anchoredVwap` is always left out ({@link UNBRIDGED_STUDIES}); the two
 * session studies are left out unless `sessions` is given.
 */
export function studyOps(options: StudyOpsOptions = {}): readonly OpDef[] {
  return STUDIES.filter(
    (d) =>
      d.anchor !== 'time' &&
      (d.anchor !== 'session' || options.sessions !== undefined),
  ).map((d) => studyOp(d, options));
}
