#!/usr/bin/env bash
# Run subql-node `test` for a single chain.
#
# Usage:
#   scripts/ci/run-tests.sh polkadot-asset-hub
#   scripts/ci/run-tests.sh kusama
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
if [[ ! "$CHAIN" =~ ^[a-z0-9-]+$ || $# != 1 ]]; then
  echo "Usage: $0 <chain-slug>" >&2
  echo "Example: $0 polkadot-asset-hub" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$REPO_ROOT/versions.env"
export SUBQL_NODE_IMAGE
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

bash scripts/tests/run-host.sh
docker run --rm --network=none --entrypoint sh \
  -v "$REPO_ROOT:/project:ro" \
  "$SUBQL_NODE_IMAGE" /project/scripts/tests/run.sh

export PROJECT_PATH="${PROJECT_FILE}"
COMPOSE=(docker compose --project-name "subql-test-$CHAIN-$$-$RANDOM" --env-file versions.env -f docker-compose-test.yml)
compose_pid=""
cleanup() {
  if [[ -n "$compose_pid" ]]; then kill -TERM "$compose_pid" 2>/dev/null || true; fi
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "$compose_pid" ]]; then wait "$compose_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${COMPOSE[@]}" up \
  --build --abort-on-container-exit --exit-code-from subquery-node-test &
compose_pid=$!
wait "$compose_pid"
compose_pid=""
