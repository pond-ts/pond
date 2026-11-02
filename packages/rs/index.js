// @pond-ts/rs for Node (the `node` export condition, which Bun and Deno
// also take; untested there): the WebAssembly is read from disk and
// compiled at import, so the package is ready as soon as `import` returns.
import { readFileSync } from 'node:fs';
import { initSync } from './pkg/pond_wasm.js';
import mount from './core.js';

initSync({
  module: readFileSync(new URL('./pkg/pond_wasm_bg.wasm', import.meta.url)),
});

export * from './core.js';
export const version = mount();

/** Already done in Node. For code that also runs where `@pond-ts/rs/init` is the browser build. */
export async function init() {}
