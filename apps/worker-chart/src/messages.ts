// Messages between the page and the two workers.

/** Socket worker → render worker: one WebSocket message, as columns. */
export interface Batch {
  time: Float64Array;
  price: Float64Array;
  size: Float64Array;
  /** Ticks the server has dropped so far because we fell behind. */
  dropped: number;
  /** Ticks the server sent before this batch. */
  sentSoFar: number;
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
      /**
       * Fixed bucket count: the width in device pixels of the screen the
       * page opened on.
       */
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
      /** Median age in ms of the newest tick, at the end of each frame. */
      delayMs: number;
      dropped: number;
      /** Ticks the server sent that never arrived here (should stay 0). */
      missing: number;
      /**
       * ms this second spent building each batch's TimeSeries, in
       * pushSeries, and folding into buckets.
       */
      seriesMs: number;
      pushMs: number;
      foldMs: number;
      /** Mean ms of JavaScript per frame. */
      frameMs: number;
      /** The canvas's size in device pixels. */
      canvasWidth: number;
      canvasHeight: number;
    }
  | { type: 'hover'; tick: Tick | null };

/** Socket worker → page: the feed has gone. */
export interface FeedClosed {
  type: 'closed';
  code: number;
  reason: string;
}
