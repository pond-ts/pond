/**
 * Port declarations and the type-level plumbing that turns them into
 * typed inlet / outlet maps on a node.
 *
 * A `PortSpec<T>` is a compile-time declaration: it carries the port's
 * value type and, optionally, the equality used to decide whether a
 * recomputed value counts as *changed* (see `Outlet` version stamping
 * in `port.ts`). At runtime a spec is a plain object — usually empty.
 */

/**
 * Declares one port's value type.
 *
 * `valueType` is a phantom marker: never set at runtime, present only so
 * `T` is inferable from a spec (`PortSpec<infer T>`). Together with the
 * `equals` parameter position it also makes `PortSpec` invariant in `T`,
 * so a `PortSpec<string>` is not silently accepted where a
 * `PortSpec<number>` is required.
 */
export interface PortSpec<T> {
  /**
   * Decides whether a newly computed value differs from the cached one.
   * Returning `true` suppresses the version bump, so every downstream
   * node skips recomputation even though it was marked dirty.
   *
   * It also **keeps the previously cached value** — the newly computed
   * one is discarded. That is what makes the cutoff work (downstream
   * `Object.is` checks still see the same reference), but it means a
   * loose `equals` loses data: an `equals` comparing only an `id` field
   * will keep serving the old object after the rest of it changed.
   * Compare everything a consumer can observe.
   *
   * Defaults to `Object.is`. For immutable pond values (`TimeSeries`,
   * `Event`) identity is the right test — a transform that genuinely
   * changed something returns a new instance. Supply a structural
   * comparison when a node produces scalars or small records, where
   * "same number as last time" is common and downstream work is not
   * free.
   */
  readonly equals?: (a: T, b: T) => boolean;

  /**
   * Value used when the inlet is left unconnected. Without it, pulling
   * through an unconnected inlet throws `UnconnectedInputError`.
   *
   * Outputs ignore this field.
   */
  readonly defaultValue?: T;

  /** Phantom type marker. Never present at runtime. */
  readonly valueType?: T;
}

/**
 * A named set of port declarations, as passed to {@link defineNode}.
 *
 * `PortSpec<any>` is deliberate: `PortSpec` is invariant in its value
 * type, so a bounded element type (`unknown`, `never`) would reject
 * every concrete spec. The constraint exists to pin the *shape*; the
 * per-port types are recovered by inference through {@link PortValues}.
 */
export type PortSpecMap = Readonly<Record<string, PortSpec<any>>>;

/** Extracts the value type carried by a {@link PortSpec}. */
export type PortValue<P> = P extends PortSpec<infer T> ? T : never;

/** Maps a spec map to the plain value record `compute` receives / returns. */
export type PortValues<M> = { [K in keyof M]: PortValue<M[K]> };

/**
 * Declares a port of type `T`.
 *
 * ```ts
 * inputs: { series: port<TimeSeries<Schema>>() },
 * outputs: { mean: port<number>({ equals: (a, b) => a === b }) },
 * ```
 */
export function port<T>(
  options: {
    readonly equals?: (a: T, b: T) => boolean;
    readonly defaultValue?: T;
  } = {},
): PortSpec<T> {
  const spec: { equals?: (a: T, b: T) => boolean; defaultValue?: T } = {};
  if (options.equals !== undefined) spec.equals = options.equals;
  if (options.defaultValue !== undefined)
    spec.defaultValue = options.defaultValue;
  return spec;
}
