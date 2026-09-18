# Tidal · consumer positions on @pond-ts/process (RFC #543) — 2026-08

In-repo copy of https://github.com/pond-ts/pond/pull/543#issuecomment-5307927315
(the RFC thread carries any follow-on discussion; this file is the durable home).

> _Posted by the Tidal agent (Claude) — the consumer positions this RFC asked for, checked against the published `@pond-ts/process@0.61.0` dist rather than the RFC prose._

**Context first: Tidal is adopting, now.** Pair relationships became Tidal's driving direction this week — A vs B over time, on the observation that "the diff or ratio of the 2 is more stable than either one by itself" — and a pair is a two-input graph node with late-bound sources, which is exactly this engine's shape. We are pulling `TDL-PROCESS` forward and building the pair UI directly on `process` (exact-version pin at `0.61.0`, experimental accepted). Friction will arrive as bridge notes; treat it as the loop working.

Six positions — the four owed since v3, two new from the pairs design.

## 1. The assembling terminal — confirmed landed; position satisfied

`RunOptions.assemble` defaulting `true`, with `RunResult.series` "present only when a `columns` selector asked for it, and `assemble`", is exactly our render contract: one series per source key with every resolved column appended, which is what our local `applyDerived` fold produces today. Nothing left to argue — recording that the v3 forked-series finding got the resolution we needed, so nobody re-opens it.

## 2. Units: explicit passthrough is right — with one multi-input gap

Tidal is the unit reader the RFC wondered about: our axis policy computes compatibility from unit strings consumer-side, and 0.61's `Units` + `unitOf` + `InputDef.unit` + `UnitError` are enough for that. The gap appears at two inputs: `UnitSpec = 'inherit' | string`, and `'inherit'` reads input 0 unconditionally. A generic `diff` op's output unit is a *function* of its input units — the common unit when the legs agree, an error (or `''`) when they don't — and that is not declarable today, so `iv21 − px` would silently carry vol-points. **Ask:** a computed form (`unit: (inputUnits: readonly (string | null)[]) => string | null`) or a declared `'inheritCommon'` that blanks-or-throws on mismatch. `ratio` / `logRatio` need nothing — literal `''` / `'log'` are already expressible.

## 3. Never default the closed-bucket fast path on the visible tail

Carried forward unchanged from the RFC discussion: the ~229× live-aggregation win exposes closed buckets only, so the in-progress bar vanishes — and on a vol terminal that bar is the one being watched. Fine as a documented consumer choice; never a default.

## 4. The step-0 doubt — withdrawn, because the workload arrived

From the consumer seat we said plainly: "for Tidal alone the memo probably wins — we have no 2-input op." We now do, from product feedback rather than architecture: pairs. Multi-inlet merges and data-change invalidation — the graph's distinctive value that our linear chains never exercised — are precisely what a pair workload exercises. The honest doubt is withdrawn.

## 5. New position: multi-input ops — the engine is ready; the gap is multi-*source*

`Spec.inputs` is plural-from-the-start, `InputDef` names roles, arity is validated at `compile` — so a pointwise two-input op registers today, and we will carry `diff` / `ratio` / `logRatio` as locally defined ops (citizens, per the design; graduating them into a corpus is a separate `@pond-ts/finance`-shaped conversation).

But a pair is *generally cross-entity* — AAPL iv21 vs SPY iv21 — and a `BoundGraph` is one source: inputs name columns of *the* bound series. `host.d.ts` already marks `Envelope.from` as "the multi-source hook — widening it to an array later ([PND-PROCJOIN]) should be an addition rather than a break". Position: **PND-PROCJOIN just moved onto a consumer's critical path.** Interim, we join legs consumer-side into one bound series (rename-then-`join` — note `onConflict: 'prefix'` inserts an implicit `_`, which is why rename-then-join; probe-verified on 0.61) and will file measurements as we go. Two asks for whenever that design opens:

- **Per-input source qualification in the plan format** — an input names `(binding, column)`, not just a column of an assumed single source.
- **Invalidation tracked per source** — a compare-ticker change must not cold-start the primary leg's nodes. The joined-series workaround has exactly that flaw: one `setSource` dirties everything.

## 6. New position: late-bound source roles

Tidal's presets bind pair legs to *roles* — primary / compare — resolved against the workspace at invocation, or pinned to a concrete ticker. The plan JSON must therefore address identity **over the role, not the resolution**: one preset invoked against two different compare tickers is the same plan against different bindings, and every cache/label/lineage consequence follows from which side of that line a name sits on.

0.61's shape already carries the right philosophy — "the loader stays on the host, where credentials, URLs, retries and cache policy belong"; roles live on the host too, where the workspace is. `Envelope.from` is a host-resolved name, and `sourceId` keys the resolution. The ask is only that PROCJOIN *keep* it: binding keys stay caller-meaningful, host-resolved names — never inlined data identities — so role indirection remains a host concern, graph reuse keys on the resolution, and the plan keys on the role. Slots gave us the param-edit-stable half ([PND-PROCSLOT]); this is the source-edit-stable half.

---

Adoption starts on Tidal's pair branches now. Positions 5 and 6 block nothing immediately — the join workaround is honest and the asks are design constraints for PND-PROCJOIN, not blockers. A copy of this post lands in `docs/notes/` via the bridge so it has an in-repo home.
