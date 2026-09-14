#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_LOG"
if [[ "$*" == *'scripts/tests/run.sh'* || "$*" == *'scripts/tests/run-host.sh'* ]]; then
  exit 0
fi
if [[ "$*" == *'/scripts/lib/block-spec.js'* ]]; then
  printf 'dataSources: []\n'
elif [[ "$*" == *'--db-schema=app'* ]]; then
  if [[ "${MOCK_HANG:-0}" == 1 ]]; then
    touch "$MOCK_READY"
    exec sleep 60
  fi
  exit "${MOCK_EXIT:-0}"
elif [[ "$1" == compose && "$*" == *' up '* ]]; then
  exit "${MOCK_EXIT:-0}"
fi
