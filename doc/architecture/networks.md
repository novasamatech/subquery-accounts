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

Only Polkadot Asset Hub registers `AssetHubExtrinsic` and `AssetHubGeneralExtrinsic`.
The extension order and SCALE types are metadata-driven, but the adapter's signed-origin
semantics specifically recognize `VerifyMultiSignature.Signed`; its fee/mortality accessors
also expect named extensions. Successful v4 or bare-v5 decoding on another chain does not
validate that chain's General-v5 pipeline or origin-changing extensions.

Kusama and Westend Asset Hub deliberately retain the stock extrinsic codec until their own
General-v5 snapshots and origin semantics are verified. Before enabling the adapter there,
capture parent-runtime metadata and raw transactions, verify bytes/hash and signer through
the SubQuery VM, assert indexed entities, and run historical decoding regressions. Reuse the
[v5 diagnostic workflow](../runbooks/asset-hub-v5.md), rather than assuming identical upgrades.

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
