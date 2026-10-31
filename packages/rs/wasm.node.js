// The WebAssembly module for Node (and Deno, Bun): read and instantiated
// synchronously, so importing @pond-ts/rs needs no await.
import { readFileSync } from 'node:fs';
import { initSync } from './pkg/pond_wasm.js';

initSync({
  module: readFileSync(new URL('./pkg/pond_wasm_bg.wasm', import.meta.url)),
});

export * from './pkg/pond_wasm.js';
