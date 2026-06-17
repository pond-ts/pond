'use strict';

// @pond-ts/charts ships as ES modules only. This stub is the `require` target
// in the package's `exports` map so that CommonJS consumers get a clear,
// actionable error instead of Node's cryptic `ERR_PACKAGE_PATH_NOT_EXPORTED`.
//
// It is copied verbatim into `dist/` during `prepack` (see package.json) so it
// rides along in the published tarball; the source of truth lives at the
// package root and is never touched by `tsc`.

throw new Error(
  '@pond-ts/charts is an ES module package and cannot be loaded with ' +
    "require(). Use `import { ChartContainer } from '@pond-ts/charts'` instead, " +
    "or a dynamic `await import('@pond-ts/charts')` from CommonJS. See " +
    'https://nodejs.org/api/esm.html.',
);
