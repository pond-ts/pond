// Messages between the page and the two workers.

/** Socket worker → render worker: one WebSocket message, as columns. */
export interface Batch {
  time: Float64Array;
  price: Float64Array;
  size: Float64Array;
  /** Ticks the server has dropped so far because we fell behind. */
  dropped: number;
}

/** Page → render worker. Sizes are CSS pixels. */
export type ToRender =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      feed: MessagePort;
      width: number;
      height: number;
      dpr: number;
      /** Fixed bucket count: the screen's width in device pixels. */
      columns: number;
      windowMs: number;
    }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'hover'; x: number | null };

export interface Tick {
  time: number;
  price: number;
  size: number;
}

/** Render worker → page. */
export type FromRender =
  | {
      type: 'stats';
      fps: number;
      ticksPerSec: number;
      rows: number;
      /** Median ms from a tick's time to the end of the frame that drew it. */
      delayMs: number;
      dropped: number;
      /** ms this second spent in pushSeries, and folding into buckets. */
      pushMs: number;
      foldMs: number;
      /** Mean ms of JavaScript per frame. */
      frameMs: number;
    }
  | { type: 'hover'; tick: Tick | null };
