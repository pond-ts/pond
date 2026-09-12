# Cold-start adoption experiment — run 1 (2026-09-12)

**Task:** [PND-COLDSTART] in [PND_ADOPTION_PLAN.md](../plans/PND_ADOPTION_PLAN.md).
**Question:** when a fresh coding agent is handed a realistic time-series job
with no mention of pond, does it choose pond — and through which channel — and
when it does, how well does it use it?

## Design

Four genuinely fresh headless Claude Code sessions (`claude -p`, model
`claude-opus-5`, `--setting-sources project,local` so no user-level context,
no session persistence, permissions bypassed inside an isolated scratch
directory, bounded at 90 turns / $10). Each arm is an otherwise empty
directory containing only `data/latency.csv` and the arm's harness state.
The prompt is identical across arms and never names a library.

| Arm | Harness state                                                                          | Channel under test                        |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| A   | nothing                                                                                | does the agent find pond at all?          |
| B   | `pond-ts@0.67.0` in `package.json`; `node_modules/pond-ts/AGENTS.md` present\*         | the tarball guide, when pond is a dep     |
| C   | the three `plugins/pond-ts` skills as project skills (`.claude/skills/`), nothing else | the installed skill                       |
| D   | arm C's skills **plus** `arquero` already installed; pond not installed                | the skill against an incumbent competitor |

\* `AGENTS.md` does not ship in the 0.67.0 tarball (it lands at the next
publish); it was copied into `node_modules/pond-ts/` to simulate the next
release. Everything else in arm B is the real published package.

**The task** (verbatim prompt in the harness): from `latency.csv` — 201,000
rows, 10 hosts, ~10 s cadence over 2.3 days, ISO-Z timestamps, with 1,000
exact-duplicate rows, one 400-row out-of-order chunk and 223 blank `ms`
cells — produce per-host 5-minute p95 (`out/p95.csv`), a trailing 1-hour
rolling mean/sd with ±2σ bands over that series (`out/baseline.csv`), and the
breaches (`out/breaches.csv` + console summary). TypeScript, Node 20, any
packages or none, justified in `NOTES.md`; `npm install && npm start` must
work. Charting was deliberately left out of this run so the sessions stay
Node-only; the charts skill was installed in C/D but had nothing to trigger
on.

**Reference answer** computed independently (`reference.py`): 6,674 buckets;
per-host breach counts; the three worst breaches. Used to check that each
arm's output is _right_, not just that it ran.

**Measured per arm:** library chosen and the first turn pond is mentioned;
what the agent searched or fetched (`npm search` / `npm view` / `curl` /
WebSearch / WebFetch); whether it read `AGENTS.md` / `API.md` / a skill;
turns, wall time, cost; whether `npm start` runs clean and matches the
reference; API misuses against the guide's pitfall list.

## Results

| Arm | Chose       | How pond entered                                                                                                                               | Turns | Wall  | Cost  | `npm start` | vs reference                                                           |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- | ----- | ----------- | ---------------------------------------------------------------------- |
| A   | **no deps** | never — zero mentions of pond, no `npm search`, no web fetch                                                                                   | 23    | 449 s | $1.95 | ✅          | 6 674 buckets ✅ · 478 breaches (own band convention) · worst-3 differ |
| B   | **pond-ts** | turn 6: "pre-seeded with a `pond-ts` dependency — let me inspect it"; read `AGENTS.md` in full, then the `.d.ts` docs, then four spike scripts | 41    | 526 s | $3.19 | ✅          | 6 674 ✅ · 504 breaches · worst-3 ✅                                   |
| C   | **pond-ts** | turn 7: `pond-ts` skill auto-triggered ("covers exactly this shape of work")                                                                   | 43    | 448 s | $2.80 | ✅          | 6 674 ✅ · **508 ✅** · worst-3 ✅                                     |
| D   | **pond-ts** | turn 6: skill auto-triggered; **removed the pre-installed `arquero`** ("not time-aware, can't express a `(t−1h, t]` window")                   | 36    | 415 s | $2.49 | ✅          | 6 674 ✅ · 504 breaches · worst-3 ✅                                   |

All four produced runnable, self-consistent code. B, C and D used the
reference's conventions (interpolated p95, population sd, trailing window
including the current bucket, bands from the first bucket); the 504-vs-508
gap in B and D is a deliberate `minSamples: 12` warm-up gate on `baseline`
(no band until a full hour of buckets), not an error. A chose and documented
different conventions (nearest-rank p95, sample n−1 sd), so its 478 is not
comparable and is not a correctness verdict either way.

### What the channels did

- **Channel 2 (findable on the open web) did nothing.** No arm ran
  `npm search`, fetched `llms.txt`, or opened a docs URL. Arm A considered
  `csv-parse`, `papaparse`, `d3-array` and `danfojs` — all from memory —
  and chose zero dependencies with a well-argued paragraph. Metadata and
  llms.txt are for agents that already have a reason to look; on this task
  none did. **The measurement that matters for channel 2 is training-data
  prevalence, and it is not something a PR moves.**
