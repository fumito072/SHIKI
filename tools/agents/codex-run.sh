#!/usr/bin/env bash
# Run a Codex task from a brief and keep a record of it.
#
#   tools/agents/codex-run.sh <task-name> <brief.md> [effort] [-- image ...]
#
# effort: low | medium | high (model reasoning effort, default medium)
# Record: .agents/runs/<timestamp>-<task-name>/{brief.md,log.txt,result.md,exit}
# Prints the run directory; exits with Codex's exit code.
set -uo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <task-name> <brief.md> [effort] [-- image ...]" >&2
  exit 2
fi

name="$1"; brief="$2"; shift 2
effort="medium"
if [ $# -gt 0 ] && [ "$1" != "--" ]; then effort="$1"; shift; fi
if [ $# -gt 0 ] && [ "$1" = "--" ]; then shift; fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
run="$root/.agents/runs/$(date +%Y%m%d-%H%M%S)-$name"
mkdir -p "$run"
cp "$brief" "$run/brief.md"

imgs=()
for f in "$@"; do imgs+=(-i "$f"); done

codex exec --skip-git-repo-check -s workspace-write -C "$root" \
  -c "model_reasoning_effort=$effort" \
  ${imgs[@]+"${imgs[@]}"} \
  -o "$run/result.md" - < "$brief" > "$run/log.txt" 2>&1
code=$?

echo "$code" > "$run/exit"
echo "$run"
exit "$code"
