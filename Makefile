# Build / test orchestration for subquery-accounts.
#
# All current tasks run inside rootless Podman containers and are prefixed
# `podman-*` to leave the unprefixed namespace free for future non-podman
# tasks (e.g. host-side helpers, lint runners, formatters).
#
# Policy: no node / yarn / subql-node runs on the host. Everything runs in
# rootless Podman containers that self-remove (`--rm`) after use, except the
# Postgres test container which is named so the trap-based cleanup can find
# and remove it deterministically even if the test fails.
#
# Quick start:
#   make podman-build                          # yarn install + codegen + build inside Node 24 podman
#   make podman-test                           # build pg image, spin up pg + subql-node, run tests, tear down
#   make podman-test CHAIN=kusama-asset-hub
#   make podman-clean                          # nuke any leftover containers / networks / locally built test images

SHELL        := /usr/bin/env bash
.SHELLFLAGS  := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Images — pinned to match CI.
#   .github/workflows/pr.yml         uses node 24
#   docker-compose-test.yml          uses subql-node v5.6.0
#   docker/pg-Dockerfile             builds Postgres 16 alpine + btree_gist
NODE_IMAGE       := docker.io/library/node:24-alpine
SUBQL_NODE_IMAGE := docker.io/subquerynetwork/subql-node-substrate:v5.6.0
PG_TEST_IMAGE    := localhost/subql-pg-test:latest

# Stable container / network names so `make podman-clean` is deterministic.
PG_NAME  := subql-pg-test
SQ_NAME  := subql-node-test
NET_NAME := subql-test-net

# Target chain for tests. Override on CLI: `make podman-test CHAIN=kusama-asset-hub`.
CHAIN        ?= polkadot-asset-hub
PROJECT_FILE := project-$(CHAIN).yaml
TEST_DIR     := src/test/$(CHAIN)

PROJECT_ROOT := $(shell pwd)

# Common podman invocation for the Node build container. No --userns=keep-id:
# under rootless podman, root inside the container maps to the host user, so
# files end up owned by the user on the host AND corepack can write into
# /usr/local/bin inside the container. With --userns=keep-id, corepack fails
# with EACCES.
PODMAN_NODE_RUN := podman run --rm \
	-v "$(PROJECT_ROOT):/app:Z" \
	-w /app \
	$(NODE_IMAGE) \
	sh -c

.PHONY: help \
	podman-all podman-build podman-install podman-codegen podman-compile \
	podman-pg-image podman-test podman-clean

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*?## " } /^[a-zA-Z_-]+:.*?## / { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

podman-all: podman-build podman-test ## Build then test (full CI parity)

# ---------------------------------------------------------------------------
# Build (Node 24 container, --rm)
# ---------------------------------------------------------------------------

podman-install: ## yarn install --immutable
	$(PODMAN_NODE_RUN) 'corepack enable && yarn install --immutable'

podman-codegen: ## yarn codegen
	$(PODMAN_NODE_RUN) 'corepack enable && yarn codegen'

podman-compile: ## yarn build
	$(PODMAN_NODE_RUN) 'corepack enable && yarn build'

podman-build: ## install + codegen + build in one container shell
	$(PODMAN_NODE_RUN) 'corepack enable && yarn install --immutable && yarn codegen && yarn build'

# ---------------------------------------------------------------------------
# Test (Postgres + subql-node containers, trap-based cleanup)
# ---------------------------------------------------------------------------

podman-pg-image: ## Build the local Postgres test image from docker/pg-Dockerfile
	podman build -t $(PG_TEST_IMAGE) -f docker/pg-Dockerfile .

podman-test: podman-pg-image ## Run subql-node tests for $(CHAIN). Requires dist/ — run `make podman-build` first if missing.
	@test -f "$(PROJECT_FILE)" || { echo "Project manifest not found: $(PROJECT_FILE)" >&2; exit 1; }
	@test -d "$(TEST_DIR)"     || { echo "Test directory not found: $(TEST_DIR)" >&2; exit 1; }
	@test -d "dist"            || { echo "dist/ not found — run 'make podman-build' first" >&2; exit 1; }
	@set -e ; \
	cleanup() { \
	  echo "=== cleanup ===" ; \
	  podman rm -f $(PG_NAME) >/dev/null 2>&1 || true ; \
	  podman rm -f $(SQ_NAME) >/dev/null 2>&1 || true ; \
	  podman network rm $(NET_NAME) >/dev/null 2>&1 || true ; \
	} ; \
	trap cleanup EXIT INT TERM ; \
	echo "=== ensuring clean slate ===" ; \
	podman rm -f $(PG_NAME) >/dev/null 2>&1 || true ; \
	podman rm -f $(SQ_NAME) >/dev/null 2>&1 || true ; \
	podman network rm $(NET_NAME) >/dev/null 2>&1 || true ; \
	echo "=== creating network $(NET_NAME) ===" ; \
	podman network create $(NET_NAME) >/dev/null ; \
	echo "=== starting postgres ($(PG_NAME)) ===" ; \
	podman run -d --name $(PG_NAME) --network $(NET_NAME) \
	  -e POSTGRES_PASSWORD=postgres \
	  $(PG_TEST_IMAGE) >/dev/null ; \
	echo "=== waiting for postgres ===" ; \
	for i in $$(seq 1 30); do \
	  podman exec $(PG_NAME) pg_isready -U postgres >/dev/null 2>&1 && break ; \
	  sleep 2 ; \
	done ; \
	echo "=== running subql-node test (chain=$(CHAIN)) ===" ; \
	podman run --rm --name $(SQ_NAME) --network $(NET_NAME) \
	  -e DB_USER=postgres -e DB_PASS=postgres -e DB_DATABASE=postgres \
	  -e DB_HOST=$(PG_NAME) -e DB_PORT=5432 \
	  -v "$(PROJECT_ROOT):/app:Z" -w /app \
	  $(SUBQL_NODE_IMAGE) \
	  test -f=/app/$(PROJECT_FILE) --db-schema=test

# ---------------------------------------------------------------------------
# Cleanup — idempotent, safe to run anytime
# ---------------------------------------------------------------------------

podman-clean: ## Remove leftover project containers, the test network, and the locally built pg image
	@echo "=== containers ==="
	@for n in $(PG_NAME) $(SQ_NAME); do \
	  if podman container exists $$n >/dev/null 2>&1; then \
	    podman rm -f $$n >/dev/null && echo "  removed $$n" ; \
	  else \
	    echo "  (skip) $$n — not present" ; \
	  fi ; \
	done
	@echo "=== network ==="
	@if podman network exists $(NET_NAME) >/dev/null 2>&1; then \
	  podman network rm $(NET_NAME) >/dev/null && echo "  removed $(NET_NAME)" ; \
	else \
	  echo "  (skip) $(NET_NAME) — not present" ; \
	fi
	@echo "=== image ==="
	@if podman image exists $(PG_TEST_IMAGE) >/dev/null 2>&1; then \
	  podman image rm $(PG_TEST_IMAGE) >/dev/null && echo "  removed $(PG_TEST_IMAGE)" ; \
	else \
	  echo "  (skip) $(PG_TEST_IMAGE) — not present" ; \
	fi
