// The page: hands the canvas to the render worker, wires the socket worker
// to it, and passes size and pointer changes along. It never sees a tick
// except the one under the pointer.
import type { FromRender, ToRender } from './messages.js';

const params = new URLSearchParams(location.search);
const rate = Number(params.get('rate') ?? 10_000);
const windowSec = Number(params.get('window') ?? 60);

const canvas = document.querySelector('canvas')!;
const tooltip = document.querySelector<HTMLElement>('#tooltip')!;
const status = document.querySelector<HTMLElement>('#status')!;
const work = document.querySelector<HTMLElement>('#work')!;
const busy = document.querySelector<HTMLInputElement>('#busy')!;

const render = new Worker('render-worker.js', { type: 'module' });
const socket = new Worker('socket-worker.js', { type: 'module' });
const toRender = (msg: ToRender, transfer: Transferable[] = []) =>
  render.postMessage(msg, transfer);
// An exception in a worker doesn't reach the page's console handlers, so
// show it.
for (const w of [render, socket]) {
  w.onerror = (e) => {
    status.textContent = `error: ${e.message}`;
  };
}

// The socket worker sends batches straight to the render worker over this
// channel; they never pass through the page.
const feed = new MessageChannel();
const offscreen = canvas.transferControlToOffscreen();
const box = canvas.getBoundingClientRect();
toRender(
  {
    type: 'init',
    canvas: offscreen,
    feed: feed.port2,
    width: box.width,
    height: box.height,
    dpr: devicePixelRatio,
    columns: Math.ceil(screen.width * devicePixelRatio),
    windowMs: windowSec * 1000,
  },
  [offscreen, feed.port2],
);
socket.postMessage(
  {
    url: `ws://${location.host}/stream?rate=${rate}&prefill=${windowSec}`,
    port: feed.port1,
  },
  [feed.port1],
);

// After the transfer the page can't size the canvas's pixels; the worker
// does, from these messages. A ResizeObserver doesn't fire when only the
// pixel ratio changes (the window moved to another screen), so watch that
// too.
const sendSize = () => {
  const { width, height } = canvas.getBoundingClientRect();
  toRender({ type: 'resize', width, height, dpr: devicePixelRatio });
};
new ResizeObserver(sendSize).observe(canvas);
const watchPixelRatio = () =>
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      sendSize();
      watchPixelRatio();
    },
    { once: true },
  );
watchPixelRatio();

let pointer = { x: 0, y: 0 };
canvas.addEventListener('pointermove', (e) => {
  pointer = { x: e.offsetX, y: e.offsetY };
  toRender({ type: 'hover', x: e.offsetX });
});
canvas.addEventListener('pointerleave', () =>
  toRender({ type: 'hover', x: null }),
);

let pageFrames = 0;
let pageFps = 0;
render.onmessage = (ev: MessageEvent<FromRender>) => {
  const msg = ev.data;
  if (msg.type === 'stats') {
    status.textContent =
      `chart ${msg.fps} fps · page ${pageFps} fps · ` +
      `${msg.ticksPerSec.toLocaleString()} ticks/s · ` +
      `${msg.rows.toLocaleString()} ticks held · ` +
      `delay ${Math.round(msg.delayMs)} ms` +
      (msg.dropped ? ` · ${msg.dropped.toLocaleString()} dropped` : '');
    work.textContent =
      `pushSeries ${msg.pushMs.toFixed(1)} ms/s · ` +
      `buckets ${msg.foldMs.toFixed(1)} ms/s · ` +
      `frame ${msg.frameMs.toFixed(2)} ms`;
  } else if (msg.tick === null) {
    tooltip.hidden = true;
  } else {
    const { time, price, size } = msg.tick;
    tooltip.textContent = `${new Date(time).toISOString().slice(11, 23)}  ${price.toFixed(3)} × ${size}`;
    tooltip.style.left = `${pointer.x + 12}px`;
    tooltip.style.top = `${pointer.y + 12}px`;
    tooltip.hidden = false;
  }
};

// Page frame rate, for comparison with the chart's.
const countPageFrames = () => {
  pageFrames++;
  requestAnimationFrame(countPageFrames);
};
requestAnimationFrame(countPageFrames);
setInterval(() => {
  pageFps = pageFrames;
  pageFrames = 0;
}, 1000);

// "Busy page": burn 40 ms of every 50 on the page's thread, like a heavy app.
let burner: number | undefined;
busy.addEventListener('change', () => {
  clearInterval(burner);
  if (busy.checked) {
    burner = setInterval(() => {
      const end = performance.now() + 40;
      while (performance.now() < end);
    }, 50);
  }
});
