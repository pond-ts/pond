// @pond-ts/rs in browsers and workers: fetches the .wasm next to this file
// (bundlers that understand `new URL('…', import.meta.url)` copy it for you)
// with top-level await, so the package is ready as soon as `import` resolves.
import { init } from './init.js';

await init();

export * from './init.js';
