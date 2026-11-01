// The WebAssembly module for browsers and bundlers: fetched and compiled
// with a top-level await, so `import … from '@pond-ts/rs'` resolves once it
// is ready and the API is the same as in Node. Bundlers that understand
// `new URL('…', import.meta.url)` (Vite, webpack 5, Parcel; Rollup with a
// plugin such as @web/rollup-plugin-import-meta-assets) copy the .wasm file
// into the build; with esbuild, copy `pkg/pond_wasm_bg.wasm` to
// `<outdir>/pkg/` yourself.
import init from './pkg/pond_wasm.js';

await init({
  module_or_path: new URL('./pkg/pond_wasm_bg.wasm', import.meta.url),
});

export * from './pkg/pond_wasm.js';
