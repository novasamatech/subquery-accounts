# Documentation

Start with [AGENTS.md](../AGENTS.md) for repository rules and task-oriented navigation.
These documents are shared by developers and AI agents; keep detailed procedures here rather than
duplicating them in the agent entry point or Makefile.

## Architecture

- [Indexer](architecture/indexer.md): entities, call visitor, handler ownership and runtime globals.
- [Networks](architecture/networks.md): chain-specific behavior, migrations and runtime boundary data.

## Development

- [Build and test](development/podman.md): rootless containers, images, volumes, test layers and cleanup.
- [Diagnostic catalog](development/diagnostics.md): choose a reusable tool, compare decoder versions, extend tools.

## Runbooks

- [Failing block](runbooks/block-failure.md): first triage, workspace/image replay, RPC comparison.
- [Asset Hub v5](runbooks/asset-hub-v5.md): verified Mortal era incident, compatibility fix and recovery.
- [Handler failures](runbooks/handlers.md): missing operations, proxy derivation, data issues and crypto integrity.
- [Runtime compatibility](runbooks/runtime-compatibility.md): dependency, sandbox and historical fee-asset issues.
- [Kusama multisig history](runbooks/kusama-multisig.md): event formats and migration evidence.
- [STG/PROD comparison](runbooks/stg-prod.md): read-only GraphQL diff, exclusions, cache and verdicts.
- [Database wipe](runbooks/database-wipe.md): explicitly approved single-network deletion and checkpoint reset.

Architecture documents describe stable contracts and ownership. Development guides describe reusable
workflows. Runbooks describe symptoms, evidence, diagnosis, verification and recovery. New incident
knowledge belongs in a relevant runbook, with an entry added here only when a new document is needed.
