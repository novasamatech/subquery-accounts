# Compare Staging and Production

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

Use this after indexing fixes or when investigating missing rows. This workflow only reads GraphQL; it does not modify either database. A live comparison is not an atomic database snapshot, so first compare indexer heights and repeat any suspected drift.

### `scripts/diagnostics/compare-stg-prod.js` — Diff all entities between STG and PROD GraphQL

Compares every entity (`pureProxies`, `proxieds`, `accounts`, `accountMultisigs`, `multisigEvents`,
`multisigOperations`) between the staging and production SubQuery GraphQL endpoints and reports
ids that exist only on one side, plus field-level diffs. Unlike the RPC scan scripts it talks to
the **GraphQL API**, not RPC, so it needs no `asset-hub-spec-blocks.json` and no RPC URL — only
network egress to the two endpoints (defaults: `subquery-accounts-stg/prod.novasama-tech.org`).

```bash
# Full default run (id-only, all entities, gentle on the backend) — ~8 min, ~470k rows
node scripts/diagnostics/compare-stg-prod.js

# Quick targeted check (bigger pages, no inter-page delay) — seconds
node scripts/diagnostics/compare-stg-prod.js --entities=pureProxies,proxieds --page-size=2000 --page-delay-ms=0

# Full field-by-field comparison (heavier: pulls callData etc.)
node scripts/diagnostics/compare-stg-prod.js --deep

# Machine-readable diff
node scripts/diagnostics/compare-stg-prod.js --json > diff.json

# Regression tests for compare/cache/filter/CLI logic
make podman-test-offline
```

Modes & flags:
- **id-only (default)** fetches just `id` per row — 10–20× lighter than `--deep`, enough to find
  missing/extra rows. **`--deep`** fetches and compares all shared fields (schema diffs included).
- `--parallel` queries STG+PROD at once (default is sequential/gentler), `--page-size` / `--page-delay-ms`
  tune pagination, `--sample=N` controls how many example ids/diffs are printed.
- On-disk cache (`.cache/compare-stg-prod/`, keyed by endpoint URL) makes **incomplete** runs resumable
  after a flaky endpoint or Ctrl-C. Completed snapshots are re-fetched because the endpoints keep
  changing; `--refresh` discards partial state too, and `--no-cache` disables caching.
- Exit code (including `--json`): `0` = no scoped row or schema differences,
  `1` = scoped row or schema differences detected, `2` = incomplete comparison / fatal error.
- Pages use `ID_ASC` ordering and validate rows, counts and advancing cursors. Partial caches
  from the old ordering are discarded. A missing/cyclic cursor or fewer unique rows than the
  advertised count is an error, not an equality verdict. Retry with `--refresh` after drift;
  additions seen during the scan are included in the reported counts.

**Chain exclusion (`--exclude-chain`, important subtlety):** by default Westend Asset Hub is skipped
only while its prod indexer is more than 1,000 blocks behind staging (otherwise its rows show up as
"only in STG" noise). Once PROD catches up, the default exclusion automatically becomes inactive.
An explicit `--exclude-chain=...` always applies. The filter can only be applied to entities whose
chain is derivable:
- `pureProxies` / `proxieds` — id begins with the chainId (`{chainId}-…`), so it works in id-only mode.
- `multisigOperations` — id begins with the **callHash**, not the chainId, so the script fetches the
  `chainId` column even in id-only mode to make the filter work.
- `multisigEvents` — has no `chainId` field, so the script resolves it through `multisigId` and the
  corresponding `MultisigOperation.chainId`.
- `accounts` / `accountMultisigs` are global and **cannot** be chain-filtered. Their differences are
  reported separately as unscoped and do not affect the verdict while exclusions are active.

Schema differences always affect the verdict: they describe an endpoint, not a lagging chain.
When exclusions are active, a missing operation-to-chain link makes the entity comparison fail
instead of silently keeping an unassignable event. Live endpoints (and resumed partial scans)
are not a shared snapshot: same-count updates/deletions can still race a scan. For an authoritative
reconciliation compare aligned, stable database snapshots; do not automatically delete rows based
on this diagnostic.

Use `--no-exclude-chain` to compare every chain including Westend Asset Hub. Run it with the [Podman diagnostic runner](../development/diagnostics.md).

## Rootless Invocation

```bash
make podman-run SCRIPT=compare-stg-prod.js ARGS='--entities=pureProxies,proxieds --page-size=2000 --page-delay-ms=0'
make podman-run SCRIPT=compare-stg-prod.js ARGS='--deep'
bash scripts/podman/run.sh compare-stg-prod.js --json
```

Bare `node` examples above describe the CLI inside a container, not host commands. The runner stores its cache under `/out/compare-stg-prod` in `DIAGNOSTICS_VOLUME`; `make podman-clean` preserves it. The `--no-cache` option is useful for a fully fresh comparison. Never pass private endpoint credentials in `ARGS`; this tool's endpoint flags are appropriate for public URLs only.
