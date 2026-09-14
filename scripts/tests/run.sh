#!/bin/sh
# Shared offline suite for local Podman, CI and the production image build.
set -eu
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
exec node --test "$SCRIPT_DIR"/*.test.js
