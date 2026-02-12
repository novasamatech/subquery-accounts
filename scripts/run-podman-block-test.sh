#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/run-podman-block-test.sh <project-spec.yaml> <start-block> [extra subql-node args...]

Example:
  scripts/run-podman-block-test.sh project-kusama.yaml 4401372
  scripts/run-podman-block-test.sh project-kusama.yaml 4401372 --unsafe --workers=1

Environment overrides:
  DB_PORT        Local forwarded postgres port (default: 55432)
  DB_USER        Postgres user (default: postgres)
  DB_PASS        Postgres password (default: postgres)
  DB_NAME        Postgres db name (default: postgres)
  DB_SCHEMA      SubQuery schema name (default: app)
  PG_IMAGE       Postgres image (default: docker.io/library/postgres:16-alpine)
  NODE_IMAGE     SubQuery node image (default: docker.io/subquerynetwork/subql-node-substrate:v6.4.6)
  RPC_ENDPOINT_OVERRIDE Override `network.endpoint` in temp spec (default: empty/no override)
  USE_IMAGE_PROJECT Use project bundled in NODE_IMAGE instead of local bind-mount (default: 0)
  USE_IMAGE_SPEC Use spec file bundled in NODE_IMAGE as source before startBlock patch (default: 0)
  IMAGE_PROJECT_ROOT Project root path in NODE_IMAGE when USE_IMAGE_PROJECT=1 (default: /project)
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

SPEC_INPUT="$1"
START_BLOCK="$2"
shift 2
EXTRA_NODE_ARGS=("$@")

if ! [[ "$START_BLOCK" =~ ^[0-9]+$ ]]; then
  echo "[error] start-block must be an integer, got: $START_BLOCK" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
USE_IMAGE_PROJECT="${USE_IMAGE_PROJECT:-0}"
USE_IMAGE_SPEC="${USE_IMAGE_SPEC:-0}"
IMAGE_PROJECT_ROOT="${IMAGE_PROJECT_ROOT:-/project}"

if [[ "$USE_IMAGE_SPEC" == "1" && "$USE_IMAGE_PROJECT" != "1" ]]; then
  echo "[error] USE_IMAGE_SPEC=1 requires USE_IMAGE_PROJECT=1" >&2
  exit 1
fi

if [[ "$USE_IMAGE_SPEC" == "1" ]]; then
  SPEC_PATH="$SPEC_INPUT"
