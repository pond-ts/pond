#!/bin/zsh
# Usage: run-arm.sh <A|B|C|D> [model]
# Fresh headless session in the arm's directory. No pond CLAUDE.md, no user
# settings (project+local only), permissions bypassed (isolated scratch dir),
# bounded by turns + budget. stream-json transcript → <arm>.jsonl.
set -u
arm=$1; model=${2:-}
S=$(cd "$(dirname "$0")/.." && pwd)
dir=$S/runs/$arm
cd "$dir" || exit 1
args=(-p "$(cat "$S/harness/TASK.md")" --output-format stream-json --verbose \
  --max-turns 90 --max-budget-usd 10 --permission-mode bypassPermissions \
  --setting-sources project,local --no-session-persistence)
[[ -n "$model" ]] && args+=(--model "$model")
start=$(date +%s)
env -u CLAUDECODE claude "${args[@]}" > "$S/runs/$arm.jsonl" 2> "$S/runs/$arm.stderr"
rc=$?
echo "arm=$arm rc=$rc wall=$(( $(date +%s) - start ))s" | tee "$S/runs/$arm.done"
