/**
 * @internal Are we in a development build? — the guard every dev-only
 * `console.warn` in this package sits behind, so the message is stripped from
 * a production bundle by the same `process.env.NODE_ENV` substitution every
 * bundler already performs.
 *
 * The **declaration** is the point of this module. `@pond-ts/charts` is a
 * browser package: its `tsconfig` pulls in no `@types/node`, and a bare
 * `process.env.NODE_ENV` reference typechecks only by accident, when a tool
 * happens to resolve node's ambient types from a parent `node_modules`. Run
 * the same tsconfig from somewhere that doesn't — the docs site runs TypeDoc
 * over it from `website/` — and it fails with `TS2591: Cannot find name
 * 'process'`, which took out the docs build when the log axis landed. One
 * local declaration, matching the shape actually read, and the package no
 * longer depends on ambient node types at all.
 *
 * `typeof process` is guarded because a plain `<script type="module">` in a
 * browser has no such global and an unguarded read would throw at import time.
 */
declare const process:
  | { readonly env?: { readonly NODE_ENV?: string } }
  | undefined;

export const isDev: boolean =
  typeof process === 'undefined' || process?.env?.NODE_ENV !== 'production';