else
  if [[ "$SPEC_INPUT" = /* ]]; then
    SPEC_PATH="$SPEC_INPUT"
  else
    SPEC_PATH="$PROJECT_ROOT/$SPEC_INPUT"
  fi

  if [[ ! -f "$SPEC_PATH" ]]; then
    echo "[error] Spec file not found: $SPEC_PATH" >&2
    exit 1
  fi
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "[error] podman is required but not found in PATH" >&2
  exit 1
fi

if ! podman info >/dev/null 2>&1; then
  echo "[error] podman is not ready for rootless execution in this environment" >&2
  exit 1
fi

DB_PORT="${DB_PORT:-55432}"
DB_USER="${DB_USER:-postgres}"
DB_PASS="${DB_PASS:-postgres}"
DB_NAME="${DB_NAME:-postgres}"
DB_SCHEMA="${DB_SCHEMA:-app}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:16-alpine}"
NODE_IMAGE="${NODE_IMAGE:-docker.io/subquerynetwork/subql-node-substrate:v6.4.6}"
RPC_ENDPOINT_OVERRIDE="${RPC_ENDPOINT_OVERRIDE:-}"

if [[ "$USE_IMAGE_PROJECT" != "1" ]]; then
  if [[ ! -f "$PROJECT_ROOT/dist/index.js" ]]; then
    echo "[error] Built mapping not found: $PROJECT_ROOT/dist/index.js" >&2
    echo "[hint] Run: yarn build" >&2
    exit 1
  fi
fi

RUN_ID="${USER:-user}-$(date +%s)-$$"
TMP_SPEC_BASENAME="__tmp-subql-block-test-$(basename "$SPEC_PATH" .yaml)-start-${START_BLOCK}-${RUN_ID}.yaml"
TMP_SPEC_HOST="$PROJECT_ROOT/${TMP_SPEC_BASENAME}"
TMP_SPEC_CONTAINER="/app/${TMP_SPEC_BASENAME}"

if [[ "$USE_IMAGE_PROJECT" == "1" ]]; then
  TMP_SPEC_HOST="/tmp/${TMP_SPEC_BASENAME}"
  TMP_SPEC_CONTAINER="${IMAGE_PROJECT_ROOT}/${TMP_SPEC_BASENAME}"
fi

NETWORK_NAME="sq-net-${RUN_ID}"
PG_CONTAINER="sq-pg-${RUN_ID}"
NODE_CONTAINER="sq-node-${RUN_ID}"
BASE_LABEL_KEY="com.nova.subquery-block-test"
BASE_LABEL_VALUE="true"
RUN_LABEL_KEY="com.nova.subquery-block-test.run-id"
RUN_LABEL_VALUE="$RUN_ID"
NODE_RUN_PID=""

cleanup() {
  set +e
  podman rm -f "$NODE_CONTAINER" >/dev/null 2>&1 || true
  podman rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  podman network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  rm -f "$TMP_SPEC_HOST" >/dev/null 2>&1 || true
}

cleanup_orphans() {
  set +e
  local stale_containers
  stale_containers="$(podman ps -a --filter "label=${BASE_LABEL_KEY}=${BASE_LABEL_VALUE}" --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -n "$stale_containers" ]]; then
    while IFS= read -r cid; do
      [[ -n "$cid" ]] || continue
      podman rm -f "$cid" >/dev/null 2>&1 || true
    done <<< "$stale_containers"
  fi

  local stale_networks
  stale_networks="$(podman network ls --filter "label=${BASE_LABEL_KEY}=${BASE_LABEL_VALUE}" --format '{{.Name}}' 2>/dev/null || true)"
  if [[ -n "$stale_networks" ]]; then
    while IFS= read -r net; do
      [[ -n "$net" ]] || continue
      podman network rm "$net" >/dev/null 2>&1 || true
    done <<< "$stale_networks"
  fi

  rm -f "$PROJECT_ROOT"/__tmp-subql-block-test-*.yaml >/dev/null 2>&1 || true
  rm -f /tmp/__tmp-subql-block-test-*.yaml >/dev/null 2>&1 || true
}

signal_exit_code() {
  case "${1:-TERM}" in
    HUP) echo 129 ;;
    INT) echo 130 ;;
    QUIT) echo 131 ;;
    TERM) echo 143 ;;
    PIPE) echo 141 ;;
    *) echo 1 ;;
  esac
}

handle_signal() {
  local sig="$1"
  echo "[signal] Received SIG${sig}, stopping..."

  if [[ -n "${NODE_RUN_PID:-}" ]] && kill -0 "$NODE_RUN_PID" >/dev/null 2>&1; then
    kill -TERM "$NODE_RUN_PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      if ! kill -0 "$NODE_RUN_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    if kill -0 "$NODE_RUN_PID" >/dev/null 2>&1; then
      kill -KILL "$NODE_RUN_PID" >/dev/null 2>&1 || true
    fi
  fi

  trap - EXIT HUP INT TERM QUIT PIPE
  cleanup
  exit "$(signal_exit_code "$sig")"
}

trap cleanup EXIT
trap 'handle_signal HUP' HUP
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM
trap 'handle_signal QUIT' QUIT
trap 'handle_signal PIPE' PIPE

echo "[0/6] Cleaning leftovers from previous runs (if any)"
cleanup_orphans

if [[ "$USE_IMAGE_SPEC" == "1" ]]; then
  IMAGE_SPEC_PATH="${IMAGE_PROJECT_ROOT}/$(basename "$SPEC_INPUT")"
  echo "[0.5/6] Reading spec from image: $IMAGE_SPEC_PATH"
  podman run --rm --entrypoint sh "$NODE_IMAGE" -lc "cat '$IMAGE_SPEC_PATH'" >"$TMP_SPEC_HOST" || {
    echo "[error] Failed to read spec from image path: $IMAGE_SPEC_PATH" >&2
    exit 1
  }
else
  cp "$SPEC_PATH" "$TMP_SPEC_HOST"
fi

awk -v new_block="$START_BLOCK" -v endpoint_override="$RPC_ENDPOINT_OVERRIDE" '
  BEGIN { replaced = 0; endpoint_replaced = 0 }
  {
    if (!replaced && $0 ~ /^[[:space:]]*startBlock:[[:space:]]*[0-9]+/) {
      sub(/startBlock:[[:space:]]*[0-9]+/, "startBlock: " new_block)
      replaced = 1
    }
    if (endpoint_override != "" && !endpoint_replaced && $0 ~ /^[[:space:]]*endpoint:[[:space:]]*/) {
      sub(/endpoint:[[:space:]]*.*/, "endpoint: " endpoint_override)
      endpoint_replaced = 1
    }
    print
  }
  END {
    if (!replaced) {
      exit 2
    }
    if (endpoint_override != "" && !endpoint_replaced) {
      exit 3
    }
  }
