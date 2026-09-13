import type { SeriesSchema, TimeSeries } from 'pond-ts';

/**
 * The picker's grouping — the assessment's §6 families
 * (`docs/notes/financial-indicators-assessment-2026-07.md`), one per study.
 */
export type StudyFamily =
  | 'moving-average'
  | 'bands'
  | 'momentum'
  | 'trend'
  | 'volatility'
  | 'volume'
  | 'statistical'
  | 'price'
  | 'session';

/** {@link StudyFamily} as a list, in menu order. */
export const STUDY_FAMILIES: readonly StudyFamily[] = [
  'moving-average',
  'bands',
  'momentum',
  'trend',
  'volatility',
  'volume',
  'statistical',
  'price',
  'session',
];

/**
 * What an output column is denominated in — the fact a consumer needs to
 * decide **axis membership**: only `'inherit'` may share the source's axis.
 *
 * - `'inherit'` — a level in the source column's own units (a moving
 *   average, a band edge, a pivot). Overlays the price axis.
 * - `'delta'` — the source's units but a *difference*, zero-centred (MACD,
 *   momentum, Elder Ray). Its own axis.
 * - `'percent'` — a percentage scale, bounded or not (RSI 0..100,
 *   Williams %R −100..0, a percent rate of change).
 * - `'ratio'` — dimensionless and unbounded (a z-score, correlation, R²,
 *   Fisher transform, a stochastic already scaled 0..1).
 * - `'signal'` — a small integer verdict (`+1` / `0` / `−1`, a direction, a
 *   cross event).
 * - `'volume'` — in the volume column's units (OBV, A/D, money flow).
 * - `'index'` — a cumulative index with an arbitrary origin (NVI/PVI at
 *   1000, accumulative swing index).
 * - `'bars'` — a bar count.
 */
export type StudyUnit =
  | 'inherit'
  | 'delta'
  | 'percent'
  | 'ratio'
  | 'signal'
  | 'volume'
  | 'index'
  | 'bars';

/** A column the study reads. The `role` is the options key it is passed by. */
export interface StudyInput {
  readonly role: string;
  /** The column read when the option is omitted. **Absent means required**
   *  (a `benchmark` has no sensible default). */
  readonly default?: string;
}

/**
 * A numeric option. Mirrors `@pond-ts/process`'s `NumberParam` so a
 * consumer's registry can map it rather than interpret it.
 */
export interface StudyNumberParam {
  readonly kind: 'number' | 'integer';
  /** The value used when the option is omitted. **Absent means required**,
   *  unless `optional` is set. */
  readonly default?: number;
  /** For an option with no `default`: a value that makes the study runnable
   *  (required) or that a control starts from when the option is switched
   *  on (`optional`) — a UI placeholder, and what the catalog's own test
   *  runs with. */
  readonly example?: number;
  /** The option may be **omitted, and omitting it is not a default value**
   *  — it switches a behaviour off (`balanceOfPower`'s `period`: absent is
   *  the raw per-bar ratio, present smooths it). Carries an `example`, not
   *  a `default`. */
  readonly optional?: true;
  /** This option is only meaningful — and only legal — alongside the named
   *  one (`balanceOfPower`'s `maType` needs its `period`). A control shows
   *  it only when that one is set; the catalog test runs it with it. */
  readonly requires?: string;
  /** The legal range, **inclusive**, declared only where the study validates
   *  a constant bound: the catalog test runs the study at `min` (and `max`)
   *  and expects it to be accepted, and one below (above) and expects a
   *  throw. A bound that is not a constant — a `slowPeriod` that must exceed
   *  the `fastPeriod`, a strictly-positive real with no smallest legal
   *  value — is not declared; `suggest` then carries the range a control
   *  is drawn on, chosen to be legal throughout at the other options'
   *  defaults. */
  readonly min?: number;
  readonly max?: number;
  /** The **useful** range, within `[min, max]` — what a control is drawn on.
   *  Advisory: nothing rejects a value outside it. */
  readonly suggest?: readonly [number, number];
}

/** A closed-menu option (`maType`, a pivot `method`). */
export interface StudyEnumParam {
  readonly kind: 'enum';
  readonly default?: string;
  readonly example?: string;
  readonly of: readonly string[];
  /** As on {@link StudyNumberParam}. */
  readonly optional?: true;
  readonly requires?: string;
}

