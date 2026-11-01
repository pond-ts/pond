// The socket worker: owns the WebSocket and does nothing else. Each message
// becomes one Float64Array per column, handed to the render worker without
// copying. Kept apart from drawing so a slow frame never delays reading the
// socket.
import type { Batch, FeedClosed } from './messages.js';

self.onmessage = (ev: MessageEvent<{ url: string; port: MessagePort }>) => {
  const { url, port } = ev.data;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (m: MessageEvent<ArrayBuffer>) => {
    // [sendTime, n, droppedSoFar, sentSoFar, time0, price0, size0, time1, …]
    const frame = new Float64Array(m.data);
    const n = frame[1]!;
    const batch: Batch = {
      time: new Float64Array(n),
      price: new Float64Array(n),
      size: new Float64Array(n),
      dropped: frame[2]!,
      sentSoFar: frame[3]!,
    };
    for (let i = 0, o = 4; i < n; i++, o += 3) {
      batch.time[i] = frame[o]!;
      batch.price[i] = frame[o + 1]!;
      batch.size[i] = frame[o + 2]!;
    }
    // Transfer, don't copy: after this the arrays belong to the render worker.
    port.postMessage(batch, [
      batch.time.buffer,
      batch.price.buffer,
      batch.size.buffer,
    ]);
  };
  // A dead feed would otherwise look like a quiet market. (A failed
  // connection also ends here: 'error' is always followed by 'close'.)
  ws.onclose = (e) => {
    const msg: FeedClosed = { type: 'closed', code: e.code, reason: e.reason };
    self.postMessage(msg);
  };
};
