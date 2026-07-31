#!/usr/bin/env bash
# Backfill intermediate multisig approval events that were never indexed while
# the manifests filtered on the misspelled "MultisigApproved" event (PR #95).
# Extracts candidate operations + their recorded events, recovers the missing
# approvals from archive-node storage (scripts/backfill-multisig-approvals.js)
# and emits a reviewable SQL transaction per database. Nothing is written
# without --apply.
#
# Two databases (e.g. prod and prod-2) can be backfilled from ONE chain pass:
# set PGCONN2 and the script unifies the candidates of both extracts, probes
# the chain once, and writes fix-multisig-approvals-db1.sql /
# fix-multisig-approvals-db2.sql filtered to what each database lacks —
# events are never emitted for an operation a database doesn't contain, so
# the multisig_id foreign key stays safe.
#
# Deploy the fixed indexer image BEFORE running with --apply: the script and
# the live indexer are idempotent against each other (ON CONFLICT DO NOTHING),
# but a still-running broken version keeps missing NEW approvals.
#
# Candidates:
#   - pending operations with threshold > 1 (current storage tells the truth);
#   - executed/error operations with fewer approve events than the threshold;
#   - cancelled operations with threshold > 1 (approvals before the cancel are
#     unknowable from the DB alone — the chain probe decides).
#
# Usage:
#   PGCONN="postgres://user:pass@host:5432/db" [PGCONN2="postgres://..."] \
#     scripts/backfill-multisig-approvals.sh <db-schema> [--apply] [--chains 0x...,0x...] [--concurrency 8]
#
#   scripts/backfill-multisig-approvals.sh app                 # dry run: writes fix-multisig-approvals-db1.sql (+db2)
#   scripts/backfill-multisig-approvals.sh app --apply         # applies each SQL to its database, prints remaining gaps
#   scripts/backfill-multisig-approvals.sh app --chains 0x68d5...  # limit to specific chains (comma-separated genesis hashes)

set -euo pipefail

SCHEMA="${1:-}"
shift || true
MODE=""
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE="--apply"; shift ;;
    --chains) EXTRA_ARGS+=(--chains "$2"); shift 2 ;;
    --concurrency) EXTRA_ARGS+=(--concurrency "$2"); shift 2 ;;
    --endpoints) EXTRA_ARGS+=(--endpoints "$2"); shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SCHEMA" ]]; then
  echo "Usage: PGCONN=postgres://... [PGCONN2=postgres://...] $0 <db-schema> [--apply] [--chains <chainId,...>] [--concurrency <n>]" >&2
  exit 2
fi
if [[ -z "${PGCONN:-}" ]]; then
  echo "Set PGCONN to a postgres connection string (postgres://user:pass@host:port/db)" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Candidate operations with their recorded events and the multisig threshold.
# Missing threshold (multisig account never linked) keeps the op as candidate —
# the chain probe is authoritative anyway.
EXTRACT_QUERY="select json_build_object('operations', coalesce(json_agg(row_to_json(o)), '[]'::json))
from (
  select
    op.id,
    op.chain_id,
    op.account_id,
    op.call_hash,
    op.status,
    op.block_created,
    op.index_created,
    coalesce(acc.threshold, 0) as threshold,
    coalesce((
      select json_agg(json_build_object('id', e.id, 'status', e.status, 'block_created', e.block_created))
      from ${SCHEMA}.multisig_events e
      where e.multisig_id = op.id
    ), '[]'::json) as events
  from ${SCHEMA}.multisig_operations op
  left join ${SCHEMA}.accounts acc on acc.id = op.account_id
  where
    (op.status = 'pending' and coalesce(acc.threshold, 2) > 1)
    or (op.status in ('executed', 'error') and coalesce(acc.threshold, 0) > (
      select count(*) from ${SCHEMA}.multisig_events e
      where e.multisig_id = op.id and e.status = 'approve'
    ))
    or (op.status = 'cancelled' and coalesce(acc.threshold, 2) > 1)
) o"

GAP_QUERY="select count(*)
from ${SCHEMA}.multisig_operations op
join ${SCHEMA}.accounts acc on acc.id = op.account_id
where op.status in ('executed', 'error')
  and acc.threshold > (
    select count(*) from ${SCHEMA}.multisig_events e
    where e.multisig_id = op.id and e.status = 'approve'
  )"

EXTRACT_DIR="$(mktemp -d)"
trap 'rm -rf "$EXTRACT_DIR"' EXIT

DB_CONNS=("$PGCONN")
DB_NAMES=("db1")
if [[ -n "${PGCONN2:-}" ]]; then
  DB_CONNS+=("$PGCONN2")
  DB_NAMES+=("db2")
fi

EXTRACT_ARGS=()
for i in "${!DB_CONNS[@]}"; do
  name="${DB_NAMES[$i]}"
  echo "== Extracting candidate operations from '${name}' (schema '${SCHEMA}')..."
  psql "${DB_CONNS[$i]}" -v ON_ERROR_STOP=1 -Atc "$EXTRACT_QUERY" > "$EXTRACT_DIR/$name.json"
  EXTRACT_ARGS+=(--extract "$name=$EXTRACT_DIR/$name.json")
done

node scripts/backfill-multisig-approvals.js --schema "$SCHEMA" --out-dir . "${EXTRACT_ARGS[@]}" "${EXTRA_ARGS[@]}"

if [[ "$MODE" != "--apply" ]]; then
  echo "== Dry run complete. Review fix-multisig-approvals-<name>.sql, then re-run with --apply."
  exit 0
fi

for i in "${!DB_CONNS[@]}"; do
  name="${DB_NAMES[$i]}"
  echo "== Applying fix-multisig-approvals-${name}.sql to '${name}'..."
  psql "${DB_CONNS[$i]}" -v ON_ERROR_STOP=1 -f "fix-multisig-approvals-${name}.sql"

  echo "== ${name}: executed/error operations still missing approvals (threshold not reached by events):"
  psql "${DB_CONNS[$i]}" -v ON_ERROR_STOP=1 -Atc "$GAP_QUERY"
done
