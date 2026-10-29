# R3 step 7 agent trial: per-host minute buckets over late events

The R3 agent trial (`docs/plans/PND_RUST_PLAN.md`, R3 step 7): the R1a
setup ([`../README.md`](../README.md)) repeated on a streaming task, with
pond-rs's live layer on one side and plain Rust (standard library only) on
the other. Not polars this time: it works on whole tables and has no way to
push one event and get back the buckets it closed.

## How it was run (2026-10-29)

- **Task:** [`prompt.txt`](prompt.txt), the same text on both sides except
  which library to use. Read CPU readings from 13 hosts in the order they
  arrived (not time order), one at a time as a live system would, and keep
  one-minute buckets per host. Each host has its own watermark (latest time
  seen); a bucket closes once its host's watermark is 5 s past its end;
  an event for a closed bucket (or one that would close at once) is
  ignored; each bucket reports avg, max and count of cpu (missing readings
  not counted). Write the closed buckets in the order they closed, with
  the index of the event that closed each one. The task spells out every
  rule.
- **Data:** [`gen_events.py`](gen_events.py) (fixed seed): 74,181 events
  over 20 minutes. Most arrive within 0.3 s, about 4% 2-12 s late; one
  host goes quiet for three minutes and one starts at minute 10; 3% of
  readings are missing. Near minute boundaries some hosts send an event at
  exactly (bucket end + 5 s) or 1 ms before it, followed by a late event
  1 ms before the bucket's end, so `>=` and `>` in the close rule give
  different answers.
- **Agents:** 20 fresh Claude subagents (same model on both sides), 10 per
  side, all 20 started at once. No web access. Each could read only its own
  folder, plus pond-rs's `src/` and manifest on the pond-rs side.
  [`setup.sh`](setup.sh) built the folders; each build-and-run went through
  the folder's `attempt.sh`, which logs it.
- **Before the trial:** I wrote a solution each way. The pond-rs one
  (about 65 lines) partitions a `Reorder` series by host and runs
  `aggregate_with(part, every 1m, …, Some("5s"))` on each part through
  `apply`; the plain one (about 55 lines) keeps a watermark and a
  `BTreeMap` of open buckets per host. Both came out right first time. The
  reference is pond-ts ([`reference.mjs`](reference.mjs): one
  `LiveAggregation` with `grace: '5s'` per host); an independent Python
  version of the task's rules agrees with it on every row, and three wrong
  readings of the rules (`>` instead of `>=`, one watermark for all hosts,
  not ignoring late events) each give a different answer.
- **Grading:** [`check.py`](check.py), run afterwards; the agents never saw
  it. Header and rows in order; host, start, count and closed_by equal;
  avg and max within 1e-9 relative; empty cells in the same places.
- **Rules check:** every agent's tool calls were scanned afterwards. None
  ran `cargo` other than through `attempt.sh`. None read outside what it
  was allowed, but two (pondrs-05, plain-08) saved a backup of their own
  `main.rs` one folder above the trial and copied it back. Four plain
  agents said they looked at `out.csv` with `head` / `grep` / `wc` though
  the prompt asks them to inspect output only through their program; none
  changed anything after it.

## Results

|                                         | pond-rs   | plain Rust |
| --------------------------------------- | --------- | ---------- |
| right answer                            | **10/10** | **10/10**  |
| values identical to pond-ts, to the bit | 10/10     | 10/10      |
| failed runs in total                    | **0**     | **0**      |
| build-and-runs in total                 | 15        | 17         |
| program length (non-blank lines)        | 80–158    | 84–118     |
| wrote the rules a second time by hand   | 9/10      | n/a        |
| agent time                              | 69–110 s  | 40–62 s    |
| agent tokens                            | 97k–117k  | 71k–75k    |

Per run (`attempt.sh` exit codes, all `0`): pond-rs 02, 06 and 09 ran
twice, 05 three times, the rest once; plain 01, 05 and 10 twice, 08 five
times, the rest once. Every extra run added a check or a print, not a fix.

