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
| **Polkadot People** | Pipeline 1 with Individuality authorizers since `people-polkadot 2005000`; `peopleLite.dispatchAsSigner` handler |
| **Mythos** | Uses `metadataExtrinsicChaintypes` (previously the Kusama Asset Hub bundle, whose types are scoped to `statemine`) |
| **Bittensor** | Custom types (`Balance` as u64), startBlock=1 |
| **Avail** | Extensive DA-specific types, custom `CheckAppId` signed extension |

### Chain ID (Genesis Hash) Mapping for Migrations

```
Polkadot  (0x91b1...) -> Polkadot Asset Hub  (0x68d5...)
Kusama    (0xb0a8...) -> Kusama Asset Hub    (0x4823...)
Westend   (0xe143...) -> Westend Asset Hub   (0x67f9...)
```

### General-v5 Decoder Scope

Every manifest registers the shared `MetadataExtrinsic`/`MetadataGeneralExtrinsic` adapters from
`chainTypes/metadataExtrinsic.ts` through `withMetadataExtrinsic`: chains with their own types wrap their
bundle, others use `metadataExtrinsicChaintypes`. A new manifest must do the same;
`scripts/tests/manifest-chaintypes.test.js` fails otherwise. Any runtime with metadata v16 can add a
transaction-extension pipeline in a later upgrade, which the stock codec cannot decode.

The extension order and SCALE types are metadata-driven, but the adapter's signed-origin semantics
recognize only `VerifyMultiSignature.Signed`. Fee, mortality and metadata-hash accessors fall back to
stock defaults when a pipeline lacks the named extension (e.g. `ChargeTransactionPayment` instead of
`ChargeAssetTxPayment`). v4 and bare v5 delegate to the stock codec; General-v5 without signed
verification does not acquire an invented signer. The historical Asset Hub `NovaAssetId` ranges remain unchanged.

The [network regression matrix](../../scripts/tests/asset-hub-networks.test.js) uses real v16 metadata of
15 indexed networks (`scripts/tests/helpers/network-cases.js`). Polkadot Asset Hub and
Polkadot People advertise a native pipeline 1 and have real incident transactions; every other network
models pipeline 1 as its family reference's authorizers followed by its own pipeline 0. The entity suite
runs on the 13 captured networks with 32-byte accounts; Moonbeam and Moonriver have decoder checks
and signed-v4 proxy entity tests with native and modeled metadata. Their future signed-v5 authorization
is not modeled. This is
preventive coverage, not a claim that such upgrades already exist. See the
[assessment, evidence and limits](../runbooks/asset-hub-v5.md#all-network-assessment).

For future runtime changes, run the [pipeline scanner](../development/diagnostics.md#transaction-extension-pipelines),
extend this matrix instead of waiting for a production transaction, capture native metadata with the
[diagnostic workflow](../development/diagnostics.md#create-a-mapping-fixture), and verify origins,
bytes/hash, indexed entities and legacy behavior. New authorization semantics still require review;
metadata-driven field decoding alone cannot prove them.

### Signed-Dispatch Wrappers

All three Asset Hub manifests register `metaTx.dispatch`; the
[handler runbook](../runbooks/handlers.md#15-westend-asset-hub-metatx-dispatch-hides-a-threshold-one-multisig)
owns the authorization contract, fixture provenance and modeled-upgrade coverage limits.
Both People manifests register `peopleLite.dispatchAsSigner`, a transparent wrapper that restores the
signer's origin; see [handler section 16](../runbooks/handlers.md#16-people-peoplelitedispatchassigner-wraps-multisigproxy-calls).

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
