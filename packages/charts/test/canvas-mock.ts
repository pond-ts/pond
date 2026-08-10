/**
 * A recording 2D-context test double. `happy-dom` (and `jsdom`) ship no real
 * canvas backend, so unit tests can't read pixels — but they *can* assert the
 * **sequence of draw operations** a component issues (e.g. a gap must emit
 * `moveTo`, not `lineTo`). This records every method call and property
 * assignment so tests can make those assertions without a browser.
 *
 * Pixel-level correctness is the job of the Playwright visual-regression layer
 * (`e2e/`), not this mock.
 */

/** One recorded interaction with the context. */
export interface CtxCall {
  /** `'call'` for a method invocation, `'set'` for a property assignment. */
  type: 'call' | 'set';
  /** Method or property name. */
  name: string;
  /** Call arguments, or `[value]` for a property set. */
  args: unknown[];
}

export interface RecordingContext {
  /** Append-only log of every call/set, in order. */
  calls: CtxCall[];
  /** The proxied context to hand to the code under test. */
  ctx: CanvasRenderingContext2D;
}

/**
 * The `DOMException` a real canvas throws for an out-of-range argument. The two
 * gradient entry points below are the ones this package can actually reach with
 * a bad value, and they are **specified** to throw rather than no-op:
 *
 * - `createLinearGradient(x0, y0, x1, y1)` — throws if any coordinate is
 *   non-finite;
 * - `addColorStop(offset, color)` — throws if the offset is non-finite or
 *   outside `[0, 1]`.
 *
 * This mock used to stub both unconditionally, and that is not a neutral
 * simplification — it made the mock *more forgiving than the platform*, so a
 * defect that crashes every real browser rendered as a clean green suite. It
 * hid exactly that: an `AreaChart` on a log axis whose data touched zero
 * scaled its extent to `NaN` and called `createLinearGradient(0, NaN, 0, NaN)`.
 * A test double may be less capable than the real thing; it must not be more
 * permissive, or the tests stop being evidence.
 */
function indexSizeError(method: string, detail: string): Error {
  const err = new Error(
    `Failed to execute '${method}' on 'CanvasRenderingContext2D': ${detail}`,
  );
  err.name = 'IndexSizeError';
  return err;
}

/**
 * Build a recording 2D context. Any method call is logged and returns
 * `undefined` (except `measureText`, which returns a minimal `{ width: 0 }` so
 * text-measuring code doesn't crash); any property assignment is logged and
 * stored so a subsequent read returns it.
 *
 * The gradient factories additionally **enforce the platform's argument
 * validation** (see {@link indexSizeError}) — the one place this double is
 * deliberately strict rather than permissive.
 */
export function recordingContext(): RecordingContext {
  const calls: CtxCall[] = [];
  const store: Record<string, unknown> = {};
  const ctx = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({ type: 'call', name: prop, args });
        if (prop === 'measureText') return { width: 0 };
        // A minimal gradient so fill code (`AreaChart`) can chain
        // `addColorStop` without crashing; the call itself is still recorded.
        if (
          prop === 'createLinearGradient' ||
          prop === 'createRadialGradient'
        ) {
          if (!args.every((a) => Number.isFinite(a))) {
            throw indexSizeError(
              prop,
              `The provided double value is non-finite (${args.join(', ')}).`,
            );
          }
          return {
            addColorStop: (offset: number, color: string) => {
              if (!(offset >= 0 && offset <= 1)) {
                throw indexSizeError(
                  'addColorStop',
                  `The provided value (${offset}) is outside the range [0, 1].`,
                );
              }
              void color;
            },
          };
        }
        return undefined;
      };
    },
    set(target, prop: string, value: unknown) {
      calls.push({ type: 'set', name: prop, args: [value] });
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { calls, ctx };
}

/**
 * Install a {@link recordingContext} as the result of
 * `HTMLCanvasElement.prototype.getContext('2d')` for the duration of a test.
 * Returns the call log plus a `restore()` to put the original method back —
 * call it in a `finally` / `afterEach`.
 */
export function stubCanvasContext(): { calls: CtxCall[]; restore: () => void } {
  const rec = recordingContext();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(
    contextId: string,
  ): RenderingContext | null {
    return contextId === '2d' ? rec.ctx : null;
  } as typeof HTMLCanvasElement.prototype.getContext;
  return {
    calls: rec.calls,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

/**
 * The **radii of every `arc` drawn while `fillStyle` was `color`** — how a
 * state-coloured mark is counted once a state changes the mark itself rather
 * than adding a ring beside it.
 *
 * Counting `arc` ops alone stopped answering the question when `theme.scatter`
 * gained its `states` ladder: a live point is no longer "the base mark plus a
 * highlight ring" (two arcs) but *one* mark drawn in a different colour at a
 * different size, so the arc total is the same whatever is selected. What
 * distinguishes the state is the fill — and, for hover, the radius — which is
 * what this returns.
 *
 * Attribution is on the **`fill`** op, not the `arc` — the two passes order
 * them differently (the base pass arcs then sets its colour; the ladder's
 * second pass sets the colour once and then arcs), and "what colour did this
 * disc come out" is only answerable at the fill. Reading it off the `arc`
 * silently credits each base-pass mark to its predecessor's colour.
 */
export function arcsFilled(calls: readonly CtxCall[], color: string): number[] {
  const out: number[] = [];
  let fill: unknown;
  let pending: number | null = null;
  for (const c of calls) {
    if (c.type === 'set' && c.name === 'fillStyle') fill = c.args[0];
    else if (c.type === 'call' && c.name === 'arc')
      pending = c.args[2] as number;
    else if (c.type === 'call' && c.name === 'fill') {
      if (pending !== null && fill === color) out.push(pending);
      pending = null;
    }
  }
  return out;
}
