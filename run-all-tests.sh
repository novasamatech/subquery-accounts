#!/usr/bin/env bash
set -euo pipefail

# Find all project-*.yaml files in repo root and run subql-node test for each.
# Exports FILTER_MANIFEST_BASENAME to allow tests to pick the right case.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

shopt -s nullglob
cd "$ROOT_DIR"

files=( project-*.yaml )

if [ ${#files[@]} -eq 0 ]; then
  echo "No project-*.yaml files found"
  exit 0
fi

for f in "${files[@]}"; do
  echo "\n=== Running tests for $f ==="
  export FILTER_MANIFEST_BASENAME="$f"
  subql-node -f "$ROOT_DIR/$f" test 
done


