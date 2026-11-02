// @pond-ts/rs/init in browsers and workers: nothing is loaded until you call
// `await init()`. For a bundler that refuses top-level await, or to fetch the
// .wasm from somewhere else: `await init(url)` (a URL, a Response, bytes or a
// compiled WebAssembly.Module). Use no other export before it resolves.
import loadWasm from './pkg/pond_wasm.js';
import mount from './core.js';

export * from './core.js';
/** pond-rs's version; `undefined` until `init()` has resolved. */
export let version;

let ready;
/** Fetch and instantiate the WebAssembly (once; later calls return the same promise). */
export function init(source) {
  ready ??= loadWasm({
    module_or_path:
      source ?? new URL('./pkg/pond_wasm_bg.wasm', import.meta.url),
  }).then(
    () => {
      version = mount();
    },
    (e) => {
      ready = undefined;
      throw e;
    },
  );
  return ready;
}
