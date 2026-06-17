# Charts M1 — friction notes

**Milestone:** `@pond-ts/charts` M1 (rendering spine — `ChartContainer` /
`ChartRow` / `LineChart` + `fromTimeSeries`).
**Date:** 2026-06-17.
**Context:** First real consumer of pond-ts's public column API _from inside a
bundled browser app_ (Storybook + Vite production build). The chart-extraction
spike (`chart-spike-friction.md`) measured the columnar read path in **Node**;
this is the first time it ran through a **Rollup production bundle**, and that
surfaced a significant issue the Node path never could.

## F-1 (HIGH) — augmented column-API methods are tree-shaken out of browser bundles

**Symptom.** `col.toFloat64Array is not a function`, thrown at runtime in the
Storybook (Vite/Rollup) production build. The same code works in Node / vitest.

**Root cause.** pond-ts mounts the column-API methods (`toFloat64Array`, `at`,
`slice`, the scalar reductions `min`/`max`/`mean`/…, `bin`) onto the column
class _prototypes_ via a **side-effect import** in `dist/index.js`:

```js
import './column.js'; // Step-8b: mounts methods onto Float64Column.prototype, …
```

`packages/core/package.json` declares `"sideEffects": ["./dist/column.js"]` to
protect this. **It is not enough** — bundling `@pond-ts/charts` (which imports
`pond-ts`) with Storybook's Rollup build drops `dist/column.js` anyway. Verified
against the built bundle: the **call site** survives (`col.toFloat64Array()`
appears once, in the bundled `fromTimeSeries`) but the **definition**
(`Float64Column.prototype.toFloat64Array = …`) is absent — the side-effect
module was eliminated.

**Impact — broad, not charts-specific.** Any consumer that bundles pond-ts for
the browser (estela, the dashboard, the chart-experiment) and calls a
prototype-augmented column method hits this. It silently passes Node tests and
throws only in the bundled app. The columnar **performance thesis** for charts
(the spike's ~9× typed-array read win — **measured in Node, not through a
bundle**; the in-bundle delta is unquantified and a charts perf check is still
owed) is blocked until the bulk readers are reachable in a bundle.

**M1 workaround (shipped).** `fromTimeSeries` reads values with `col.read(i)` —
a method on the column _class_ (part of the class definition, never
tree-shakeable) — instead of the bulk `toFloat64Array()`. `read(i)` returns
`undefined` for missing cells, which we map to `NaN` (the gap signal). Correct
and bundle-safe, but **per-element** (method dispatch per row) rather than the
bulk typed-array copy — i.e. it forfeits the columnar throughput win at large N.

**Proposed core fix (priority).** Candidates, roughly in increasing robustness:

1. **Repair the `sideEffects` matching.** Investigate why Rollup drops
   `./dist/column.js` despite the declaration when pond-ts is a nested
   dependency. A glob form (`"**/dist/column.js"`) or build-config change may be
   enough. Add a bundler-level regression test (a tiny Vite build that imports a
   column method and asserts it's defined) — Node tests cannot catch this class
   of bug.
2. **Define the methods on the class.** Move the augmentation off the prototype
   side-effect and onto the class declarations directly, so the methods are
   part of the type's definition and can never be tree-shaken. This is the
   structural fix; it costs re-introducing the reducer/columnar layering the
   Step-8b design deliberately split (the `series-store` purity test enforces
   that boundary), so it needs a design pass.
3. **Hybrid** — class-level `toFloat64Array` + keep the heavier reductions
   augmented.

Once a fix lands, restore the bulk path in `fromTimeSeries`
(`TODO(charts-perf)`), and add a charts perf check (M1 currently has none — the
read path is the floor, not the ceiling).

## F-2 (LOW, latent until F-1) — `toFloat64Array()` writes 0, not NaN, for missing

When the bulk path is restored, note that `toFloat64Array()` writes **`0`** for
a missing cell and tracks missingness separately in the validity bitmap, so the
adapter must NaN-fill from `col.validity.isDefined(i)` (or the inlined
`bits[i>>3] & (1<<(i&7))`) to get the gap signal. A core
`toFloat64Array({ missingAsNaN: true })` (or a `column.toNaNFilled()`) would
save every chart/SVG adapter that loop — the gap-as-NaN convention is what every
renderer wants. (`read(i)` already encapsulates this, which is a secondary
reason the M1 workaround is clean.)

## F-3 (LOW) — `TimeSeries.column()` types its result as non-`undefined`

`series.column(name)` returns `undefined` at runtime for an unknown name (the
adapter relies on this for its "unknown column" error), but core's **public
overload types the result as non-`undefined`** — the `| undefined` impl
signature is stripped from the `.d.ts`. So a caller's `col === undefined` guard
reads as dead code to TS while being runtime-necessary; worse, a caller who
*trusts* the type and skips the guard gets a latent `undefined` deref. Minor
soundness gap; the fix is to widen the public overload to `… | undefined`.
Charts keeps an explicit runtime guard regardless.

## What worked

- `series.keyColumn().begin` (the time axis) and the `series.column(name)` +
  `col.kind` discriminator are clean and bundle-safe (plain class members).
- The columnar substrate's separation of value vs validity is the right model;
  the only gap is the _bulk reader_ reachability (F-1) and the NaN convention
  (F-2).
- `d3-scale` slotted in without friction for the linear x/y mapping.
