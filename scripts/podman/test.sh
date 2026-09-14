#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
source "$REPO_ROOT/scripts/podman/test-stack.sh"

case "${1:-all}" in
  all|offline|integration|pg-image) mode="${1:-all}" ;;
  *) die "Usage: bash scripts/podman/test.sh <all|offline|integration|pg-image>" ;;
esac
require_podman
if [[ "$mode" == pg-image ]]; then
  build_pg_image
  exit
fi
require_workspace

if [[ "$mode" != integration ]]; then
  bash "$REPO_ROOT/scripts/tests/run-host.sh"
  podman run --rm --network=none --entrypoint sh \
    -v "$REPO_ROOT:/src:ro,Z" -v "$WORKSPACE_VOLUME:/work:ro" \
    -e PROJECT_ROOT=/work "$SUBQL_NODE_IMAGE" /src/scripts/tests/run.sh
fi
[[ "$mode" != offline ]] || exit 0
[[ "$CHAIN" =~ ^[a-z0-9-]+$ ]] || die "Invalid chain slug"
[[ -f "$REPO_ROOT/project-$CHAIN.yaml" ]] || die "Unknown project: $CHAIN"
[[ -d "$REPO_ROOT/src/test/$CHAIN" ]] || die "No integration tests for $CHAIN"

build_pg_image
init_stack
trap cleanup_stack EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
start_stack
run_stack_node --rm --name "$SQ_NAME" --label "$RESOURCE_LABEL=true" --network "$NET_NAME" \
  "${DB_ARGS[@]}" -v "$WORKSPACE_VOLUME:/work" -w /work "$SUBQL_NODE_IMAGE" \
  test "-f=/work/project-$CHAIN.yaml" --db-schema=test
