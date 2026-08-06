import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The Gallery's shared autoplay clock (gallery plan §2a).
 *
 * A page of ~28 self-playing chart previews is a real cost, so the three
 * constraints are structural rather than per-card discipline:
 *
 * 1. **One driver.** A single module-level `requestAnimationFrame` loop ticks
 *    every subscriber; it starts on the first subscription and stops on the
 *    last unsubscribe. Twenty-eight cards ⇒ one loop, not twenty-eight.
 * 2. **Only what's on screen animates.** {@link useAutoplayPhase} subscribes
 *    through an `IntersectionObserver` and unsubscribes when the card leaves
 *    the viewport, holding its last frame.
 * 3. **`prefers-reduced-motion` wins.** With it set nothing subscribes at all
 *    and the card renders a fixed, deliberately-chosen frame.
 *
 * The clock is *shared*, not per-card: subscribers get the same monotonically
 * increasing elapsed-ms value and derive their own phase from their own
 * period. A card that pauses off-screen therefore resumes at wherever the
 * shared clock now is rather than where it stopped — which is what you want,
 * since the first frame the reader sees is the first frame they see.
 */

type Subscriber = (elapsedMs: number) => void;

const subscribers = new Set<Subscriber>();
let frame = 0;
let origin = 0;

function tick(now: number): void {
  if (origin === 0) origin = now;
  const elapsed = now - origin;
  // Copy before iterating: a subscriber's state update can unmount a card,
  // which unsubscribes mid-iteration.
  for (const fn of [...subscribers]) fn(elapsed);
  frame = subscribers.size > 0 ? requestAnimationFrame(tick) : 0;
}

/** Subscribe to the shared clock; returns the unsubscribe. */
function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  if (frame === 0) frame = requestAnimationFrame(tick);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

/** How a card animates. Passed to `<GalleryCard autoplay>`. */
export interface AutoplayOptions {
  /**
   * Loop length in ms — one full sweep of `phase` from 0 to 1. Slower than
   * feels right in isolation is usually correct here: a grid of previews all
   * moving at speed reads as noise. 6000–12000 is the useful band.
   */
  period: number;
  /**
   * The frame to hold when motion is off — `prefers-reduced-motion`, and the
   * pre-hydration/first paint. **Pick the most interesting frame**, not 0: a
   * static card is the whole experience for a reduced-motion reader. 0–1,
   * default `0.6`.
   */
  staticPhase?: number;
  /**
   * Frame-rate cap. A mini preview doesn't need 60 fps and the page has
   * dozens of them, so the default is `24` — enough for a scrolling window to
   * read as motion, a ~2.5× saving on redraws.
   */
  fps?: number;
}

/** Live `prefers-reduced-motion`, re-read when the OS setting changes. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return reduced;
}

/**
 * The loop phase (0–1) for one card, gated on visibility and reduced motion.
 *
 * `ref` is the element watched by the `IntersectionObserver` — normally the
 * card's chart stage. Passing `options` as `undefined` opts the card out of
 * animation entirely (it never subscribes, and the phase stays `0`), which is
 * how the non-animated cards keep working unchanged.
 */
export function useAutoplayPhase(
  ref: RefObject<Element | null>,
  options?: AutoplayOptions,
): number {
  const reduced = usePrefersReducedMotion();
  // Destructured to primitives so an inline `autoplay={{ period: 8000 }}`
  // literal — a new object every render — doesn't re-subscribe the observer
  // on every render.
  const enabled = options !== undefined;
  const period = options?.period ?? 0;
  const staticPhase = options?.staticPhase ?? 0.6;
  const fps = options?.fps ?? 24;
  const [phase, setPhase] = useState(enabled ? staticPhase : 0);

  // The last emitted frame index, so the fps cap can skip a setState rather
  // than re-render at the display's refresh rate.
  const lastFrame = useRef(-1);

  useEffect(() => {
    if (!enabled || reduced || period <= 0) {
      setPhase(enabled ? staticPhase : 0);
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    let unsubscribe: (() => void) | null = null;
    const start = () => {
      if (unsubscribe) return;
      unsubscribe = subscribe((elapsed) => {
        const f = Math.floor((elapsed * fps) / 1000);
        if (f === lastFrame.current) return;
        lastFrame.current = f;
        setPhase((elapsed % period) / period);
      });
    };
    const stop = () => {
      unsubscribe?.();
      unsubscribe = null;
    };

    const observer = new IntersectionObserver(
      ([entry]) => (entry?.isIntersecting ? start() : stop()),
      // A little margin so a card is already moving by the time it's properly
      // in view, rather than visibly starting at the viewport edge.
      { rootMargin: '96px 0px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [ref, enabled, reduced, period, staticPhase, fps]);

  return phase;
}

/**
 * A `span`-wide window sweeping across `[begin, end]` at `phase` — the
 * commonest card motion, and the reason `phase` exists. Feed the result
 * straight to `<ChartContainer range>`.
 *
 * ```tsx
 * {(width, phase) => (
 *   <ChartContainer range={scanWindow(t0, t1, 30 * 60_000, phase)} … />
 * )}
 * ```
 *
 * Sweeps **out and back** by default (`'pingpong'`), because a wrapping
 * window jump-cuts from the right edge back to the left once a loop — which
 * is the one motion that reads as a glitch rather than as animation. Use
 * `'wrap'` when the data itself is cyclic and the seam is invisible.
 *
 * A `span` at or past the full extent returns the whole range unchanged.
 */
export function scanWindow(
  begin: number,
  end: number,
  span: number,
  phase: number,
  mode: 'pingpong' | 'wrap' = 'pingpong',
): [number, number] {
  const travel = end - begin - span;
  if (travel <= 0) return [begin, end];
  const t = mode === 'wrap' ? phase : phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const from = begin + travel * t;
  return [from, from + span];
}
