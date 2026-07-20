# PND_EXPERIMENTS_PLAN — active experiments detail

> Detail behind the **Active experiments** roster in [PLAN.md](../../PLAN.md).
> Philosophy: CLAUDE.md "Multi-agent experiments and the feedback model".
> Full per-experiment histories (what each drove into the library, milestone
> by milestone):
> [docs/archive/experiments-2026.md](../archive/experiments-2026.md).
> Cross-repo automation contract:
> [docs/notes/constellation-bridge.md](../notes/constellation-bridge.md).

## Where each track is now

- **Tidal** (financial charts; drives `@pond-ts/financial` + adopts
  `@pond-ts/charts`) — the most active loop. Adopted candlesticks +
  trading-time axis cleanly; drives the studies track
  ([PND-STUDY](PND_FINANCIAL_PLAN.md)) and the friction stream (cursor
  grain #484, width-derived ticks #447, …). The charts npm publish
  auto-wakes its adoption agent via the CHANGELOG — keep CHANGELOG entries
  wave-shaped; they're a machine-read payload.
- **estela** (geo + power; drove `@pond-ts/fit`) — `@pond-ts/fit` landed on
  main; estela still consumes its local copy and has **not** adopted the
  shipped value-axis primitives (`scan` / `byValue`). Next: fit first
  publish ([PND-FITPUB](PND_ECOSYSTEM_PLAN.md)), then estela swaps to the
  npm packages (fit + charts) and deletes its local copy. estela is also the
  M5 parity consumer for charts ([PND-PARITY](PND_CHARTS_PLAN.md)).
- **Dashboard** (`pond-ts-dashboard`) — stays involved as the
  React/charting reviewer. Next move: **adopt `@pond-ts/charts`** in place
  of its hand-rolled canvas charts and report gaps + perf vs its own — the
  honest test of whether the package earns its place. Its snapshot-cost
  queue is [PND-GATHER](PND_CORE_PLAN.md).
- **gRPC pipeline** — fully realized for the M3.5 scope; the V5 re-bench ran
  (2026-05-29) and correctly parked the next levers
  ([PND-LROLL](PND_COLUMNAR_PLAN.md) unearned at 2.1× headroom). Remaining:
  the **writeup** and the **M5 extraction sweep** producing three RFC-style
  designs (`@pond-ts/server`, `useRemoteLiveSeries`, `@pond-ts/dev-producer`)
  that feed [PND-SERVER](PND_ECOSYSTEM_PLAN.md).
- **Webapp telemetry** (Codex; trading-platform app) — pond's first
  production deployment (live rolling stats on real frontend telemetry).
  Watch for production friction reports.
- **Charts experiment repo** (`pond-ts-charts-experiment`) — pivoted from
  raw-canvas validation to the first `@pond-ts/charts` package consumer
  (network-traffic dashboard dogfooding the annotation API). Ongoing
  adoption + friction dogfood.
- **CSV-cleaner** — complete (drove the v0.9.x wave); history only.
- **Internal robustness audits** — periodic full-project read-only audits by
  a fresh model targeting internal robustness (the issues experiments route
  around rather than report). Two run so far
  ([2026-06](../notes/technical-audit-2026-06.md),
  [2026-06 v2](../notes/technical-audit-2026-06-v2.md)); **re-run as the
  available model improves.** Open residue: [PND-LIVFIX](PND_LIVE_PLAN.md)
  (P1) and [PND-AUDIT](PND_CORE_PLAN.md) (P2s).

## Queued coordination actions

Deliberate acts, not auto-fired (each summons a consumer agent and spends
budget on the other side of the bridge):

- Open GitHub Discussions for the **living-examples RFC (#285)** and the
  **range-editing RFC (#261)** — Tidal has real consumer positions on both.
