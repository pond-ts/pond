import { useLayoutEffect, useRef, type CSSProperties } from 'react';

/**
 * A draw callback. The 2D context it receives is already transformed to device
 * pixels, so draw in **CSS-pixel coordinates** (`0..width`, `0..height`) and it
 * renders crisply at any device-pixel ratio. The context is freshly transformed
 * and cleared before each invocation, and any state the callback sets (alpha,
 * dash, clip, …) is discarded when it returns.
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
 * flash of an unsized or empty canvas. The backing buffer is resized only when
 * its device-pixel size changes (trap #7 in `docs/rfcs/charts.md`). A redraw at
 * the same size therefore resets nothing by itself, so the transform is
 * re-applied and the draw bracketed in `save`/`restore` on every run.
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
    // Assigning `width`/`height` reallocates and clears the backing buffer even
    // to the value it already holds, and `draw` changes on every data update,
    // so assign only a dimension that moved.
    const bufferWidth = Math.round(width * ratio);
    const bufferHeight = Math.round(height * ratio);
    if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
    if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // SSR / headless environments without a 2D backend
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Without a resize nothing resets the context between draws, so this is
    // what stops one draw's state leaking into the next (and a leaked clip
    // would also confine the `clearRect` above).
    ctx.save();
    try {
      draw(ctx, width, height);
    } finally {
      ctx.restore();
    }
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
