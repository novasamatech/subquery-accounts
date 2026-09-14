# Public task index. Implementation and defaults: scripts/podman/.
# Workflows and overrides: doc/development/podman.md.
SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

export CHAIN NODE_IMAGE SUBQL_NODE_IMAGE PG_TEST_IMAGE WORKSPACE_VOLUME
export DIAGNOSTICS_VOLUME ENV_FILE BUILD_IPV4_ONLY

.PHONY: help podman-all podman-install podman-codegen podman-compile podman-build \
        podman-pg-image podman-test podman-test-offline podman-test-integration \
        podman-run podman-clean podman-clean-diagnostics

help: ## Show available tasks
	@awk 'BEGIN { FS = ":.*?## " } /^[a-zA-Z_-]+:.*?## / { printf "  %-26s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

podman-all: ## Build, then offline and integration tests (also sequential with make -j)
	@bash scripts/podman/workspace.sh build
	@bash scripts/podman/test.sh all

podman-install: ## Sync source and install the locked dependency tree
podman-codegen: ## Sync source and generate schema types (install first)
podman-compile: ## Sync source and compile bundles (install and codegen first)
podman-build: ## Sync source, install, generate types and build
podman-install podman-codegen podman-compile podman-build:
	@bash scripts/podman/workspace.sh $(@:podman-%=%)

podman-pg-image: ## Build the local PostgreSQL test image
	@bash scripts/podman/test.sh pg-image

podman-test: ## Offline regressions, then integration tests; CHAIN=polkadot-asset-hub by default
	@bash scripts/podman/test.sh all

podman-test-offline: ## All local fixtures and tool tests, without external RPC or database
	@bash scripts/podman/test.sh offline

podman-test-integration: ## SubQuery handler tests against live RPC and disposable PostgreSQL
	@bash scripts/podman/test.sh integration

podman-run: ## Run a diagnostic; SCRIPT=debug-asset-hub-block.js ARGS='polkadot --block=N --sandbox'
	@bash scripts/podman/run.sh "$(SCRIPT)" $(ARGS)

podman-clean: ## Remove build workspace and leftover test resources; preserve diagnostic snapshots
	@bash scripts/podman/clean.sh workspace

podman-clean-diagnostics: ## Explicitly delete the volume containing diagnostic snapshots and caches
	@bash scripts/podman/clean.sh diagnostics
