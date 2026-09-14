#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

script="${1:-}"
[[ "$script" =~ ^[a-z0-9-]+\.js$ && -f "$REPO_ROOT/scripts/diagnostics/$script" ]] ||
  die "Usage: bash scripts/podman/run.sh <diagnostic-name.js> [args...]; see doc/development/diagnostics.md"
shift
require_podman
env_file_args
MOUNT_ARGS=()
if podman volume exists "$WORKSPACE_VOLUME"; then
  MOUNT_ARGS=(-v "$WORKSPACE_VOLUME:/work:ro")
fi
podman run --rm --entrypoint node --network=host \
  -v "$REPO_ROOT:/src:ro,Z" -v "$DIAGNOSTICS_VOLUME:/out" "${MOUNT_ARGS[@]}" \
  -e PROJECT_ROOT=/work -e DIAGNOSTICS_DIR=/out "${ENV_ARGS[@]}" \
  "$SUBQL_NODE_IMAGE" "/src/scripts/diagnostics/$script" "$@"
