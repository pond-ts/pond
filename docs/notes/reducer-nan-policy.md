# Reducer non-finite (NaN / ±Inf) policy

_Design record. Decision made 2026-06-14; grounds the implementation that
follows. Supersedes the ad-hoc per-reducer behavior that produced the
`aggregate('stdev')` incident (audit v2 §1.1) and the min/max divergence
found during this survey._

## Decision

**A reducer treats a non-finite numeric value (`NaN`, `+Infinity`,
`-Infinity`) exactly as it treats a missing cell: it is skipped.** This holds
**uniformly across every built-in reducer and all four execution paths**
(`reduce`, `reduceColumn`, `bucketState`, `rollingState`).

Rationale: it matches the default a data analyst expects (pandas `skipna`),
fixes every cross-path divergence at once, and is the most robust choice — a
single overflowed cell can't poison a whole bucket's `min` or a window's
`avg`. It also lets the rest of the stack stay simple:

### Three-layer contract

| Layer                                                                                                 | Policy                                  | Why                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Intake** (row API, `mapColumns`)                                                                    | **Strict** — reject non-finite          | User data should be finite; a NaN at the boundary is a bug, caught loud. (Already true.)                                                               |
| **Computed writers** (`cumulative`/`diff`/`rate`/`pctChange`/`collapse`, `Float64Column` direct ctor) | **Permissive** — pack honest non-finite | An overflow on a legitimately huge series, or `Inf−Inf`, is an honest computed result, not a bug. Don't throw. (Resolves #113 — **no builder throw**.) |
| **Reducers**                                                                                          | **Robust** — skip non-finite as missing | Degenerate values are exceptional; ignore them and reduce the valid data.                                                                              |

So non-finite can exist inside a packed column (via the permissive middle
layer) but is invisible to reduction — symmetric with how `undefined`
(validity-clear) already works.

## What this fixes (survey findings)

All reachable because intake is strict but computed writers are permissive, so
a packed `Float64Column` can carry non-finite via `cumulative('sum')` overflow,
`diff`/`rate`/`pctChange` overflow (0-division is already guarded), `collapse`,
or trusted construction. `shift` is safe (relocates only).

| Reducer                                                  | Divergence today                                                                                                         | After                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `min` / `max`                                            | `reduce`/`reduceColumn` use `a<=b?a:b` (position-dependent, returns a wrong extreme on NaN); `bucket`/`rolling` skip NaN | all paths skip → true extreme                                             |
| `difference`                                             | `reduce` poisons to NaN on a leading NaN; `bucket`/`rolling` skip                                                        | all paths skip                                                            |
| `median` / `percentile`                                  | NaN sort-order unspecified; `reduceColumn` `Float64Array.sort` vs NaN-fallback `Array.sort` seam                         | non-finite filtered before sort, all paths                                |
| `sum` / `avg` / `count`                                  | propagate NaN (consistent, but now changes)                                                                              | skip non-finite                                                           |
| `stdev`                                                  | `reduce`/`reduceColumn`/`bucket` unified on Welford; `rolling` still one-pass `sq/n−mean²`+clamp (cancellation)          | NaN: skip; **stability of windowed remove is a separate sub-item, below** |
| `first` / `last` / `keep` / `unique` / `top` / `samples` | skip `undefined`; non-finite numeric leaks through                                                                       | non-finite numeric also skipped                                           |

## Implementation strategy — normalize at the ingestion boundary

Rather than edit the body of every reducer, enforce "non-finite ≡ missing" at
the **one value-ingestion point per path**. The existing skip-`undefined`
logic then does the rest, and uniformity is guaranteed by construction.

1. **`reduce(defined, numeric)`** — at the pre-filter (`aggregateValues`,
   `time-series.ts` ~523): a non-finite numeric cell is excluded from both
   `numeric` **and** `defined` (so `first`/`last`/`keep`/`unique` over a
   numeric column skip it too). Single change, covers every reducer's row path.