### What the numbers do not show

- **This task does not separate the two sides.** The task spells out the
  rules exactly (watermark per host, `>=`, skip late events), and written
  out like that they come to a `HashMap` of `BTreeMap`s and about 60 lines
  of plain Rust. Every agent got it right first time on both sides. A task
  whose rules are left for the library to supply (time zones, sessions,
  rolling windows with triggers) is where a library could help; R1a, step
  4b and R2 tested those.
- **pond-rs agents did not trust the library alone.** 9 of 10 also wrote
  the rules a second time in plain Rust inside the same program and
  compared the two outputs (pondrs-05 did it and then removed it). So the
  pond-rs programs are longer, and the agents took longer and used more
  tokens, mostly for that check and for reading `live/mod.rs`,
  `aggregation.rs` and `partition.rs` to confirm the library's close rule
  matches the task. Plain agents had nothing to confirm.
- **Both sides add avg in arrival order,** which is also what pond-ts
  does, so all 20 match pond-ts to the bit. A different adding order would
  differ in the last digit and still pass the grader.
- **No bucket in this data has all its readings missing,** so the
  empty-avg, count-0 output is untested here (several agents said so).
- **The channel-style API arm in the plan was not run.** pond-rs has no
  channel API (the owner-and-handles design was chosen 2026-10-25), so
  that arm would test a library that does not exist; and no agent had
  trouble with handles or `push` returning outputs, so there was nothing
  to compare it against.
- **n = 10 per side.**

## What the agents ran into

**pond-rs** (number of agents out of 10):

1. **10/10: closed buckets do not say which host they belong to.** A
   bucket from a per-partition aggregation carries only its interval and
   the reducer columns, and the series gathered by `apply` mixes every
   host. 9 added a `first` or `keep` reducer on `host` to carry it along;
   pondrs-09 kept a map from aggregation node to partition, filled inside
   the `apply` closure. `partition_outputs` names each partition, but only
   those that exist when it is called, and here hosts appear as data
   arrives. pond-ts behaves the same way (its `apply` output has no
   partition column either).
2. **5/10: the series' grace window and the bucket grace are easy to
   confuse.** A grace window on the series (`LiveOptions::grace_window`)
   also refuses events later than it, which would fail the push for an
   event 6 s late whose bucket is still open; the bucket delay alone is
   `aggregate_with(…, Some("5s"))`. All five found this by reading the
   source; none got it wrong. `aggregate`'s doc comment now says so.
3. **7/10: unsure whether the gathered series needs `Reorder`.** Buckets
   from different hosts close out of time order. The docs say the
   gathered series takes the partitions' ordering; agents set
   `CollectOptions::ordering(Reorder)` anyway to be safe.
4. **3/10: `count` comes back as a number (`f64`),** converted to an
   integer for printing (pond-ts's count is a number too).
5. **2/10: the `apply` closure must return a `NodeId`,** so the typed
   aggregation handle needs `.into()` or `.id()`.
6. **4/10: memory with no retention set.** The root keeps every event
   (and, one noted, each partition and the gathered series keep their own
   copies). Fine at 74k events; they noted it would not suit a
   long-running system without `max_events` / `max_age`.

**plain Rust:** nothing. All 10 used `HashMap` + `BTreeMap::first_key_value`
for oldest-first closing and `div_euclid` for minute starts; two noted
there is no CSV reader in the standard library (the data has no quoting,
so splitting on commas is enough).

## Reproduce

```
python3 gen_events.py events.csv
node reference.mjs events.csv expected.csv     # after npm run build --workspace=pond-ts
./setup.sh <trial-dir> events.csv 10           # then build pond-rs once in one pondrs run
# give each agent its runs/<run>/prompt.txt; then
python3 check.py expected.csv <trial-dir>/runs/<run>/out.csv
```