' "$TMP_SPEC_HOST" >"${TMP_SPEC_HOST}.new" || {
  rc=$?
  rm -f "${TMP_SPEC_HOST}.new"
  if [[ $rc -eq 2 ]]; then
    echo "[error] startBlock field was not found in $SPEC_PATH" >&2
  elif [[ $rc -eq 3 ]]; then
    echo "[error] endpoint field was not found for RPC_ENDPOINT_OVERRIDE in temp spec" >&2
  else
    echo "[error] failed to patch startBlock in temp spec" >&2
  fi
  exit 1
}
mv "${TMP_SPEC_HOST}.new" "$TMP_SPEC_HOST"

echo "[1/6] Patched temp spec: $TMP_SPEC_HOST"

echo "[2/6] Pulling postgres image (official recommendation is PostgreSQL 16+): $PG_IMAGE"
podman pull "$PG_IMAGE" >/dev/null

echo "[3/6] Starting postgres container: $PG_CONTAINER (localhost:$DB_PORT)"
podman network create \
  --label "${BASE_LABEL_KEY}=${BASE_LABEL_VALUE}" \
  --label "${RUN_LABEL_KEY}=${RUN_LABEL_VALUE}" \
  "$NETWORK_NAME" >/dev/null

podman run -d \
  --rm \
  --name "$PG_CONTAINER" \
  --label "${BASE_LABEL_KEY}=${BASE_LABEL_VALUE}" \
  --label "${RUN_LABEL_KEY}=${RUN_LABEL_VALUE}" \
  --network "$NETWORK_NAME" \
  -p "${DB_PORT}:5432" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  "$PG_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if podman exec "$PG_CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ $ready -ne 1 ]]; then
  echo "[error] postgres did not become ready in time" >&2
  podman logs "$PG_CONTAINER" >&2 || true
  exit 1
fi

echo "[4/6] Postgres is ready, enabling btree_gist extension"
podman exec "$PG_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
  -c "CREATE EXTENSION IF NOT EXISTS btree_gist;" >/dev/null

echo "      Local DB DSN: postgres://$DB_USER:$DB_PASS@127.0.0.1:$DB_PORT/$DB_NAME"

echo "[5/6] Starting subql-node container: $NODE_CONTAINER"
echo "      Spec inside container: $TMP_SPEC_CONTAINER"

MOUNT_ARGS=()
if [[ "$USE_IMAGE_PROJECT" == "1" ]]; then
  MOUNT_ARGS=(-v "$TMP_SPEC_HOST:$TMP_SPEC_CONTAINER:ro")
else
  MOUNT_ARGS=(-v "$PROJECT_ROOT:/app")
fi

podman run --rm \
  --name "$NODE_CONTAINER" \
  --label "${BASE_LABEL_KEY}=${BASE_LABEL_VALUE}" \
  --label "${RUN_LABEL_KEY}=${RUN_LABEL_VALUE}" \
  --network "$NETWORK_NAME" \
  -e DB_USER="$DB_USER" \
  -e DB_PASS="$DB_PASS" \
  -e DB_DATABASE="$DB_NAME" \
  -e DB_HOST="$PG_CONTAINER" \
  -e DB_PORT="5432" \
  "${MOUNT_ARGS[@]}" \
  "$NODE_IMAGE" \
  -f="$TMP_SPEC_CONTAINER" \
  --db-schema="$DB_SCHEMA" \
  --batch-size=30 \
  "${EXTRA_NODE_ARGS[@]}" &

NODE_RUN_PID=$!
set +e
wait "$NODE_RUN_PID"
NODE_EXIT_CODE=$?
set -e
NODE_RUN_PID=""

if [[ $NODE_EXIT_CODE -ne 0 ]]; then
  echo "[error] subql-node exited with code: $NODE_EXIT_CODE" >&2
  exit "$NODE_EXIT_CODE"
fi

echo "[6/6] Completed. Cleaning current run resources"
cleanup
