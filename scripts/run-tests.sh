#!/usr/bin/env bash
# Run subql-node `test` for a single chain.
#
# Usage:
#   scripts/run-tests.sh polkadot-asset-hub
#   scripts/run-tests.sh kusama
#
# Expects two artifacts to exist for the given chain slug:
#   - project-<slug>.yaml  (project manifest, points at the chain RPC)
#   - src/test/<slug>/     (subqlTest *.test.ts files for that chain)
#
# Wraps docker-compose-test.yml so subql-node runs in isolation against the
# chain's RPC endpoint. The container's exit code is propagated, so this is
# safe to call from CI.

set -euo pipefail

CHAIN="${1:-}"
if [[ -z "$CHAIN" ]]; then
  echo "Usage: $0 <chain-slug>" >&2
  echo "Example: $0 polkadot-asset-hub" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_FILE="project-${CHAIN}.yaml"
TEST_DIR="src/test/${CHAIN}"

if [[ ! -f "${REPO_ROOT}/${PROJECT_FILE}" ]]; then
  echo "Project manifest not found: ${PROJECT_FILE}" >&2
  exit 1
fi
if [[ ! -d "${REPO_ROOT}/${TEST_DIR}" ]]; then
  echo "Test directory not found: ${TEST_DIR}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

PROJECT_PATH="${PROJECT_FILE}" docker compose -f docker-compose-test.yml up \
  --build --abort-on-container-exit --exit-code-from subquery-node-test
