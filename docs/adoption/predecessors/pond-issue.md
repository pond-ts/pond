Hi — I wrote Pond.js while I was at ESnet, and I'm opening this so anyone who
lands here has a pointer to where the work went.

**Pond.js hasn't had a release since 0.9.0 (November 2019).** The "1.0 alpha"
TypeScript branch the README mentions never shipped. It still gets ~10k npm
downloads a month, and 118 issues are open, so people are clearly still
arriving here.

**The successor is [pond-ts](https://github.com/pond-ts/pond)** — a from-scratch
TypeScript rewrite of the same ideas (typed time series, temporal keys, event
collections, aggregation and rolling pipelines), plus the things Pond.js never
grew: a streaming `LiveSeries` with the same operator vocabulary, per-entity
partitioning, bounded-memory retention, typed columnar storage, and a React
canvas charting package (`@pond-ts/charts`) that succeeds
react-timeseries-charts.

- npm: `pond-ts` · docs: https://pond-ts.org
- Pond.js → pond-ts concept table: https://pond-ts.org/docs/pond-ts/mental-model#coming-from-pondjs
- Benchmarks against pondjs 0.9 (faster on all 54 shared operations, geometric mean ~20×): https://pond-ts.org/docs/reference/benchmarks

It is pre-1.0 and API-stable-ish, MIT, and actively maintained. It is **not**
an ESnet project and I'm not speaking for ESnet — this is the original
author pointing at the continuation.

**Ask for the maintainers:** a one-paragraph note at the top of the README
(I've opened a PR with exactly that), and/or marking this repository archived
with the pointer in the description. Happy to help anyone migrating; issues
on the pond-ts repo are the right place.
