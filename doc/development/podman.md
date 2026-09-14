# Build and Test with Podman

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

## Environment

On Linux, run all Node, Yarn, npm, TypeScript and SubQuery commands in rootless Podman.
Host prerequisites are Bash, Make and Podman. No host `node_modules`, `dist`, generated
`src/types` or Yarn cache is needed. CI uses disposable Docker runners via
`scripts/ci/run-tests.sh`; it is not the local development entry point.

## Task Selection

| Task | Command | Inputs / side effects |
|---|---|---|
| Full build | `make podman-build` | Sync source, immutable install, codegen, compile in the workspace volume |
| Reinstall dependencies | `make podman-install` | Sync source and install the locked tree |
| Regenerate schema types | `make podman-codegen` | Requires install; updates generated types in the volume |
| Recompile | `make podman-compile` | Requires install/codegen; updates bundles in the volume |
| Offline regressions | `make podman-test-offline` | Built bundles plus committed fixtures; no external RPC or database |
| Handler integration | `make podman-test-integration CHAIN=polkadot-asset-hub` | Built workspace, live chain RPC, disposable PostgreSQL |
| Both test layers | `make podman-test` | Offline first, then integration |
| Build and both layers | `make podman-all` | Explicitly sequential, including with `make -j` |
| RPC / GraphQL tool | `make podman-run SCRIPT=... ARGS='...'` | See the [diagnostic catalog](diagnostics.md) |
| Full indexer replay | `bash scripts/podman/block-test.sh ...` | See [block failure triage](../runbooks/block-failure.md) |
| Remove build/test resources | `make podman-clean` | Deletes workspace and labelled test resources, preserves diagnostic snapshots |
| Delete diagnostic evidence | `make podman-clean-diagnostics` | Explicitly deletes snapshots and caches; export needed evidence first |

Run a build after source changes before testing. Test and diagnostic commands do not silently
rebuild code, so results cannot be mistaken for a build verification. Different simultaneous
build/test jobs must use different `WORKSPACE_VOLUME` values. Do not run cleanup during an active test.

## Storage and Images

Defaults live in [scripts/podman/common.sh](../../scripts/podman/common.sh); Make only forwards overrides.

| Setting | Default | Purpose |
|---|---|---|
| `NODE_IMAGE` | `docker.io/library/node:24-alpine` | Build tooling and project dependency tree |
| `SUBQL_NODE_IMAGE` | `docker.io/subquerynetwork/subql-node-substrate:v6.4.6` | Actual indexer decoder and SubQuery VM |
| `PG_TEST_IMAGE` | `localhost/subql-pg-test:latest` | Built from `docker/pg-Dockerfile` |
| `WORKSPACE_VOLUME` | `subql-workspace` | Sources, dependencies and bundles at `/work` |
| `DIAGNOSTICS_VOLUME` | `subql-diagnostics` | Snapshots / caches at `/out` |
| `CHAIN` | `polkadot-asset-hub` | Manifest and integration-test directory slug |
| `ENV_FILE` | Unset | Mode-0600 file outside the repository for private RPC overrides |
| `BUILD_IPV4_ONLY` | `0` | Set `1` if Alpine downloads stall on an unusable IPv6 route; only disables IPv6 in the build container |

The repository is mounted read-only as `/src:ro,Z`. Build containers rsync it into `/work`,
preserving generated directories. The `:Z` mount option handles SELinux. Do not use
`--userns=keep-id` for the build container: Corepack needs to write into its own image filesystem.

Updating project resolutions does not update dependencies bundled into the runtime image.
For a decoder change verify both, and retain the exact image digest in incident evidence.
The production Dockerfile runs the Node offline suite after copying the built project into
the final runtime stage. When updating a runtime version, also check both local/test Compose files,
CI workflows and manifest minimum versions.

## Test Ownership

- `scripts/tests/*.test.js`: deterministic regressions and CLI tests; automatically discovered by
  `scripts/tests/run.sh`. Add a test here without editing Makefile or Dockerfile.
- `scripts/tests/*.test.sh`: host-side lifecycle tests, auto-discovered by `run-host.sh` and
  run before the Node suite locally and in CI. These use fake Podman/Docker CLIs, not host Node.
- `scripts/tests/fixtures/`: small reviewed raw inputs with chain/block provenance, no secrets.
- `scripts/tests/helpers/`: shared fixture builders and the real SubQuery VM harness. The harness
  uses runtime codecs, manifest filters and the built mappings, replacing only the persistence boundary
  with an in-memory store so exact entity fields, relationships and absence of writes can be asserted.
- `src/test/<chain>/*.test.ts`: SubQuery handler/store contracts against real block heights.
- Full replay: fetch, filters, handlers, storage and runtime loading together. A clean database may
  lack a multisig operation's earlier creation state; choose a start block with that dependency in mind.

For chainTypes changes, test the actual VM boundary as well as a plain registry. Byte/hash round trips
are necessary but not sufficient: signed origins and handler filtering must also be correct.
For a changed extrinsic format, include positive entity assertions, not just a handler test with
an empty expected-entity list. Distinguish synthetic-envelope tests from on-chain replay and SQL verification.

## Cleanup and Failures

Integration/replay containers have unique names and are removed on exit or interruption. Starting
a test never deletes another running test. Explicit cleanup removes only this toolchain's labelled
test containers/networks and the configured build volume/image; it does not touch production data.
CI likewise uses a unique Compose project and removes its database volumes after success or failure.

A database readiness timeout is a hard failure, with PostgreSQL logs printed before cleanup.
RPC failures during integration are not offline test failures. Report them separately and retain
the block, runtime and image versions. Do not pipe asynchronous Node output through `tail`, which
buffers until EOF.

If the build stalls in `apk add rsync` while host downloads work, compare a bounded Alpine
download with IPv4-only container networking. `make podman-build BUILD_IPV4_ONLY=1` provides
the same workaround without editing system networking, image mirrors or project dependencies.
The package bootstrap prints progress and has a 120-second wall-clock limit.

Do not delete host directories automatically to satisfy the isolation rule. Review any pre-existing
host artifacts with their owner; the old one-off `clean-host-artifacts` Make target is retired.
