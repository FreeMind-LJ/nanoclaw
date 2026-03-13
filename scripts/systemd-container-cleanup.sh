#!/usr/bin/env bash
set -euo pipefail

runtime="${CONTAINER_RUNTIME_BIN:-docker}"

ids="$("$runtime" ps -aq --filter "name=^nanoclaw-" 2>/dev/null || true)"
if [[ -z "$ids" ]]; then
  exit 0
fi

"$runtime" rm -f $ids >/dev/null 2>&1 || true
