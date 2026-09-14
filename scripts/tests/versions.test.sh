#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
unset NODE_VERSION SUBQL_NODE_VERSION NODE_IMAGE SUBQL_NODE_IMAGE SUBQL_PRODUCTION_IMAGE
source "$ROOT/versions.env"
[[ "$NODE_IMAGE" == "docker.io/library/node:$NODE_VERSION-alpine" ]]
[[ "$SUBQL_NODE_IMAGE" == "docker.io/subquerynetwork/subql-node-substrate:$SUBQL_NODE_VERSION" ]]
[[ "$SUBQL_PRODUCTION_IMAGE" == "docker.io/onfinality/subql-node:$SUBQL_NODE_VERSION" ]]

unset NODE_IMAGE SUBQL_NODE_IMAGE SUBQL_PRODUCTION_IMAGE
NODE_VERSION=99
SUBQL_NODE_VERSION=v99.1.2
source "$ROOT/versions.env"
[[ "$NODE_IMAGE" == docker.io/library/node:99-alpine ]]
[[ "$SUBQL_NODE_IMAGE" == docker.io/subquerynetwork/subql-node-substrate:v99.1.2 ]]
[[ "$SUBQL_PRODUCTION_IMAGE" == docker.io/onfinality/subql-node:v99.1.2 ]]

NODE_IMAGE=custom-build
SUBQL_NODE_IMAGE=custom-runtime
SUBQL_PRODUCTION_IMAGE=custom-production
source "$ROOT/scripts/podman/common.sh"
[[ "$NODE_IMAGE" == custom-build && "$SUBQL_NODE_IMAGE" == custom-runtime && "$SUBQL_PRODUCTION_IMAGE" == custom-production ]]
printf 'Image defaults tests passed (shared versions and independent overrides)\n'
