# Polkadot Asset Hub v5 Decode Failure

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

## Incident

**Verified incident:** Polkadot Asset Hub block `20494727`, hash `0x4e321bc81810ce34496e8395ad6bb329f25ac972ad8aa9601b2aab9973d3aa86`, parent runtime `statemint 2005000`, extrinsic index `2`.

The transaction starts with the v5 general preamble `0x45` and selects transaction extension pipeline `1`. Metadata v16 lists its extensions in a different order from pipeline `0`, including `VerifyMultiSignature`, `AsPgas`, `AsDotnsGateway`, and `RestrictOrigins` before mortality/nonce/payment fields. polkadot-js uses its legacy signed-extension field list instead, so signature bytes are incorrectly read as `era`.

**Dependency verification (2026-09-14):** SubQuery `6.4.6` bundles polkadot-js `16.5.3`; the project's pinned version is `16.5.4`. The latest published `@polkadot/api`/`@polkadot/types` `16.5.6` also fails on the exact same raw transaction and metadata. Updating the project's `package.json` alone does not replace the separate decoder in the indexer image.

**Fix:** `chainTypes/assetHubExtrinsic.ts`, registered by all three Asset Hub chainTypes bundles, selects each general extrinsic's extension pipeline and SCALE types from metadata. It preserves the original encoding/hash and exposes `VerifyMultiSignature`'s account/signature so `isSigned: true` filters and the call visitor process these transactions. v4 and bare v5 delegate to the stock codec. Codec constructors return instances created by the runtime registry to avoid cross-VM `Uint8Array` incompatibility.

