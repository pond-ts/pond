#!/usr/bin/env bash
# Make one folder per trial run: the inputs, the docs page as docs.md, and
# attempt.sh, which runs solution.py and appends the exit status to
# attempts.log.
#
#     setup.sh RUN_DIR [PYTHON]
#
# PYTHON is an interpreter with pond_rs, pandas, polars and pyarrow
# installed (default: python3). Grade afterwards with
# `python check.py RUN_DIR`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
run="$1"
py="${2:-python3}"
mkdir -p "$run"
run="$(cd "$run" && pwd)"
"$py" "$here/gen_data.py" "$run"
cp "$here/../../../website/docs/pond-rs/python.mdx" "$run/docs.md"
cat > "$run/attempt.sh" <<EOF
#!/usr/bin/env bash
cd "$run"
"$py" solution.py
status=\$?
echo "\$(date -u +%H:%M:%S) exit \$status" >> attempts.log
exit \$status
EOF
chmod +x "$run/attempt.sh"
sed "s|{DIR}|$run|g" "$here/prompt.txt" > "$run/PROMPT.txt"
echo "ready: $run (prompt in $run/PROMPT.txt)"
