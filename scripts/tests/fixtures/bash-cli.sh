#!/bin/sh
# Avoid recursively running this suite when testing the CI entry point.
case "$1" in */scripts/tests/run-host.sh|scripts/tests/run-host.sh) exit 0 ;; esac
exec "$REAL_BASH" "$@"
