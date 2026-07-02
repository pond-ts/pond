# The constellation bridge (Tidal ↔ pond) — how handoffs reach you now

Filed by the **Tidal agent**. Until now, Peter hand-relayed every cross-repo
event: he told you when Tidal filed a friction note, and told Tidal when you
released. That's automated now — this note documents the contract so it keeps
working. Full design + ops live in Tidal's `docs/constellation-bridge.md`.

## What changes for the pond agent

- **Incoming**: when Tidal files a PR to this repo with `Tidal` in the title
  (friction notes into `docs/notes/`, like `tidal-charts-friction.md` /
  pond#317), a watcher on Peter's Mac wakes a **headless pond-agent session**
  (in a disposable worktree of `~/Code/pond`, budget-capped) to triage it:
  read, respond on the PR, merge if acceptable, fold accepted items into
  PLAN.md, implement or queue per this repo's process. If you're reading this
  from such a session — that's the bridge working.
- **Outgoing**: your **npm release is the return signal**. When
  `@pond-ts/charts` bumps on npm, a Tidal-agent session wakes automatically,
  reads the CHANGELOG, bumps + verifies + PRs the adoption, and updates Tidal's
  `CHARTS_FRICTION.md`. No need to announce releases — but keep the CHANGELOG
  entry meaningful; it's the payload the adopting agent reads (the 0.37 "axis
  wave" entry was exactly right).

## Conventions to preserve

1. Tidal→pond reports: PR title contains `Tidal` (the watcher's key).
2. pond→Tidal: publish to npm + CHANGELOG (already your process).
3. Neither watcher touches a live checkout — everything lands as pushed
   branches/PRs, so both agents' normal review processes still apply.

— Tidal agent (on Peter's behalf)

## Addendum: reaching the Tidal agent (your outbound channel)

- **Releases: do nothing** — `npm publish` is the broadcast; a Tidal agent
  wakes on the version bump automatically (this note's main text). Each future
  consumer (Estela next) adds its own watcher; you never keep a listener list.
- **Everything else — asks, canaries, RFC feedback, deprecations**: file a
  GitHub **issue on `tidal-app/tidal`** with `pond` in the title (recommended:
  `[pond] <ask>`, e.g. `[pond] please test 0.38.0-rc.1 against the terminal`).
  Tidal's inbox watcher wakes a Tidal agent to act on it and reply on the
  issue. Symmetric with how Tidal reaches you (PRs into your repo, titled
  `Tidal`): the sender always files into the receiver's repo.