**Verification:** use the [single-block diagnostic](../development/diagnostics.md#single-block-decode) and `make podman-test`. The failing call is `utility.forceBatch([staking.payoutStakers(...)])`. A dictionary HTTP 503 in the same logs is a separate service failure; it does not explain deterministic SCALE decoding errors.

After an upstream decoder fix is released, replay the saved block with that dependency version before removing this compatibility layer. Restarting the fixed indexer from its existing checkpoint is sufficient for this fetch failure; do not skip the block or wipe chain data.

## Override Versus Upgrade

Rechecked on **2026-09-14**, independently of the original implementation. The registry's
`latest` for `@polkadot/api`, `@polkadot/types` and `@polkadot/types-known` is `16.5.6`;
`@subql/node` is `6.4.6`. The `types-known` beta tag points to old `8.14.2-12`, not a newer
release. Check current tags again before making a future upgrade decision.

Every executed case used the same full raw block and parent metadata, replayed without RPC.
The machine-readable [dependency evidence](../evidence/asset-hub-v5-dependencies.json) records
resolved package paths, input fingerprints, failures and successful decoded origins.

| Decoder / API | Native `types-known` | No project override | Project override through SubQuery VM |
|---|---|---|---|
| Image `16.5.3` | `16.5.3` | `Mortal era`, extrinsic 2 | All 3 extrinsics pass |
| Project `16.5.4` | `16.5.4` | Same error | All 3 pass |
| Image `16.5.3` | Only types-known upgraded to `16.5.6` | Same error | Not needed for this isolation test |
| Clean full install `16.5.6` | `16.5.6` | Same error | All 3 pass |

The mixed type-bundle case emits expected duplicate-package warnings. The clean full
`16.5.6` stock case does not depend on that mixed installation and independently fails.
Successful runs preserve the raw transaction, its hash
`0xb69ed69710cf90f42e17f9e3f4fff5e2abd7f93db8ce6cfc13dda3b4ab8d1111`,
and the signed account. The tests also exercise the actual SubQuery `isSigned` filter
and the visitor's propagated origin, not only a successful byte decode.

### Why Native Chain Types Do Not Fix This Case

In the [16.5.6 GeneralExtrinsic constructor](https://github.com/polkadot-js/api/blob/dd76109c422f4f872d25c4939f11a3638b531eea/packages/types/src/extrinsic/v5/GeneralExtrinsic.ts#L54),
the layout comes from `registry.getSignedExtensionTypes()`. The encoded extension version
does not select a metadata pipeline. The [registry implementation](https://github.com/polkadot-js/api/blob/6b1eb761f4977509792868dc62e5ee52c800db30/packages/types/src/create/registry.ts#L404)
still expands the legacy extension definitions. Changing the fee-asset alias cannot account
for the signature and new fields inserted before `era` in pipeline 1.

There are native Asset Hub fixes, but for a different failure:
[Polkadot #6208](https://github.com/polkadot-js/api/pull/6208) and
[Westend #6268](https://github.com/polkadot-js/api/pull/6268) change XCM mappings for foreign-asset
`ChargeAssetTxPayment`. The latter explicitly leaves metadata-derived extension decoding as
follow-up work. The incident transaction pays with `assetId=None`; its failure occurs at
mortality, before the fee-asset value. The full-upgrade result above includes the published
Polkadot mapping fix and still reproduces the error.

Upstream HEAD `6b1eb761f4977509792868dc62e5ee52c800db30` was also inspected: its
`GeneralExtrinsic.ts` and `types-known/src/spec/statemint.ts` are byte-identical to release
commit `dd76109c422f4f872d25c4939f11a3638b531eea`. This is a **source comparison**, not a claim
to have executed an unpublished beta build.

**Decision:** a published dependency upgrade alone does not fix this incident. A decoder
change is required. A project-local chainTypes override is the deployment mechanism chosen
here; an upstream fix or a maintained patched runtime could implement the same correction.
The override is not the only theoretically possible solution, and it should be removed when
a verified upstream version supplies equivalent decoding and signed-origin behavior. It is
an indexing compatibility layer, not a general-purpose v5 transaction-signing implementation.

## Cross-Network Coverage

The fix is enabled for **Polkadot, Kusama and Westend Asset Hub in the same release**.
The decision is backed by a failing-before/passing-after matrix, not by waiting for another incident.
Real metadata captured on 2026-09-14:

| Chain | Block / parent spec | Native pipelines | Committed fixture |
|---|---|---|---|
| Polkadot AH | `20494727` / `statemint 2005000` | 0, 1 | `polkadot-ah-general-extrinsic.json`: real incident transaction + reduced metadata |
| Kusama AH | `21390618` / `statemine 2003002` | 0 | `kusama-ah-metadata.json`: reduced real metadata only |
| Westend AH | `17469988` / `westmint 1025000` | 0 | `westend-ah-metadata.json`: reduced real metadata only |

Kusama and Westend's captured blocks contain bare-v5 inherents, not signed General-v5 transactions.
The tests model pipeline 1 by copying the known Polkadot extension order and missing type graph
into each chain's own metadata. Existing target types, pallets, call/event indices, extensions and
pipeline 0 are unchanged and asserted. Envelopes are encoded independently from those SCALE types.
This models a specific shared-format upgrade; it does not assert an announced future runtime layout.

| Executed check | Stock codec | Configured chainTypes through SubQuery VM |
|---|---|---|
| Signed pipeline 1, real Polkadot metadata and modeled Kusama/Westend metadata | `Invalid data passed to Mortal era` on all three | Signer, signature, nested call, fees, bytes and hash preserved on all three |
| Synthetic General-v5 pipeline 0 with each chain's unmodified native metadata | Round-trip bytes change on all three | Exact bytes/hash; no invented signed origin |
| Signed v4 and bare v5 with native metadata | Baseline | Identical decode/hash/signature behavior, also after the modeled upgrade |
| Positive and negative entity scenarios with pipeline 1 | Cannot decode the signed input | Exact mapping outputs for all six entity types on all three manifests |

The matrix additionally covers Ed25519/Sr25519/Ecdsa, fee payment with a non-None asset,
metadata-hash mode, disabled verification, malformed lengths and unknown pipeline versions.
The same cases load each chain's **actual compiled bundle**, so deleting either new registration
makes the tests fail. Shared helpers and fixtures are in `scripts/tests/helpers/` and
`scripts/tests/fixtures/`; no production metadata is modified to create these tests.

Real historical checks through the VM also pass: Kusama block `318927` (spec 1, metadata v13,
signed `multisig.asMulti`) and Westend block `1404005` (spec 600, metadata v14, signed `proxy.addProxy`).
Both preserve the original bytes, hash and signer against the stock decoder. Reproduce with:

```bash
make podman-build
make podman-test-offline
bash scripts/podman/run.sh debug-asset-hub-block.js kusama --block=318927 --sandbox --compare
bash scripts/podman/run.sh debug-asset-hub-block.js westend --block=1404005 --sandbox --compare
```

For regeneration, see [testing before transactions appear](../development/diagnostics.md#test-a-format-before-transactions-appear).
Replace modeled pipeline metadata with a native fixture when available. Different authorization
extensions still need their own origin review; no finite synthetic suite proves arbitrary future runtimes.

## Reproduce and Verify

```bash
make podman-build
make podman-test-offline
make podman-run SCRIPT=debug-asset-hub-block.js \
  ARGS='polkadot --block=20494727 --sandbox --compare --extensions --save=/out/polkadot-20494727.json'
make podman-test-integration CHAIN=polkadot-asset-hub
```

`--save` refuses to overwrite a snapshot. On subsequent runs use `--snapshot=/out/polkadot-20494727.json`. The project verdict must pass even though the stock comparison reproduces the expected failure.

The committed reduced fixture preserves the exact transaction and the referenced SCALE types. Offline tests cover signature variants, both extension pipelines, unsigned verification, fee assets, malformed bytes, round trips, hashes and the real VM boundary. The live handler test additionally verifies fetching and dispatch through `handleNestedCalls`; the staking call deliberately creates no indexed entities.

### Indexed Data, Not Just Decoding

The incident transaction is a staking payout, not a multisig/proxy change. Its live test has
no expected entities; that alone does **not** prove correct persisted multisig or proxy data.
The offline [entity regression suite](../../scripts/tests/asset-hub-indexing.test.js), run against
all three Asset Hub manifests and chainTypes bundles, closes
the mapping-level coverage gap. It uses real runtime SCALE calls/events, SubQuery block/event
wrappers, the actual manifest filters, and `IndexerSandbox` loading the built `dist/index.js`.
Only the store is replaced; all fields passed to generated-model `save()` are inspected.

| Scenario | Assertions |
|---|---|
| v4 and v5 multisig creation, approval and proxied execution | Exact `Account`, `AccountMultisig`, `MultisigOperation`, `MultisigEvent` records; independent on-chain multisig address vector |
| Operation cancellation and failed execution | Status, depositor, original timepoint, approval/rejection links and event timestamps |
| Several multisigs and failed items in one batch | Each operation's own `callHash`/`callData`; no records from failed items |
| Remark registration | Exact account membership; no invented operation |
| Proxy creation and proxied removal | Chain/account/proxy/type/delay fields; removal uses inner real origin, not outer signer |
| Pure proxy event | Both `PureProxy` and `Proxied`, with independently verified derivation coordinates and address |
| Failed/unauthenticated calls and the original staking call | Zero store writes, not merely an empty expected-entity list |

**Limits:** entity-producing v5 envelopes/events in this suite are synthetic. Polkadot uses its
real pipeline-1 metadata; Kusama and Westend use the explicitly modeled upgrade above. These
envelopes are not cryptographically signed or executed by the
Rust runtime. The pure-proxy case deliberately reuses a historic event/address vector.
These tests prove mapping output at the store boundary, not a PostgreSQL replay of a real
on-chain v5 multisig transaction. Such a transaction and its creation history have not yet
been retained as a golden fixture. The existing live entity tests cover older transactions.
Do not describe that remaining chain-to-database evidence as already verified.

The signed-origin cases retain `AsPgas=None` and `AsDotnsGateway=None`, as in the incident.
The [PGAS extension](https://github.com/paritytech/individuality-community/blob/53482baa337278c6c4c8115fb8d2b4b5def08ccb/pallets/pgas/src/extension.rs)
and [dotNS extension](https://github.com/paritytech/individuality-community/blob/53482baa337278c6c4c8115fb8d2b4b5def08ccb/pallets/dotns-gateway/src/extension.rs)
pass that origin through. Their active proof paths require an unsigned origin and specific
PGAS/dotNS calls; they do not turn an accepted signed multisig into another signed account.
This is source verification of the runtime dependency, not an executed proof-path test.

A longer empty-DB replay on 2026-09-14 passed the original failure and reported current
height `20495470`, then failed at `20495587` on an operation created at `20415702` (before
the replay start). That is missing prior test state, not a remaining v5 decode failure;
do not bypass the operation lookup to turn an unseeded replay into a green test.

## Deploy and Recover

Build and deploy the indexer image containing the corrected chainTypes bundle, using SubQuery 6.4.6 or a separately verified newer runtime. Resume the existing checkpoint and verify that height 20494727 is passed. This runbook does not authorize a deployment, a checkpoint change or a database wipe.
