#!/usr/bin/env bash
# Disposable PostgreSQL and network, shared by integration and block replay.
# Caller sources common.sh first and installs the EXIT/signal traps.
# shellcheck disable=SC2034
init_stack() {
  local run_id
  run_id="$$-$(date +%s)"
  NET_NAME="subql-test-net-$run_id"
  PG_NAME="subql-pg-test-$run_id"
  SQ_NAME="subql-node-test-$run_id"
  NODE_RUN_PID=""
}

cleanup_stack() {
  if [[ -n "${NODE_RUN_PID:-}" ]]; then
    kill -TERM "$NODE_RUN_PID" 2>/dev/null || true
  fi
  podman rm -fv "$SQ_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  if [[ -n "${NODE_RUN_PID:-}" ]]; then
    wait "$NODE_RUN_PID" 2>/dev/null || true
  fi
  podman network rm "$NET_NAME" >/dev/null 2>&1 || true
}

run_stack_node() {
  # Bash runs signal traps immediately while waiting on an asynchronous child.
  podman run "$@" &
  NODE_RUN_PID=$!
  local status=0
  wait "$NODE_RUN_PID" || status=$?
  NODE_RUN_PID=""
  return "$status"
}

build_pg_image() {
  podman build -t "$PG_TEST_IMAGE" -f "$REPO_ROOT/docker/pg-Dockerfile" "$REPO_ROOT"
}

start_stack() {
  : "${DB_USER:=postgres}"
  : "${DB_PASS:=postgres}"
  : "${DB_NAME:=postgres}"
  local port_args=()
  if [[ -n "${DB_PORT:-}" ]]; then
    [[ "$DB_PORT" =~ ^[0-9]+$ ]] || die "DB_PORT must be an integer"
    port_args=(-p "127.0.0.1:$DB_PORT:5432")
  fi
  podman network create --label "$RESOURCE_LABEL=true" "$NET_NAME" >/dev/null
  podman run -d --name "$PG_NAME" --label "$RESOURCE_LABEL=true" --network "$NET_NAME" \
    "${port_args[@]}" -e "POSTGRES_USER=$DB_USER" -e "POSTGRES_PASSWORD=$DB_PASS" \
    -e "POSTGRES_DB=$DB_NAME" "$PG_TEST_IMAGE" >/dev/null
  for ((attempt = 0; attempt < 30; attempt++)); do
    # initdb's temporary server accepts Unix sockets but never listens on TCP.
    if podman exec "$PG_NAME" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      podman exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
        -c "CREATE EXTENSION IF NOT EXISTS btree_gist;" >/dev/null
      DB_ARGS=(-e "DB_USER=$DB_USER" -e "DB_PASS=$DB_PASS" -e "DB_DATABASE=$DB_NAME"
        -e "DB_HOST=$PG_NAME" -e DB_PORT=5432)
      return
    fi
    sleep 2
  done
  podman logs "$PG_NAME" >&2 || true
  die "PostgreSQL did not become ready within 60 seconds"
}
