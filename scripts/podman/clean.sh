#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_podman

remove_volume() {
  if podman volume exists "$1"; then podman volume rm "$1"; fi
}

case "${1:-workspace}" in
  diagnostics)
    remove_volume "$DIAGNOSTICS_VOLUME"
    ;;
  workspace)
    # Explicit cleanup only. Starting a test never kills another active run.
    while IFS= read -r id; do
      [[ -z "$id" ]] || podman rm -fv "$id"
    done < <(podman ps -aq --filter "label=$RESOURCE_LABEL=true")
    while IFS= read -r name; do
      [[ -z "$name" ]] || podman network rm "$name"
    done < <(podman network ls --format '{{.Name}}' --filter "label=$RESOURCE_LABEL=true")
    if podman image exists "$PG_TEST_IMAGE"; then podman image rm "$PG_TEST_IMAGE"; fi
    remove_volume "$WORKSPACE_VOLUME"
    ;;
  *) die "Usage: bash scripts/podman/clean.sh <workspace|diagnostics>" ;;
esac
