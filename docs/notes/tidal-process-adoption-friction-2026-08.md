# Tidal · process adoption friction — first contact (2026-08)

> _Filed by the Tidal agent (Claude). Context: Tidal moved its derive seam onto
> `@pond-ts/process@0.61.0` (consumer positions: #543 thread + pond#665). These
> two came out of the first real adoption day, both probe-verified against the
> published 0.61.0 dist._

## 1. A raw string input naming an absent column is never validated — and a non-throwing op appends a garbage column, silently

`compile` validates params, arity, and typed inputs — but a string input (a raw
source column name) is not checked against the bound series' schema, at compile
or at pull. Probe: bind a series with columns `[time, x]`, run a plan whose op
reads `'nope'` — the op's `run` executes with `ctx.inputs.input === 'nope'`,
`ctx.series` NOT widened (the column simply isn't there), and whatever the op
returns is appended under the spec's id. `skipped` stays empty; `onError` never
engages. An op that doesn't defensively check its own inputs produces a
plausible-looking column of garbage.

`run.d.ts`'s own words about a nearby case apply: "silent, which is worse than
a throw." The consumer reality: a persisted plan can reference a column the
feed no longer carries — the honest outcomes are *skip* (with a `skipped`
entry) or *throw*, never a value.

**Ask:** validate raw string inputs against the bound schema — at `compile`
(where the graph already holds the series) or at pull before invoking the op.
Tidal's interim: every Tidal op throws on a missing input column, which routes
into `onError: 'skip'`.

## 2. `specId` validates params — identity is coupled to validity, so an invalid persisted spec cannot even be NAMED

`specId` calls `resolveParams`, so computing the id of a spec with a bad param
(`{op:'sma', params:{period:0}}`) throws `ParamError`. But the moments a
consumer most needs an id for an invalid spec are exactly the failure paths: to
label the chip it is skipping, to key the "this spec is broken" UI state, to
log which persisted entry was rejected. Today the consumer must re-implement
canonicalization (the thing `specId` exists to own) or carry a second key.

**Ask:** decouple — e.g. `specId(registry, spec, { validate: false })`
computing over given-params post-sort (defaults still applied where param names
are known), or a separate `specName()` that never throws. Validity stays
`compile`'s job; identity should be total.

Neither blocks the adoption — both have honest consumer-side workarounds — but
both are the kind of edge the RFC said would surface from a real consumer.
