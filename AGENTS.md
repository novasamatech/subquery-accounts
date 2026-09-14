# AGENTS.md -- Repository Entry Point

SubQuery indexer for Nova Spektr: multisig accounts, proxy relationships and multisig lifecycle
across Substrate networks. PostgreSQL stores the entities; GraphQL exposes them.

## Start Here

1. Check the current branch and worktree before editing. Preserve unrelated changes.
2. Read the architecture or runbook relevant to the task below.
3. Use existing build/test/diagnostic workflows. Keep detailed knowledge in `doc/`, not this file.

## Documentation Map

| Task | Read |
|---|---|
| Understand entities, visitor, handlers and runtime globals | [Indexer architecture](doc/architecture/indexer.md) |
| Add a network or change runtime type boundaries | [Network reference](doc/architecture/networks.md) |
| Build, run tests, choose an image or clean local resources | [Podman development](doc/development/podman.md) |
| Find, reuse or extend a diagnostic tool | [Diagnostic catalog](doc/development/diagnostics.md) |
| Indexer fails at a particular block | [Block triage and replay](doc/runbooks/block-failure.md) |
| Polkadot AH v5 `GeneralExtrinsic` / `Mortal era` error | [v5 decode incident](doc/runbooks/asset-hub-v5.md) |
| Missing operations, wrong proxies or derived accounts | [Handler/data failures](doc/runbooks/handlers.md) |
| Dependency upgrade, sandbox bytes, fee-asset decode failure | [Runtime compatibility](doc/runbooks/runtime-compatibility.md) |
| Old Kusama utility-era multisig behavior | [Kusama history](doc/runbooks/kusama-multisig.md) |
| Compare staging and production entities | [STG/PROD comparison](doc/runbooks/stg-prod.md) |
| Explicitly approved single-network reindex | [Database wipe runbook](doc/runbooks/database-wipe.md) |

Full index: [doc/README.md](doc/README.md). Tool ownership: [scripts/README.md](scripts/README.md).

## Mandatory Rules

- On Linux, run all Node/Yarn/npm/TypeScript/SubQuery commands in rootless Podman, never on the host.
  Mount source read-only; use named volumes for dependencies, bundles, caches and snapshots.
- Keep RPC credentials out of tracked files, command-line arguments, logs and fixtures. Use a
  mode-0600 env-file outside the repository and remove it after use.
- Reuse a diagnostic before writing one. Extend the closest tool or add a reusable command in
  `scripts/diagnostics/`; shared logic belongs in `scripts/lib/`, tests in `scripts/tests/`.
  Useful incident logic must not remain only in temporary scripts or terminal one-liners.
- New diagnostics must validate inputs, bound requests, expose meaningful exit codes, and document
  their inputs, outputs and limitations in the catalog and relevant runbook.
- For decoder/dependency incidents, preserve raw input and metadata when practical. Compare existing
  and candidate dependencies on the same snapshot before choosing a compatibility workaround.
- Verify chainTypes and crypto changes in the actual SubQuery VM. Preserve raw encoding/hash,
  signed-origin semantics and the `assertCryptoIntegrity` canary; ordinary Node tests alone are insufficient.
- For extrinsic-format changes, assert final entity fields and relationships through real mappings.
  A successful decode or an integration test with no expected entities does not prove indexed-data correctness.
- Do not bypass a failing block, disable integrity checks, wipe chain data or reset a checkpoint
  just to make indexing proceed. Production changes require explicit authorization.
- In a per-network wipe, `accounts` and `account_multisigs` are global and must not be deleted.
  Follow discovery, backup, preview, stop-indexer and transaction steps in the database runbook.
- Keep Makefile a task index; reusable orchestration lives in `scripts/podman/`.
  New offline tests are discovered automatically, without per-incident Make targets.
- Keep this file short. Architecture describes contracts, development guides describe reusable
  workflows, runbooks retain symptoms/evidence/verification/recovery. Update links when moving files.

## Common Commands

~~~bash
make help
make podman-all
make podman-test CHAIN=polkadot-asset-hub
make podman-run SCRIPT=debug-asset-hub-block.js ARGS='polkadot --block=20494727 --sandbox --compare'
make podman-clean
~~~

These commands do not deploy to production. Cleanup preserves diagnostic evidence unless
`make podman-clean-diagnostics` is explicitly requested.
