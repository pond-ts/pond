# R5 agent trial: process requests against the Rust engine

The last part of [PND-RUST-R5] step 7: can an agent answer questions by
writing process requests when the Rust engine answers them, as well as when
TypeScript does?

## How it was run (2026-11-21)

- **Task:** [`prompt.txt`](prompt.txt). Four questions about the market
  workload's 2,520 daily bars (`scripts/measure/workloads.mjs`): the
  14-bar RSI on the last bar, a 20-bar realized volatility defined
  precisely (population stdev of log returns × √252 × 100), the share of
  days `close` is above its 50-bar SMA, and the largest one-day fall with
  its date.
- **Tool:** the agent sees no data. It writes a request as JSON and runs
  `ask.sh`, which prints the wire response (`toWire`, without timings) or
  the error. Behind `ask.sh` is either `examples/measure.rs` or
  `scripts/measure/one.mjs`, both in `ask` mode. The agent also has
  `ops.json` (the registry's `describe()`) and `requests.md` (the docs
  site's page on requests).
- **Agents:** 10 fresh Claude subagents (same model), 5 per engine, all
  started at once. Same prompt and files on both sides; nothing in a run
  folder says which engine it talks to.
- **Setup:** [`setup.sh`](setup.sh) makes the folders and keeps the data and
  answers in `.key/`, outside every run folder.
- **Answers:** [`truth.py`](truth.py) computes them with numpy, without
  pond. pond's own answers (both engines) agree.
- **Grading:** [`check.py`](check.py) grades each `answers.json` (to 1e-5,
  since facts carry six significant digits), counts requests and failed
  ones, then **replays every request any agent sent on both engines** and
  lists those whose responses differ.

## Results

|                                 | Rust  | TypeScript |
| ------------------------------- | ----- | ---------- |
| all four answers right          | 5 / 5 | 5 / 5      |
| requests sent, in total         | 10    | 11         |
| requests that failed or skipped | 0     | 1          |

The one failure (TypeScript side) was the agent's: it named a slot `low`,
which is also a source column, and the request was refused. It renamed the
slot and the next request worked.

**The replay found a real bug, in TypeScript.** 21 distinct requests,
replayed on both engines: one differed. A Rust-side agent cross-checked its
volatility by hand with `multiply(lr, lr)`, where `lr` is a computed log
return. Rust answered; TypeScript skipped it with "column name … already
exists in the schema", because it added `lr`'s column to the op's input
series once per role. Fixed in `@pond-ts/process` (`plan/graph.ts`), with a
parity session (`one step feeding both inputs of an op`) that fails without
the fix. After the fix, all 21 requests give identical responses on both
engines.

**What this does not show:** the questions were not hard enough to split
the engines; every agent got every answer, mostly on the first request.
The engines answer every request identically, so a difference in retries
could only come from a difference in responses, and there was none left to
find once the bug above was fixed.

## What the agents found hard (both sides alike)

- **The request page is written for TypeScript.** Nine of ten said
  `requests.md` shows `host.run({...})` calls but never a JSON request, and
  never says `from` names the dataset. They guessed the shape, correctly.
- **`historicalVolatility` does not say how it divides.** All ten had to
  test whether it uses n or n − 1 (it uses n, and returns a decimal) by
  building the figure by hand.
- **Other definitions left out:** `rsi` does not say how its first average
  is seeded; `percentChange` does not say it is already × 100; `extremes`
  does not say which date wins a tie.
- **Fact shapes are undocumented.** Every fold lists `outputs: []` in
  `describe()`, so what a fact holds (`value`/`at`, `min`/`max`,
  `true`/`of`) is learned only by asking.
- **Units mislead after `scale`.** A volatility in percent comes back
  labelled `delta`, a hand-built percent change `ratio`. `scale`'s own
  summary warns of this.
- **Facts are rounded to six significant digits**, and nothing says so.
- **A slot that names a source column refuses the whole request**, even
  under `onError: 'collect'`.

Not a finding: several noted that the response has no `ms`. That is
`ask` mode stripping timings, not the service.

Two agents ran `python3` once to read `ops.json`'s structure, against the
rules; it read only that file.
