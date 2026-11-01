/// <reference lib="webworker" />
// The worker side: owns the WebSocket, the LiveSeries and the OffscreenCanvas.
// The main thread only receives a stats object once a second.
import { startEngine, type EngineOptions } from './engine.js';

let stop: (() => void) | null = null;
self.onmessage = (ev: MessageEvent) => {
  const { canvas, opts } = ev.data as {
    canvas: OffscreenCanvas;
    opts: EngineOptions;
  };
  stop?.();
  stop = startEngine(canvas, opts, (stats) => self.postMessage(stats));
};
