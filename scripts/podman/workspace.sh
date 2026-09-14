#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

case "${1:-}" in
  install|codegen|compile|build) task="$1" ;;
  *) die "Usage: bash scripts/podman/workspace.sh <install|codegen|compile|build>" ;;
esac
require_podman
NETWORK_ARGS=()
case "${BUILD_IPV4_ONLY:-0}" in
  0) ;;
  1) NETWORK_ARGS=(--sysctl net.ipv6.conf.all.disable_ipv6=1) ;;
  *) die "BUILD_IPV4_ONLY must be 0 or 1" ;;
esac

# Generated directories remain in the named volume across source syncs.
podman run --rm "${NETWORK_ARGS[@]}" -v "$REPO_ROOT:/src:ro,Z" -v "$WORKSPACE_VOLUME:/work" \
  -w /work "$NODE_IMAGE" sh -eu -c '
    timeout 120 apk add --no-cache --timeout 30 rsync
    rsync -a --delete --exclude=node_modules --exclude=dist --exclude=.yarn \
      --exclude=src/types --exclude=.git --exclude=.claude --exclude=.cache \
      --exclude=.data /src/ /work/
    corepack enable
    case "$1" in
      install) yarn install --immutable ;;
      codegen) yarn codegen ;;
      compile) yarn build ;;
      build)
        yarn install --immutable
        yarn codegen
        yarn build
        ;;
    esac
  ' workspace "$task"
