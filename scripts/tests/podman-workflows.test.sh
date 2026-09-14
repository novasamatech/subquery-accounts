#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
mkdir "$tmp/bin"
cp "$ROOT/scripts/tests/fixtures/container-cli.sh" "$tmp/bin/podman"
chmod +x "$tmp/bin/podman"
ln -s podman "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" MOCK_LOG="$tmp/commands" MOCK_READY="$tmp/ready"
export PG_IMAGE=mock-postgres SUBQL_NODE_IMAGE=mock-subql
unset ENV_FILE USE_IMAGE_PROJECT USE_IMAGE_SPEC RPC_ENDPOINT_OVERRIDE

expect_status() {
  local expected="$1" status=0
  shift
  "$@" >"$tmp/output" 2>&1 || status=$?
  [[ "$status" == "$expected" ]] || { cat "$tmp/output"; printf 'Expected exit %s, got %s\n' "$expected" "$status"; exit 1; }
}
for spec in /tmp/project-polkadot-asset-hub.yaml ../project-polkadot-asset-hub.yaml; do
  expect_status 2 bash "$ROOT/scripts/podman/block-test.sh" "$spec" 20494727
done
expect_status 2 env USE_IMAGE_PROJECT=typo bash "$ROOT/scripts/podman/block-test.sh" project-polkadot-asset-hub.yaml 20494727
expect_status 2 env USE_IMAGE_SPEC=1 bash "$ROOT/scripts/podman/block-test.sh" project-polkadot-asset-hub.yaml 20494727
expect_status 2 env BUILD_IPV4_ONLY=typo bash "$ROOT/scripts/podman/workspace.sh" build
expect_status 0 env BUILD_IPV4_ONLY=1 bash "$ROOT/scripts/podman/workspace.sh" build
grep -q 'run --rm --sysctl net.ipv6.conf.all.disable_ipv6=1' "$MOCK_LOG"
expect_status 17 env MOCK_EXIT=17 bash "$ROOT/scripts/podman/block-test.sh" project-polkadot-asset-hub.yaml 20494727
grep -q '^rm -fv subql-node-test-' "$MOCK_LOG"
grep -q '^network rm subql-test-net-' "$MOCK_LOG"
grep -q 'pg_isready -h 127.0.0.1 -U postgres -d postgres' "$MOCK_LOG"
expect_status 0 bash "$ROOT/scripts/podman/block-test.sh" project-polkadot-asset-hub.yaml 20494727 --batch-size=1 --db-schema=custom
args="$(grep '^run .*--db-schema=custom' "$MOCK_LOG")"
[[ "$args" != *'--batch-size=30'* && "$args" != *'--db-schema=app'* ]]
expect_status 0 bash "$ROOT/scripts/podman/block-test.sh" project-polkadot-asset-hub.yaml 20494727 --batch-size 2 --db-schema custom2
args="$(grep '^run .*--db-schema custom2' "$MOCK_LOG")"
[[ "$args" != *'--batch-size=30'* && "$args" != *'--db-schema=app'* ]]

MOCK_HANG=1 bash "$ROOT/scripts/podman/block-test.sh" project-polkadot-asset-hub.yaml 20494727 >"$tmp/output" 2>&1 &
pid=$!
for ((i=0; i<200; i++)); do
  [[ ! -f "$MOCK_READY" ]] || break
  sleep 0.02
done
[[ -f "$MOCK_READY" ]] || { cat "$tmp/output"; exit 1; }
kill -TERM "$pid"
for ((i=0; i<200; i++)); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.02
done
if kill -0 "$pid" 2>/dev/null; then
  printf 'Replay failed to handle SIGTERM promptly\n'
  exit 1
fi
status=0
wait "$pid" || status=$?
pid=""
[[ "$status" == 143 ]]

export REAL_BASH="$BASH"
cp "$ROOT/scripts/tests/fixtures/bash-cli.sh" "$tmp/bin/bash"
chmod +x "$tmp/bin/bash"
expect_status 17 env MOCK_EXIT=17 "$REAL_BASH" "$ROOT/scripts/ci/run-tests.sh" polkadot-asset-hub
project="$(awk '$1 == "compose" && / up / { print $3 }' "$MOCK_LOG")"
[[ "$project" == subql-test-polkadot-asset-hub-* ]]
grep -q "^compose --project-name $project -f docker-compose-test.yml down --volumes --remove-orphans$" "$MOCK_LOG"
printf 'Host workflow tests passed (input validation, exit codes, Podman/CI cleanup, SIGTERM)\n'
