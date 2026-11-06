/// <reference lib="webworker" />
// A worker that only receives: it owns the WebSocket and hands each message's
// buffer, without copying, to the drawing thread over a MessagePort. Used to
// test whether a drawing thread that's busy receives more slowly because of
// the WebSocket itself or because the thread is busy (`receiver=worker`).
self.onmessage = (ev: MessageEvent) => {
  const { url, port } = ev.data as { url: string; port: MessagePort };
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (m) => {
    const buf = m.data as ArrayBuffer;
    port.postMessage(buf, [buf]);
  };
};
