# Networks and Runtime Boundaries

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

## Networks and Their Specifics

### Standard Configuration
Every network subscribes to the same set of call/event handlers for the `multisig`, `proxy`, `utility`, and `system` modules.

### Special Cases

| Network | Details |
|---|---|
| **Kusama** | Multisig lived in the `utility` module before spec 2007 (block 2,704,203). Requires additional `utility.*` event/call handlers + lowered startBlock. See [Kusama history](../runbooks/kusama-multisig.md). |
| **Polkadot, Kusama, Westend** | Handle `rcMigrator.AssetHubMigrationStarted` for migrating proxy data to Asset Hub |
| **Moonbeam, Moonriver** | EVM-compatible chains. 20-byte addresses (Ethereum format). `createKeyMultiAccountId` handles both formats |
| **Asset Hub chains** | Use custom chainTypes with `NovaAssetId` evolving across spec versions |
| **Bittensor** | Custom types (`Balance` as u64), startBlock=1 |
| **Avail** | Extensive DA-specific types, custom `CheckAppId` signed extension |

### Chain ID (Genesis Hash) Mapping for Migrations

```
Polkadot  (0x91b1...) -> Polkadot Asset Hub  (0x68d5...)
Kusama    (0xb0a8...) -> Kusama Asset Hub    (0x4823...)
Westend   (0xe143...) -> Westend Asset Hub   (0x67f9...)
```

### General-v5 Decoder Scope

All three Asset Hubs (Polkadot, Kusama and Westend) register the shared `AssetHubExtrinsic`
and `AssetHubGeneralExtrinsic` adapters. The historical `NovaAssetId` ranges remain unchanged.
The extension order and SCALE types are metadata-driven, but the adapter's signed-origin
semantics specifically recognize `VerifyMultiSignature.Signed`; its fee/mortality accessors
also expect named extensions. v4 and bare v5 delegate to the stock codec; General-v5 without
signed verification does not acquire an invented signer.

The [network regression matrix](../../scripts/tests/asset-hub-networks.test.js) uses real
parent metadata from each chain. Kusama and Westend snapshots currently advertise only pipeline 0.
Their pipeline-1 cases explicitly model the known Polkadot upgrade, retaining the target chain's
existing types, calls and events. Both reproduce the stock `Mortal era` failure and pass through
their configured VM bundles. The entity suite exercises all three manifests and six entity types.
This is preventive compatibility coverage, not a claim that identical upgrades or transactions
already exist on those chains. See the [evidence and limits](../runbooks/asset-hub-v5.md#cross-network-coverage).

For future runtime changes, extend this matrix instead of waiting for a production transaction.
Capture native metadata with the [diagnostic workflow](../development/diagnostics.md#create-a-mapping-fixture),
model missing cases explicitly, and verify origins, bytes/hash, indexed entities and legacy behavior.
New authorization semantics still require review; metadata-driven field decoding alone cannot prove them.

---

## Asset Hub Spec Version Maps (RPC-Verified)

Complete spec version -> first block mappings for all three Asset Hub chains are maintained in
`scripts/data/asset-hub-spec-blocks.json` (the single source of truth, used by all scan scripts).

- **To update**: follow the [spec scanner workflow](../development/diagnostics.md#spec-transitions). Generate the candidate JSON in a container volume, review the diff, then update the tracked data.
- Important: these values are **node-dependent** if the RPC is not full archive.
- Security: never commit tokenized RPC URLs in repo files.

Current counts (as of 2026-03-05):
- **statemint** (Polkadot Asset Hub): 35 spec versions (spec 2 .. 2000007)
- **statemine** (Kusama Asset Hub): 46 spec versions (spec 2 .. 2000007)
- **westmint** (Westend Asset Hub): 77 spec versions (spec 2 .. 1022000)

The block-to-spec map is an optimization for historical scans, not a substitute for querying the failing block's parent runtime. See [block failure triage](../runbooks/block-failure.md).
