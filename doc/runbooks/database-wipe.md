# Single-Network Database Wipe

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

Destructive operation: use only after explicit approval, a recoverable backup and a confirmed target network. It is not a remedy for a block decoding failure.

## Database Operations (Per-Network Wipe)

This section documents how to wipe data for **one chain only** in a shared multichain database.

### Runtime DB structure (`app` schema)

Main data tables:
- `accounts` (global, shared across networks)
- `account_multisigs` (global link table, shared across networks)
- `multisig_operations` (chain-scoped via `chain_id`)
- `multisig_events` (linked to `multisig_operations` by `multisig_id`)
- `proxieds` (chain-scoped via `chain_id`)
- `pure_proxies` (chain-scoped via `chain_id`)

Metadata tables:
- `_metadata_<suffix>`: one table per indexed network/runtime context, key-value storage (`key`, `value`, timestamps)
- `_global`: global indexer status table

Important relationships:
- `multisig_events.multisig_id -> multisig_operations.id`
- `account_multisigs.multisig_id -> accounts.id`
- `account_multisigs.signatory_id -> accounts.id`

### Scope rules for per-network wipe

Safe per-network delete targets:
- `multisig_events` (delete via join to `multisig_operations`)
- `multisig_operations` (filter by `chain_id`)
- `proxieds` (filter by `chain_id`)
- `pure_proxies` (filter by `chain_id`)

Do not delete in per-network wipe:
- `accounts`
- `account_multisigs`

Metadata policy:
- For this project, it is acceptable to **drop the network metadata table entirely** (`DROP TABLE app._metadata_<suffix>`).
- This is a valid checkpoint reset strategy for one network in multichain mode.

### Before running SQL

1. Stop the indexer process/container for the target project.
2. Confirm schema is `app` (`--db-schema=app` in deployment).
3. Run preview query first.
4. Run wipe in a transaction.

### Networks indexed by this project

Both scripts below select the chain by its `chain` value stored in `app._metadata_*` (populated by SubQuery from `system.chain()` at index time). Set that string in **one place** at the top of the script.

Genesis hashes are listed for cross-reference with `chain_id` in operational tables.

| Project YAML                          | `chain` (in `_metadata_*.chain`) | Genesis hash |
|---------------------------------------|----------------------------------|--------------|
| `project-polkadot.yaml`               | `Polkadot`                       | `0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3` |
| `project-kusama.yaml`                 | `Kusama`                         | `0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe` |
| `project-westend.yaml`                | `Westend`                        | `0xe143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e` |
| `project-polkadot-asset-hub.yaml`     | `Polkadot Asset Hub`             | `0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f` |
| `project-kusama-asset-hub.yaml`       | `Kusama Asset Hub`               | `0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a` |
| `project-westend-asset-hub.yaml`      | `Westend Asset Hub`              | `0x67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9` |
| `project-polkadot-collectives.yaml`   | `Collectives`                    | `0x46ee89aa2eedd13e988962630ec9fb7565964cf5023bb351f2b6b25c1b68b0b2` |
| `project-polkadot-people-chain.yaml`  | `Polkadot People`                | `0x67fa177a097bfa18f77ea95ab56e9bcdfeb0e5b8a40e46298bb93e16b6fc5008` |
| `project-kusama-people-chain.yaml`    | `Kusama People`                  | `0xc1af4cb4eb3918e5db15086c0cc5ec17fb334f728b7c65dd44bfe1e174ff8b3f` |
| `project-polkadot-coretime.yaml`      | `Polkadot Coretime`              | `0xefb56e30d9b4a24099f88820987d0f45fb645992416535d87650d98e00f46fc4` |
| `project-kusama-coretime.yaml`        | `Kusama Coretime`                | `0x638cd2b9af4b3bb54b8c1f0d22711fc89924ca93300f0caf25a580432b29d050` |
| `project-moonbeam.yaml`               | `Moonbeam`                       | `0xfe58ea77779b7abda7da4ec526d14db9b1e9cd40a217c34892af80a9b332b76d` |
| `project-moonriver.yaml`              | `Moonriver`                      | `0x401a1f9dca3da46f5c4091016c8a2f26dcea05865116b286f60f668207d1474b` |
| `project-hydradx.yaml`                | `Hydration`                      | `0xafdc188f45c71dacbaa0b62e16a91f726c7b8699a9748cdf715459de6b7f366d` |
| `project-aleph-zero.yaml`             | `Aleph Zero`                     | `0x70255b4d28de0fc4e1a193d7e175ad1ccef431598211c55538f1018651a0344e` |
| `project-mythos.yaml`                 | `Mythos`                         | `0xf6ee56e9c5277df5b4ce6ae9983ee88f3cbed27d31beeb98f9f84f997a1ab0b9` |
| `project-avail.yaml`                  | `Avail DA Mainnet`               | `0xb91746b45e0346cc2f815a520b9c6cb4d5c0902af848db0a80f85932d2e8276a` |
| `project-testnet.yaml`                | `Development`                    | `0x3dbb473ae9b2b77ecf077c03546f0f8670c020e453dddb457da155e6cc7cba42` |
| `project-rococo.yaml`                 | _(not currently in DB; re-run discovery query after indexing)_ | `0x6408de7737c59c238890533af25896a2c20608d8b380bb01029acb392781063e` |
| `project-bittensor.yaml`              | _(not currently in DB; re-run discovery query after indexing)_ | `0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03` |

> Values verified from the live `_metadata_*` tables. The `chain` string comes from the chain runtime itself, so a runtime upgrade may rename it (e.g. `HydraDX` → `Hydration`, `Avail` → `Avail DA Mainnet`). If a wipe ever fails with `Metadata table not found for chain=...`, re-run [`scripts/db/list-indexed-chains.sql`](../../scripts/db/list-indexed-chains.sql) and update this table.

### SQL scripts

All three scripts live in `scripts/db/` and use the same single-variable convention (`v_target_chain` at the top, must match `_metadata_*.chain` exactly).

| Script                                                              | Purpose                                                                                                                       |
|---------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| [`scripts/db/list-indexed-chains.sql`](../../scripts/db/list-indexed-chains.sql) | Discovery: list every `_metadata_*` table with its stored `chain` and `genesisHash`. Run first to find the exact target string. |
| [`scripts/db/wipe-chain-preview.sql`](../../scripts/db/wipe-chain-preview.sql)   | Dry-run preview: prints row counts that **would** be deleted for the target chain. Wrapped in `BEGIN; … ROLLBACK;` — no writes. |
| [`scripts/db/wipe-chain.sql`](../../scripts/db/wipe-chain.sql)                   | Actual wipe: deletes chain-scoped rows from `multisig_events`, `multisig_operations`, `proxieds`, `pure_proxies`, then drops the `_metadata_*` table. Idempotent — re-running after success is a clean no-op. Prints per-table deleted row counts so output can be diffed against the preview. |

Typical flow:

```bash
psql "$DATABASE_URL" -f scripts/db/list-indexed-chains.sql                          # confirm exact chain name
# edit v_target_chain in both files (or sed -i "s/'Kusama'/'<your chain>'/" ...)
psql "$DATABASE_URL" -f scripts/db/wipe-chain-preview.sql                           # verify counts
psql "$DATABASE_URL" -f scripts/db/wipe-chain.sql                                   # commit the wipe
```

### Checkpoint note

If you wipe chain data without resetting metadata/checkpoint state, the indexer may resume from a later height and leave data gaps.
Dropping the target network `_metadata_*` table is an explicit checkpoint reset for that network.
