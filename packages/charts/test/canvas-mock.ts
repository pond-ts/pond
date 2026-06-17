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
 * Build a recording 2D context. Any method call is logged and returns
 * `undefined` (except `measureText`, which returns a minimal `{ width: 0 }` so
 * text-measuring code doesn't crash); any property assignment is logged and
 * stored so a subsequent read returns it.
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
