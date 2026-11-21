#!/usr/bin/env bash
# Makes one folder per run: setup.sh <out-dir> <runs-per-side>.
# Sides `a` and `b` get the same prompt and files; only the engine behind
# ask.sh differs (which is which is in <out-dir>/.key/sides.json, not in the run
# folders). Needs the release `measure` example and packages/financial's
# dist built.
set -euo pipefail
out=$(realpath -m "$1"); runs=$2
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
key="$out/.key"   # the data and the answers: never in a run folder
mkdir -p "$key"
(cd "$repo/packages/financial" && node "$here/dump.mjs" "$key")
python3 "$here/truth.py" "$key" > "$key/truth.json"
rust="$repo/target/release/examples/measure market 2520 ask"
ts="node $repo/packages/financial/scripts/measure/one.mjs market 2520 ask"
echo "{\"a\": \"rust\", \"b\": \"typescript\"}" > "$key/sides.json"
for side in a b; do
  if [ "$side" = a ]; then engine=$rust; else engine=$ts; fi
  for i in $(seq -w 1 "$runs"); do
    dir="$out/$side$i"
    mkdir -p "$dir"
    cp "$key/ops.json" "$dir/"
    sed -n '/^# Requests and responses/,$p' "$repo/website/docs/process/requests.mdx" > "$dir/requests.md"
    sed "s#{DIR}#$dir#g" "$here/prompt.txt" > "$dir/.prompt"
    cat > "$dir/ask.sh" <<ASK
#!/usr/bin/env bash
# Sends one request to the service and prints its response.
set -euo pipefail
[ \$# -eq 1 ] || { echo "usage: ask.sh <request.json>"; exit 2; }
req=\$(realpath "\$1")
resp=\$($engine "\$req" 2>&1) || true
echo "\$resp"
python3 -c 'import json,sys; print(json.dumps({"request": open(sys.argv[1]).read(), "response": sys.argv[2]}))' "\$req" "\$resp" >> "$dir/.calls.jsonl"
ASK
    chmod +x "$dir/ask.sh"
  done
done
echo "made $out"
