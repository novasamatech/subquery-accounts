# General-v5 Decode Failures (Asset Hub, People, All Networks)

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

Symptom on any network: `createType(GeneralExtrinsic):: ... on era ...: Invalid data passed to Mortal era`
while fetching a block. Two incidents are recorded here; the fix and its verification now cover
[every indexed network](#all-network-assessment).

## Incident

**Verified incident:** Polkadot Asset Hub block `20494727`, hash `0x4e321bc81810ce34496e8395ad6bb329f25ac972ad8aa9601b2aab9973d3aa86`, parent runtime `statemint 2005000`, extrinsic index `2`.

The transaction starts with the v5 general preamble `0x45` and selects transaction extension pipeline `1`. Metadata v16 lists its extensions in a different order from pipeline `0`, including `VerifyMultiSignature`, `AsPgas`, `AsDotnsGateway`, and `RestrictOrigins` before mortality/nonce/payment fields. polkadot-js uses its legacy signed-extension field list instead, so signature bytes are incorrectly read as `era`.

**Dependency verification (2026-09-14):** SubQuery `6.4.6` bundles polkadot-js `16.5.3`; the project's pinned version is `16.5.4`. The latest published `@polkadot/api`/`@polkadot/types` `16.5.6` also fails on the exact same raw transaction and metadata. Updating the project's `package.json` alone does not replace the separate decoder in the indexer image.

**Fix:** `chainTypes/metadataExtrinsic.ts` (originally `assetHubExtrinsic.ts`, registered by the three Asset Hub bundles; since the [People incident](#polkadot-people-incident) by every manifest through `withMetadataExtrinsic`) selects each general extrinsic's extension pipeline and SCALE types from metadata. It preserves the original encoding/hash and exposes `VerifyMultiSignature`'s account/signature so `isSigned: true` filters and the call visitor process these transactions. v4 and bare v5 delegate to the stock codec. Codec constructors return instances created by the runtime registry to avoid cross-VM `Uint8Array` incompatibility.

**Verification:** use the [single-block diagnostic](../development/diagnostics.md#single-block-decode) and `make podman-test`. The failing call is `utility.forceBatch([staking.payoutStakers(...)])`. A dictionary HTTP 503 in the same logs is a separate service failure; it does not explain deterministic SCALE decoding errors.

After an upstream decoder fix is released, replay the saved block with that dependency version before removing this compatibility layer. Restarting the fixed indexer from its existing checkpoint is sufficient for this fetch failure; do not skip the block or wipe chain data.

## Polkadot People Incident

**Verified incident (2026-10-09):** the production `project-polkadot-people-chain.yaml` indexer stopped
at block `10709657`, hash `0x75311b63e16ccfcf97a50e8a57668f7600e4414d54f3c157b14e5f4929566925`,
parent runtime `people-polkadot 2005000`, extrinsic `2`, with the same `Mortal era` error. The Asset Hub
decoder existed, but the People manifest registered no chain types, so the stock codec was used.

[polkadot-fellows/runtimes v2.5.0](https://github.com/polkadot-fellows/runtimes/blob/3936c7e4d42b449b964e41bd7b69d5f1db1e3a1f/system-parachains/people/people-polkadot/src/lib.rs#L141-L180)
adds pipeline 1: `UnitTransactionExtension, VerifyMultiSignature, AsPerson, PeopleLiteAuth, AsMember,
AsCoinage, AsResources, AuthorizeCall, RestrictOrigins`, then the standard checks. The transaction
(hash `0xd254095caa53b7ba628e35aebe2e4df22f2baeff7bedfca7c4659510af8a0542`) is
`coinage.loadRecyclerWithExternalAssetUnpaid`, `VerifyMultiSignature.Signed` by
`5GNMCbHeCyVkh6W22WXA8iiYRzKpviRNjEtiViPWGeb3mz6K`, `AsCoinage::InfallibleUnpaidSigned`,
`RestrictOrigins=true`. Its `coinage.RecyclerLoadedWithExternalAsset.who` event independently confirms the signer.

**Fix:** the metadata-driven decoder is registered for every manifest (see below). Its `tip`/`assetId`/`mode`
accessors no longer assume `ChargeAssetTxPayment` and `CheckMetadataHash`: on a pipeline paying with
`ChargeTransactionPayment` (e.g. Kusama People) a signed v5 transaction's `tip` or `toHuman()` would have thrown.
The new People authorizers and the `peopleLite.dispatchAsSigner` wrapper were reviewed in source;
see [handler section 16](handlers.md#16-people-peoplelitedispatchassigner-wraps-multisigproxy-calls).

**Verification:** `scripts/tests/fixtures/polkadot-people-general-extrinsic.json` keeps the raw transaction,
its three event records and reduced metadata. `people-general-extrinsic.test.js` reproduces the stock error,
decodes directly and through the SubQuery VM with exact bytes/hash and the event's signer, and dispatches the
real records through the manifest filters with zero store writes (the call is not multisig/proxy related).
A full replay passed the block and indexed beyond `10713172` without errors before its wall-clock limit:

~~~bash
bash scripts/podman/run.sh debug-asset-hub-block.js project-polkadot-people-chain.yaml --block=10709657 \
  --sandbox --compare --events --calls --save=/out/polkadot-people-10709657.json
make podman-build && make podman-test-offline
timeout --signal=TERM 180s bash scripts/podman/block-test.sh project-polkadot-people-chain.yaml 10709657 --workers=1
~~~

**Recovery:** deploy the corrected image through the normal authorized release and resume the existing
checkpoint. Neither a block skip nor a database wipe is needed.

## All-Network Assessment

polkadot-js 16.5.x decodes every General-v5 transaction (preamble `0x45`) with the v4 extension list
and ignores the pipeline version byte:

- a pipeline with authorizers before the standard checks (pipeline 1 on Polkadot AH and People) fails
  at `era`, which stops the indexer;
- pipeline 0 decodes, but re-encoding adds bytes, so the extrinsic hash is silently wrong.

Any runtime with metadata v16 can add a pipeline in a later upgrade without a spec-name change, so every
manifest registers the decoder through `withMetadataExtrinsic`. v4 and bare v5 keep the stock codec.
`manifest-chaintypes.test.js` decodes the real Asset Hub and People pipeline-1 transactions through each
manifest's VM bundle, so a new manifest without it fails the offline suite.

Evidence combines the September Asset Hub captures, the People incident transaction, and metadata
captured on 2026-10-09 (`--finalized --metadata-fixture` for the newly assessed networks).
Mythos was checked separately on 2026-10-13 (see below).

| Networks | Runtime / metadata | Pipelines | Coverage |
|---|---|---|---|
| Polkadot Asset Hub | `statemint 2005000`, v16 | 0, 1 (`AsPgas`, `AsDotnsGateway`) | Real incident transaction, modeled entities |
| Polkadot People | `people-polkadot 2005000`, v16 | 0, 1 (Individuality) | Real incident transaction, entities, `dispatchAsSigner` |
| Kusama AH, Kusama People, Polkadot/Kusama relay, Polkadot/Kusama Coretime, Polkadot Collectives | `2003002`–`2005000`, v16 | 0 | Real metadata + modeled pipeline 1, entities |
| Westend AH, Westend relay | `1025000`, `1025001`, v16 | 0 | Real metadata + modeled pipeline 1, entities |
| Bittensor, Hydration | `node-subtensor 475`, `hydradx 447`, v16 | 0 | Same; their 4-field `PureCreated` has no event coordinates to test |
| Moonbeam, Moonriver | `4401`, v16 | 0 | Real metadata, unsigned v5 model; signed-v4 proxy entities with native and modeled metadata |
| Avail, Aleph Zero | `avail 56`, `aleph-node 15000000`, v14 | none | Registration and real-block parity; v5 needs a runtime upgrade first |
| Mythos | `mythos 1006`, `1021`, v14 | none | Registration and real-block parity: signed v4 proxy call, bare v5, AccountId20 |
| Rococo, Novasama testnet | — | — | Registration only: no reachable RPC (Rococo is retired) |

A modeled pipeline 1 prepends the reference family's authorizers (Polkadot People for People, Polkadot
Asset Hub otherwise) to the network's own pipeline 0, preserving its fee extension and v4 decoding.
On People this moves the zero-byte `AuthorizeCall` after `RestrictOrigins`; it is a SCALE decoding
model, not an execution model of the reference runtime's authorization logic.
`--compare --sandbox` on a finalized block of every reachable network, including 12 signed v4 Bittensor
and 2 signed v4 Avail transactions, showed no stock/project difference. The live
[pipeline scanner](../development/diagnostics.md#transaction-extension-pipelines) passed on all 17 reachable
networks; the manifest endpoints of Kusama, Westend, Hydration, Moonbeam, Moonriver, Mythos and Rococo did
not resolve from the verification host, so public alternatives were used through `RPC_ENDPOINT_OVERRIDE`.
That scan was performed on 2026-10-09; Mythos became the 18th verified network in the review checks below.

**Limits:** modeled pipelines and envelopes are synthetic. Signed-origin semantics recognize only
`VerifyMultiSignature.Signed`; a different authorizer (for example an Ethereum-signature scheme on
Moonbeam) would decode but be treated as unsigned, which loses data rather than stopping the indexer.
Review such an upgrade as in [handler section 16](handlers.md#16-people-peoplelitedispatchassigner-wraps-multisigproxy-calls).
Run the scanner after runtime upgrades; it exits 1 when a configured decoder fails on an advertised pipeline.

**Codec contract:** this is a read-only block-decoding adapter, not a complete replacement for the
General-v5 builder/signing API. Raw `Extrinsic` decoding and cloning an existing `GenericExtrinsic`
are covered; creating General-v5 from a plain method object or directly cloning its inner `Struct`
is not supported. Accessors recognize the named standard extensions, not arbitrary future semantics.
The registry-created objects and property adapters are required by the current SubQuery VM integration;
the `CodecClass` cast does not prove full API compatibility.

The decoder now checks exact payload re-encoding, not only its length. The stock bool codec accepts
byte `2` as false and emits `0`, which previously changed the transaction hash without a decode error.
The regression rejects this non-canonical input both directly and in the VM. Every truncation of the
incident payload (including with a rewritten envelope length) is rejected. Mixed `Vec<Extrinsic>` tests
retain General-v5, signed-v4 and bare-v5 boundaries: bytes after one envelope belong to the next item
and must not be rejected as trailing payload. These malformed-input tests do not imply that a valid
on-chain transaction with this bool encoding exists.

### Mythos Review Verification

On **2026-10-13**, the DMarket RPC from the
[polkadot-js provider list](https://github.com/polkadot-js/apps/blob/9d8e9469c490fac8a80e173bfd37534e9d7906ad/packages/apps-config/src/endpoints/productionRelayPolkadot.ts#L544-L555)
was used through `RPC_ENDPOINT_OVERRIDE`. The manifest's genesis hash matched. Both captures used
parent-runtime metadata and `--compare --sandbox`, loading `metadataExtrinsicChaintypes` in the real VM:

- Finalized block **11685954**, `mythos 1021`, metadata v14: both bare-v5 inherents retain their bytes/hash.
- Historical block **1078220**, `mythos 1006`, metadata v14: all three extrinsics match stock decoding,
  including signed-v4 `proxy.createPure` at index 2. Its AccountId20 signer is
  `0x6cb0779830b493717b00906989E84D4605BDCEf4`; its hash is
  `0xdf7942179676289a9d27c1e2c458bac3213973eb979b564e1985557521c2db43`.
- The pipeline scanner passes with metadata v14 and no advertised General-v5 pipelines. This closes
  the real-block parity gap, not future General-v5 authorization or chain-to-PostgreSQL entity coverage.

[Review evidence](../evidence/mythos-review-2026-10-13.json) records input fingerprints and results.
Full snapshots and reports remain in `subql-diagnostics` as `mythos-review-2026-10-13-*.json`; both were
also replayed offline with the same byte/hash and signer assertions.
A future metadata/format upgrade on this AccountId20 network needs its own authorization review and tests.

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

### October Dependency Recheck

On **2026-10-09**, a clean, isolated installation of `@polkadot/api`, `@polkadot/types` and
`@polkadot/types-known` **17.0.2** was replayed against the same full Asset Hub snapshot and the
People incident snapshot, without RPC or project types. Both stock runs decode the two bare-v5
inherents, but fail the exact byte round-trip assertion on General-v5 extrinsic `2`. The error is
no longer `Mortal era`; that change alone is not sufficient to replace the adapter.

On the same inputs, the hardened project adapter through the SubQuery VM with the image's `16.5.3`
passes all three extrinsics on both networks, including bytes, hash and authenticated signer.
[Review evidence](../evidence/general-v5-review-2026-10-09.json) retains package versions, input
fingerprints and the results. No production dependency or indexer image was upgraded for this probe.
Full `--report` outputs and snapshots remain in the `subql-diagnostics` volume; candidate packages
remain in the separate `subql-api-v5-review-1702` volume.

The subsequent [actual-runtime experiment](runtime-compatibility.md#polkadot-js-1702-runtime-experiment)
isolates envelope serialization from origin adaptation inside SubQuery. The smaller candidate passes
the real incident snapshots, but strict-input and metadata-type contracts still prevent removing the
current inner decoder. Production dependency pins remain unchanged.

## Cross-Network Coverage

The fix was first enabled for **Polkadot, Kusama and Westend Asset Hub in the same release**; the
[all-network assessment](#all-network-assessment) extends the same matrix to every reachable network.
The decision is backed by a failing-before/passing-after matrix, not by waiting for another incident.
Real metadata captured on 2026-09-14:

| Chain | Block / parent spec | Native pipelines | Committed fixture |
|---|---|---|---|
| Polkadot AH | `20494727` / `statemint 2005000` | 0, 1 | `polkadot-ah-general-extrinsic.json`: real incident transaction + reduced metadata |
| Kusama AH | `21390618` / `statemine 2003002` | 0 | `kusama-ah-metadata.json`: reduced real metadata only |
| Westend AH | `17469988` / `westmint 1025000` | 0 | `westend-ah-metadata.json`: reduced real metadata only |

Kusama and Westend's captured blocks contain bare-v5 inherents, not signed General-v5 transactions.
The tests model pipeline 1 by importing the Polkadot authorizers and their type graph into each chain's
own metadata, followed by that chain's pipeline 0. Existing target types, pallets, call/event indices, extensions and
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