2. **`bucketState().add(v)` / `rollingState().add/remove`** — at the feed
   sites (`time-series.ts` ~4753 / ~3117): map a non-finite numeric cell to
   `undefined` before `add`. Every reducer already skips `undefined`, so this
   covers both incremental paths (and the **live layer**, which shares them)
   in one place.
3. **`reduceColumn(col)`** — no single feed site (each reads `col._values`).
   Introduce one shared notion of "valid contributor" = `validity.isDefined(i)
&& Number.isFinite(values[i])` and route every `reduceColumn` through it
   (helper or a `forEachFinite`-style iterator). This is the only per-path
   spot that touches reducer bodies; keep it mechanical and one-line each.

Non-numeric columns are unaffected (no non-finite concept for string/boolean;
`Number.isFinite` only gates numeric cells).

In practice the `reduceColumn` change is a per-element `Number.isFinite` guard
in each numeric reducer's loop (both the validity-bitmap and the no-validity
hot path), plus the `first`/`last` boundary scan in `aggregate-columns.ts`.

## Perf recovery — the `Float64Column.allFinite` flag

The per-element guard taxes the columnar hot path the columnar wave just
optimized (~2× on `min`/`max`, and `count` loses its O(1) `definedCount`
shortcut). Recovered with a column-level **`allFinite`** flag:

- `Float64Column.allFinite` (and `ChunkedFloat64Column.allFinite`) — **default
  `false`**; a wrong `true` would make `reduceColumn` skip the guard and
  silently corrupt the result, so it is set `true` **only where provably
  finite** (a missed `true` is slower, never wrong).
- **Set / derived**: row intake passes `true` (it rejects non-finite, so a
  surviving column is provably finite); `float64ColumnFromArray` data-derives
  it in its existing copy loop (overflow/NaN → `false`); `sliceByRange` /
  `sliceByIndices` / gather / `concatSorted` (AND across chunks) propagate it.
  Builder / ring / `fromEvents` paths stay `false` (they don't validate
  finiteness) — recoverable later by data-deriving in the builder if the
  live-reduce path ever shows up hot.
- **Used by**: each numeric `reduceColumn` branches on `col.allFinite` →
  unguarded pre-policy loop (fast) vs the guarded loop. Restores `min`/`max`
  and `count` to their pre-policy speed; `sum`/`avg`/`stdev`/`median` were
  arithmetic/sort-bound and barely moved either way.

The parity matrix exercises both flag states — a non-finite column built via a
computed writer (`cumulative` overflow) must derive `allFinite = false`, or the
fast path would include the non-finite cell and the test would fail.

## Known sub-item — rolling `stdev` numerical stability

Skipping NaN is orthogonal to the _cancellation_ problem: `rollingState` for
`stdev` keeps a one-pass `Σx²/n − mean²` with a `Math.max(0,…)` clamp, which
loses precision on near-equal large values (the audit-v1.1 failure mode, still
live in the rolling/live path). Welford has no stable O(1) `remove`, so a
windowed-stable variance needs either (a) recompute over the window each step
(kills the rolling perf win), (b) a compensated running sum-of-squares, or
(c) a two-deque / blocked scheme. **Tracked as a distinct item in the rolling
phase** — the NaN policy lands first and does not depend on it.

## Enforcement — the parity matrix (#106)

The durable drift-defense: a generated matrix test — every reducer ×
{`reduce`, `reduceColumn` (packed + chunked), `bucketState`, `rollingState`} ×
{all-finite, NaN, +Inf, −Inf, undefined-interleaved, empty, single} — asserting
all paths agree (and match the documented policy). This both verifies the
policy and prevents the next dual-path drift. The stdev incident and the
min/max find are the proof this is worth a standing harness.

## Sequencing

1. **This policy + parity matrix** (one PR — the correctness keystone).
2. **Rolling `stdev` stability** (separate PR, rolling phase).
3. **3C rolling columnar conversion** (perf phase) — now safe, because the
   numerical + non-finite contract is pinned and matrix-enforced.
