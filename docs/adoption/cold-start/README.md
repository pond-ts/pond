# Cold-start adoption harness

Reproducible harness for [PND-COLDSTART]: fresh headless Claude Code sessions
given one realistic time-series task with no mention of pond, across four
harness arms. Results and write-up per run live in
`docs/notes/cold-start-adoption-<yyyy-mm>.md`; the grader's per-arm JSON is
committed under `results/<date>/`.

**Run it outside the repo** (a session started inside the pond checkout would
inherit CLAUDE.md and know pond): copy this folder somewhere scratch, then:

```sh
cd harness && node gen-data.mjs            # → ../data/latency.csv (deterministic, 201k rows)
# stage arms under ../runs/<A|B|C|D>/ — see the design table in the latest note:
#   A: data only · B: npm i pond-ts + copy docs/agents/USING_POND.md → node_modules/pond-ts/AGENTS.md
#   C: cp -R plugins/pond-ts/skills → .claude/skills/ · D: C + npm i arquero
./run-arm.sh A & ./run-arm.sh B & ./run-arm.sh C & ./run-arm.sh D & wait
node grade.mjs A   # per arm: channel evidence, deps, npm start, p95 values + breach sets vs reference.py
```

`run-arm.sh` uses `--setting-sources project,local` (no user-level context),
`--no-session-persistence`, and caps at 90 turns / $10. It also passes
`--permission-mode bypassPermissions`, which **scopes nothing**: the session
runs unattended with your user's full access to the machine, the arm directory
is merely where it starts. Run it only on a machine or account you would trust
an unattended agent with, or inside a container / sandbox. Requires a
logged-in `claude` CLI (`claude auth status`).