- **Channel 3 (harness) is decisive.** Both skill arms chose pond within
  seven turns without pond being installed, and D actively uninstalled a
  competitor to do so. The skill's task-phrased description triggered
  correctly on a prompt that never says "time series library".
- **The tarball `AGENTS.md` works when the agent gets as far as
  `node_modules`.** B read it in full as its first move after seeing the
  dependency, then verified every signature against the `.d.ts` rather than
  trusting the guide — the right behaviour, and the reason the guide now
  names the `.d.ts` paths.
- **Every pond arm wrote idiomatic code:** `as const`, `sort: true` for the
  out-of-order chunk, `dedupe` under `partitionBy` (all three noticed that a
  bare `dedupe` keys on time alone), `aggregate` with `'p95'`, `baseline`.
  Zero instances of the guide's pitfall list. C and B each reimplemented the
  pipeline in plain JS to cross-check pond's numbers, and both matched.
- **Cost of choosing pond: +57 / +78 / +87 % turns (D / B / C vs A) and
  +28 / +64 / +44 % dollars** over hand-rolling, spent almost entirely on
  signature verification (reading `.d.ts`, spike
  scripts). The hand-rolled arm spent that budget on writing and testing a
  rolling window instead. The trade the agents themselves made explicit:
  A's `NOTES.md` argues the maths is "forty lines"; B/C/D's argue the
  trailing-window stdev is "exactly the code that ends up subtly wrong".

### Friction — library-actionable

1. **Partition column vanishes from the static type after `aggregate` or
   `rolling` under `partitionBy`** ([PND-PARTCOL]). Both operators' result
   schema is the key plus the mapping's outputs (`AggregateSchema` /
   `RollingSchema`), and `collect()` re-injects `host` at runtime
   (`augmentMappingWithPartitionCols`) but not in the type, so `e.get('host')`
   is a compile error. All three pond arms handled it: B pre-empted from the
   `.d.ts` docs, C and D hit `TS2345: Argument of type '"host"' is not
assignable to parameter of type '"count" | "p95"'` and converged on the
   same workaround, naming the column in the mapping (`host: 'first'`).
   Three independent agents reaching the same workaround is the signal that
   the type should carry the partition key. (`baseline`, `fill`, `dedupe`,
   `smooth` keep the source columns and are not affected.)
2. **Version written from memory.** C wrote `"pond-ts": "^0.3.0"` into
   `package.json` unprompted, installed a 2024 API, noticed "the installed
   0.3.0 API differs from the skill's description", and reinstalled
   `^0.67.0`. Fixed in the skill and guide (`npm install pond-ts@latest`,
   with the reason).
3. **Type-declaration path guessed.** C grepped `dist/TimeSeries.d.ts`
   (does not exist; it is `dist/batch/time-series.d.ts`) and got zeros
   before finding the real file. Fixed: the skill now names the three
   `.d.ts` files that carry the signatures.

### Friction — not library

- All arms parsed the CSV by hand after inspecting it (no quotes, fixed
  three fields). Reasonable, and not pond's concern.
- No arm used `fromPoints` / `fromColumns`; all built row tuples for
  `fromJSON`. Fine for 200k rows.

### What to change next

- Ship [PND-PARTCOL]; re-run C and D afterwards and expect the `TS2345`
  detour to disappear.
- Re-run with a **chart step** to exercise `pond-charts` and the React
  path; that is where the second-largest surface (and Tidal's friction
  stream) lives.
- Add a **Codex arm** once a headless Codex harness exists — a different
  model is the only way to separate "the skill works" from "Opus reads
  skills well".
- Keep n = 1 per arm until a channel-2 intervention exists worth measuring;
  channel 3 is already at 2/2.
- Commit `grade.mjs` output per arm next run (a few KB each) so the
  per-arm turn / cost / channel evidence is inspectable in review; the raw
  transcripts stay session-local.

## Caveats

- **n = 1 per arm.** One session per arm is a smoke test of the channels,
  not a measurement of a rate. Repeat runs are cheap now that the harness
  exists; the plan is to re-run after each adoption tranche.
- **One model.** `claude-opus-5`. Codex / Gemini arms would need their own
  harness.
- **Arm B's `AGENTS.md` is simulated** (see above).
- **No chart step**, so `pond-charts` and the React path were not exercised.
- The harness is committed at
  [`docs/adoption/cold-start/`](../adoption/cold-start/README.md)
  (`gen-data.mjs`, `TASK.md`, `run-arm.sh`, `grade.mjs`, `reference.py`);
  run it from a copy outside the repo. Transcripts and arm directories stay
  in the session scratchpad.