export type StudyParam = StudyNumberParam | StudyEnumParam;

/** One appended column. */
export interface StudyOutput {
  /**
   * The column's name suffix under `prefix` naming (`'Upper'` in
   * `bbUpper`), or `''` under `output` naming, where the single column *is*
   * the `output` option's value. Under `prefix` naming `''` names the
   * **bare prefix** — the primary line of a study whose companions carry
   * suffixes (`superTrend`'s `st` beside `stTrend`, `klinger`'s `kvo` beside
   * `kvoSignal`); at most one output may claim it.
   *
   * **This is a `@pond-ts/financial` column suffix, not a
   * `@pond-ts/process` outlet id.** The two are separate namespaces that
   * happen to share a field name, and a registry bridging them must map
   * between them rather than pass this through.
   *
   * Process names an op's columns itself, as `specId + OutputDef.id`, and
   * its `toColumns` matches an op's return to its declared outputs
   * **positionally** — a study's own column names never reach it. So the
   * suffixes a bridge declares are free, and for the twelve multi-output
   * studies that claim the bare prefix they are not merely free but
   * *forced*: process rejects `''` on a multi-output op, because there the
   * column would be named exactly the spec id, which is itself a legal
   * column reference. Give those twelve a name, and leave every other
   * suffix alone: `''` is legal on a **single**-output op, where the
   * column *is* the spec id, so rewriting it there would rename all
   * seventy-odd of them for nothing. The map is
   * `outputs.length > 1 && id === ''`, not `id === ''`.
   *
   * `'value'` is the natural name to map to — it is what process's own
   * `outletKey` calls a bare outlet — but it is a *choice*, not something
   * process requires: any suffix legal on a multi-output op will do.
   * Process emits no `value` column of its own accord; a bridge that
   * picks this name is what produces `${specId}value`.
   *
   * `test/catalog-process.test.ts` pins that round trip, including the
   * rejection, so neither package can drift from it silently.
   */
  readonly id: string;
  readonly unit: StudyUnit;
}

/**
 * How the study names what it appends: a single column named by the
 * `output` option, or a family named `${prefix}${output.id}`.
 */
export type StudyNaming =
  | { readonly kind: 'output'; readonly default: string }
  | { readonly kind: 'prefix'; readonly default: string };

/** The study function, widened to the wide schema for a registry to call. */
export type StudyRun = (
  series: TimeSeries<SeriesSchema>,
  options: Readonly<Record<string, unknown>>,
) => TimeSeries<SeriesSchema>;

/**
 * A study, described at runtime — every fact a registry or a picker needs
 * that the options interface and the return type carry only at the type
 * level. Built with {@link defineStudy}, which checks the description
 * against the study's own options interface at compile time; the catalog
 * test runs every one against the study at test time.
 */
export interface StudyDescriptor {
  /** The study's exported name, and its fluent method (`'atr'`). */
  readonly name: string;
  readonly family: StudyFamily;
  /** One line, for a menu. */
  readonly summary: string;
  /** The columns read, in options order. */
  readonly inputs: readonly StudyInput[];
  /** The numeric and menu options, keyed by the options key, in options
   *  order. Column inputs, `output`/`prefix` and the session anchor are
   *  not params. */
  readonly params: Readonly<Record<string, StudyParam>>;
  readonly naming: StudyNaming;
  /** The columns appended, in the order the study appends them, **under the
   *  default params** — a menu value can change the set (`pivotPoints`'
   *  `'camarilla'` adds an `R4`/`S4` pair); the study's docstring says so
   *  where it does. */
  readonly outputs: readonly StudyOutput[];
  /**
   * An input that is neither a column nor a number, which a registry
   * supplies from its own context rather than from a control:
   *
   * - `'session'` — the two session-anchored studies (`sessionVwap`,
   *   `pivotPoints`). Besides the inputs and params here, the call needs
   *   exactly one of `sessions` (a `TradingCalendar` or `Session[]`, with an
   *   optional `stamped`) or `session` (a session-id column).
   * - `'time'` — `anchoredVwap`. The call needs `anchor`, an instant
   *   (`Date` or epoch milliseconds) to start the line from.
   */
  readonly anchor?: 'session' | 'time';
  readonly run: StudyRun;
}
