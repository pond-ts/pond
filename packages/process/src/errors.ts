/** Errors thrown by the graph engine. */

/** Base class for every error this package throws. */
export class ProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown by `connect()` when the edge would close a cycle. The graph is
 * kept acyclic by construction rather than detected during evaluation,
 * so a cycle surfaces at the line that wires it, not at some later pull.
 */
export class CycleError extends ProcessError {}

/** Thrown when pulling through an inlet with no connection and no default. */
export class UnconnectedInputError extends ProcessError {}

/**
 * Thrown when a node's `compute` omits a declared output, or when an
 * outlet is read before anything has produced a value for it.
 */
export class MissingOutputError extends ProcessError {}
