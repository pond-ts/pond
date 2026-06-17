import { useLayoutEffect, useRef, type CSSProperties } from 'react';

/**
 * A draw callback. The 2D context it receives is already transformed to device
 * pixels, so draw in **CSS-pixel coordinates** (`0..width`, `0..height`) and it
 * renders crisply at any device-pixel ratio. The context is freshly transformed
 * and cleared before each invocation.
 */
export type CanvasDraw = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => void;

export interface CanvasProps {
  /** CSS width in pixels. */
  width: number;
  /** CSS height in pixels. */
  height: number;
  /** Synchronous draw callback, invoked after every (re)size or prop change. */
  draw: CanvasDraw;
  /**
   * Device-pixel-ratio override (defaults to `window.devicePixelRatio || 1`).
   * Exposed so tests can pin a deterministic backing-buffer size; production
   * callers leave it unset.
   */
  dpr?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * The DPR-aware `<canvas>` primitive every chart draw layer sits on. It sizes
 * the backing buffer to `width*dpr × height*dpr`, keeps the CSS box at
 * `width × height`, applies `setTransform(dpr, …)` so the {@link CanvasDraw}
 * callback works in CSS-pixel coordinates, clears, and calls `draw`.
 *
 * Drawing runs in `useLayoutEffect` (synchronous, before paint) so there is no
 * flash of an unsized or empty canvas. Setting `canvas.width`/`height` resets
 * all context state, so the transform is re-applied on every run — see trap #7
 * in `docs/rfcs/charts.md`.
 */
export function Canvas({
  width,
  height,
  draw,
  dpr,
  className,
  style,
}: CanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio =
      dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    // Resizing the backing buffer clears it and resets context state, so this
    // must happen before the transform + draw.
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // SSR / headless environments without a 2D backend
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
  }, [width, height, dpr, draw]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        display: 'block',
        ...style,
      }}
    />
  );
}
