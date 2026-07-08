# @pond-ts/financial

Financial-market domain library built on [pond-ts](https://www.npmjs.com/package/pond-ts).

A toolkit of market-analytics primitives over pond's time-series core — the
financial counterpart of [`@pond-ts/fit`](https://www.npmjs.com/package/@pond-ts/fit).
Pure computation: browser + Node, no data fetching, no rendering, and **no
React** (chart integration lives in `@pond-ts/charts`).

## Status

Early. The first inhabitant is the **trading-calendar** engine — the disjoint
time-axis substrate from the [trading-calendar RFC](https://github.com/pjm17971/pond-ts/blob/main/docs/rfcs/trading-calendar.md)
(Phase 1: the calendar / session model and its bucketing seam). The market
indicator corpus ([assessment](https://github.com/pjm17971/pond-ts/blob/main/docs/notes/financial-indicators-assessment-2026-07.md))
follows on the same substrate.

## The discontinuity provider

The axis primitive is a d3fc-style five-method **`DiscontinuityProvider`** —
`clampUp` / `clampDown` / `distance` / `offset` / `copy` — operating on epoch-ms
domain values with configured ranges (closed-market time) excised. A
`@pond-ts/charts` trading-time scale consumes this surface structurally
(no package coupling). `weekendSkip()` is the bundled reference provider;
maintained exchange-calendar data is **bring-your-own** (see the RFC).

```ts
import { weekendSkip } from '@pond-ts/financial';

const wk = weekendSkip(); // UTC weekends removed from the axis
wk.distance(friNoon, monNoon); // live ms between — the weekend is not counted
```
