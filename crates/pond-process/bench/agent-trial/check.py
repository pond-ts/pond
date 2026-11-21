"""Grades a trial: `python3 check.py <out-dir>`, run after the agents finish.

For each run: which answers match truth.json (numbers to 1e-5 relative, as
the service rounds facts to six significant digits; the date exactly), how
many requests it sent, and how many came back with an error or a skipped
entry. Then every request any agent sent is replayed on BOTH engines, and
any request whose two responses differ is listed: real requests from real
agents, as a parity check the fixtures did not write.
"""
import json
import subprocess
import sys
from pathlib import Path

out = Path(sys.argv[1])
key = out / ".key"
truth = json.loads((key / "truth.json").read_text())
sides = json.loads((key / "sides.json").read_text())
repo = Path(__file__).resolve().parents[4]
engines = {
    "rust": [str(repo / "target/release/examples/measure"), "market", "2520", "ask"],
    "typescript": ["node", str(repo / "packages/financial/scripts/measure/one.mjs"),
                   "market", "2520", "ask"],
}


def close(a, b):
    return isinstance(a, (int, float)) and abs(a - b) <= 1e-5 * max(1.0, abs(b))


def grade(answers):
    try:
        q4 = answers["q4"]
        return {
            "q1": close(answers["q1"], truth["q1"]),
            "q2": close(answers["q2"], truth["q2"]),
            "q3": close(answers["q3"], truth["q3"]),
            "q4": close(q4["percent"], truth["q4"]["percent"])
            and q4["date"] == truth["q4"]["date"],
        }
    except (KeyError, TypeError):
        return None


def failed(response):
    try:
        r = json.loads(response)
    except json.JSONDecodeError:
        return True
    return "error" in r or bool(r.get("skipped"))


rows, requests = [], []
for run in sorted(p for p in out.iterdir() if p.is_dir() and not p.name.startswith(".")):
    calls = [json.loads(line) for line in (run / ".calls.jsonl").read_text().splitlines()] \
        if (run / ".calls.jsonl").exists() else []
    requests += [c["request"] for c in calls]
    answers = run / "answers.json"
    graded = grade(json.loads(answers.read_text())) if answers.exists() else None
    rows.append({
        "run": run.name,
        "engine": sides[run.name[0]],
        "right": graded,
        "requests": len(calls),
        "failed": sum(failed(c["response"]) for c in calls),
    })

print(json.dumps(rows, indent=1))
tmp = key / "replay.json"
differ = []
for req in dict.fromkeys(requests):
    tmp.write_text(req)
    got = {name: subprocess.run(cmd + [str(tmp)], capture_output=True, text=True).stdout
           for name, cmd in engines.items()}
    if got["rust"] != got["typescript"]:
        differ.append({"request": req, **got})
tmp.unlink(missing_ok=True)
print(f"replayed {len(dict.fromkeys(requests))} distinct requests on both engines; "
      f"{len(differ)} differ")
(key / "differ.json").write_text(json.dumps(differ, indent=1))
