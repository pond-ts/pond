/** Errors thrown by the graph engine. */

/**
 * Base class for every error this package throws.
 *
 * ## Why there is a `code` beside `name`
 *
 * `instanceof` is the right discriminator when a consumer **catches**.
 * But `run` under `onError: 'skip' | 'collect'` does not hand the error
 * back — it reports a `Skipped` record — and a consumer branching
 * its UI on the failure kind (a dropped feed column is a dimmed chip; a
 * bad persisted param is a broken one) then has only prose to go on
 * (Tidal, `docs/notes/tidal-process-adoption-friction-2026-08.md`).
 *
 * `code` is that discriminator, and it is a **literal string per class**
 * rather than `constructor.name` because a consumer's minifier may
 * rename the class — leaving `name` as `'t'` in a production build,
 * silently, which is exactly the shape of bug the string exists to let
 * them avoid. Declared once as a `static`, read here through
 * `new.target`, so a subclass states its code on one line.
 */
export class ProcessError extends Error {
  /** The literal a subclass overrides. Read via `new.target`, not `this`. */
  static readonly code: string = 'ProcessError';

  /**
   * Stable kind, safe to compare against a literal and to send over a
   * wire. Rides on `Skipped.code` when a run reports rather than throws.
   */
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    this.code = (new.target as typeof ProcessError).code;
  }
}

/**
 * Thrown by `connect()` when the edge would close a cycle. The graph is
 * kept acyclic by construction rather than detected during evaluation,
 * so a cycle surfaces at the line that wires it, not at some later pull.
 */
export class CycleError extends ProcessError {
  static override readonly code = 'CycleError';
}

/** Thrown when pulling through an inlet with no connection and no default. */
export class UnconnectedInputError extends ProcessError {
  static override readonly code = 'UnconnectedInputError';
}

/**
 * Thrown when a node's `compute` omits a declared output, or when an
 * outlet is read before anything has produced a value for it.
 */
export class MissingOutputError extends ProcessError {
  static override readonly code = 'MissingOutputError';
}
