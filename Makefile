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
# Workspace isolation:
#   - Source tree mounted READ-ONLY at /src.
#   - All work happens inside a single named Podman volume mounted at /work
#     (volume name: $(WORKSPACE_VOLUME)). This is the container's own
#     filesystem space — never visible on the host, never creates stub
#     directories under the project root.
#   - On every build the source is rsynced from /src → /work (excluding
#     generated dirs that yarn populates inside the volume). Build and
#     test containers share the same volume so test sees what build wrote.
#   - `podman-clean` deletes the volume; all artifacts vanish with it.
#
# Quick start:
#   make podman-build                          # rsync source + yarn install + codegen + build, all in /work
#   make podman-test                           # build pg image, spin up pg + subql-node, run tests against /work
#   make podman-test CHAIN=kusama-asset-hub
#   make podman-clean                          # remove containers / network / locally built pg image / workspace volume

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

# Stable container / network / volume names so `make podman-clean` is deterministic.
PG_NAME           := subql-pg-test
SQ_NAME           := subql-node-test
NET_NAME          := subql-test-net
WORKSPACE_VOLUME  := subql-workspace

# Target chain for tests. Override on CLI: `make podman-test CHAIN=kusama-asset-hub`.
CHAIN        ?= polkadot-asset-hub
PROJECT_FILE := project-$(CHAIN).yaml
TEST_DIR     := src/test/$(CHAIN)

PROJECT_ROOT := $(shell pwd)

# rsync excludes — generated dirs that yarn / codegen / tsc populate inside
# the workspace volume. `--exclude` protects matching paths from both copy
# and `--delete`, so the volume's node_modules etc. survive across builds.
# `.git` excluded because it's large and irrelevant to subql-node. `.claude`
# excluded because it's editor/agent state.
RSYNC_EXCLUDES := \
	--exclude=node_modules \
	--exclude=dist \
	--exclude=.yarn \
	--exclude=src/types \
	--exclude=.git \
	--exclude=.claude

# Common podman invocation for the Node build container. Source mounted
# read-only, workspace mounted from named volume. No --userns=keep-id:
# under rootless podman, root inside maps to host user, so volume content
# ends up correctly owned AND corepack can write into /usr/local/bin inside
# the image. With --userns=keep-id, corepack fails with EACCES.
PODMAN_NODE_RUN := podman run --rm \
	-v "$(PROJECT_ROOT):/src:ro,Z" \
	-v $(WORKSPACE_VOLUME):/work \
	-w /work \
	$(NODE_IMAGE) \
	sh -c

# Prelude that prepares /work: install rsync (busybox doesn't ship it),
# mirror source into /work skipping volume-managed dirs.
SYNC_SOURCE := apk add --no-cache rsync >/dev/null && rsync -a --delete $(RSYNC_EXCLUDES) /src/ /work/

.PHONY: help \
	podman-all podman-build podman-install podman-codegen podman-compile \
	podman-pg-image podman-test podman-clean \
	clean-host-artifacts

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*?## " } /^[a-zA-Z_-]+:.*?## / { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

podman-all: podman-build podman-test ## Build then test (full CI parity)

# ---------------------------------------------------------------------------
# Build (Node 24 container, --rm; everything inside workspace volume)
# ---------------------------------------------------------------------------

podman-install: ## rsync source into /work + yarn install --immutable
	$(PODMAN_NODE_RUN) '$(SYNC_SOURCE) && corepack enable && yarn install --immutable'

podman-codegen: ## rsync source into /work + yarn codegen
	$(PODMAN_NODE_RUN) '$(SYNC_SOURCE) && corepack enable && yarn codegen'

podman-compile: ## rsync source into /work + yarn build
	$(PODMAN_NODE_RUN) '$(SYNC_SOURCE) && corepack enable && yarn build'

podman-build: ## rsync source into /work + install + codegen + build in one container shell
	$(PODMAN_NODE_RUN) '$(SYNC_SOURCE) && corepack enable && yarn install --immutable && yarn codegen && yarn build'

# ---------------------------------------------------------------------------
# Test (Postgres + subql-node containers, trap-based cleanup)
# ---------------------------------------------------------------------------

podman-pg-image: ## Build the local Postgres test image from docker/pg-Dockerfile
	podman build -t $(PG_TEST_IMAGE) -f docker/pg-Dockerfile .

podman-test: podman-pg-image ## Run subql-node tests for $(CHAIN) against the workspace volume. Run `make podman-build` first.
	@test -f "$(PROJECT_FILE)" || { echo "Project manifest not found: $(PROJECT_FILE)" >&2; exit 1; }
	@test -d "$(TEST_DIR)"     || { echo "Test directory not found: $(TEST_DIR)" >&2; exit 1; }
	@if ! podman volume exists $(WORKSPACE_VOLUME) >/dev/null 2>&1; then \
	  echo "workspace volume ($(WORKSPACE_VOLUME)) not found — run 'make podman-build' first" >&2; \
	  exit 1; \
	fi
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
	  -v $(WORKSPACE_VOLUME):/work -w /work \
	  $(SUBQL_NODE_IMAGE) \
	  test -f=/work/$(PROJECT_FILE) --db-schema=test

# ---------------------------------------------------------------------------
# Cleanup — idempotent, safe to run anytime
# ---------------------------------------------------------------------------

podman-clean: ## Remove leftover project containers, network, locally-built pg image, and the workspace volume
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
	@echo "=== volume ==="
	@if podman volume exists $(WORKSPACE_VOLUME) >/dev/null 2>&1; then \
	  podman volume rm $(WORKSPACE_VOLUME) >/dev/null && echo "  removed $(WORKSPACE_VOLUME)" ; \
	else \
	  echo "  (skip) $(WORKSPACE_VOLUME) — not present" ; \
	fi

clean-host-artifacts: ## One-time host cleanup: rm node_modules/, dist/, src/types/, .yarn/ if left over from earlier builds (no podman, plain rm).
	@for d in node_modules dist src/types .yarn; do \
	  if [ -e "$$d" ]; then rm -rf "$$d" && echo "  removed $$d" ; else echo "  (skip) $$d — not present" ; fi ; \
	done
