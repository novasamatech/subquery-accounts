#!/usr/bin/env bash
# Sourced by host-side Podman workflows; never invokes Node on the host.
# shellcheck disable=SC2034
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/versions.env"
: "${PG_TEST_IMAGE:=localhost/subql-pg-test:latest}"
: "${WORKSPACE_VOLUME:=subql-workspace}"
: "${DIAGNOSTICS_VOLUME:=subql-diagnostics}"
: "${CHAIN:=polkadot-asset-hub}"
RESOURCE_LABEL="com.nova.subquery-accounts.test"

die() {
  printf '%s\n' "$*" >&2
  exit 2
}

require_podman() {
  command -v podman >/dev/null || die "Podman is required; see doc/development/podman.md"
}

require_workspace() {
  podman volume exists "$WORKSPACE_VOLUME" ||
    die "Workspace $WORKSPACE_VOLUME is missing; run make podman-build"
  podman run --rm --entrypoint sh -v "$WORKSPACE_VOLUME:/work:ro" "$NODE_IMAGE" \
    -c 'test -f /work/dist/index.js' ||
    die "Workspace is not built; run make podman-build"
}

env_file_args() {
  ENV_ARGS=()
  if [[ -n "${ENV_FILE:-}" ]]; then
    [[ -f "$ENV_FILE" ]] || die "ENV_FILE does not exist"
    [[ "$(stat -c %a "$ENV_FILE")" == 600 ]] || die "ENV_FILE must have mode 0600"
    case "$(realpath "$ENV_FILE")" in "$REPO_ROOT"/*) die "ENV_FILE must be outside the repository" ;; esac
    ENV_ARGS=(--env-file "$ENV_FILE")
  fi
}
