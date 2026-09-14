#!/usr/bin/env bash
# Host-side orchestration tests use fake container CLIs, never host Node or a real DB.
set -euo pipefail
for file in "$(dirname "$0")"/*.test.sh; do
  [[ -f "$file" ]] || continue
  bash "$file"
done
