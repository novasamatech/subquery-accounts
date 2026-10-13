# TODO

## Indexer Runtime and Service Redesign

Owner: [@kogeler](https://github.com/kogeler). Tracking: [#100](https://github.com/novasamatech/subquery-accounts/issues/100).
The phases below are follow-up work; their implementation and release decisions are tracked in that issue.

The General-v5 incidents expose two separate contracts: decoding transaction bytes and determining
the authority under which a call executes. Do not extend an `isSigned` compatibility shim into a
general authorization model. Preserve the existing GraphQL/entity contract while replacing internals
incrementally; a full service rewrite is not a prerequisite for the next decoder improvement.

### Evidence and Immediate Boundary

- [x] Run SubQuery 6.4.6 with an isolated polkadot-js 17.0.2 dependency tree, then isolate native
  envelope serialization from origin adaptation. See the
  [experiment results](doc/runbooks/runtime-compatibility.md#polkadot-js-1702-runtime-experiment)
  and [general reproduction instructions](#reproducing-the-dependency-experiment).
- [x] Keep the current metadata-driven decoder on the production dependency pins. The smaller
  native-decoder candidate handles the incident blocks but does not yet satisfy the complete contract.
- [x] Make stock-only pipeline probes reject a lost authenticated signer, not just malformed bytes.
- [x] Remove decoder-specific extension-field layout assumptions from the synthetic transaction helper
  and test an explicitly modeled change to a known extension's SCALE type.

### 1. Dependency and Codec Upgrade

- [ ] Turn the experimental image overlay into a supported, locked dependency build. Align runtime,
  project packages, visitor and crypto dependencies deliberately; document peer-range exceptions.
  Validate both runtime image publishers and record immutable digests. Do not change only package.json.
- [ ] Prepare an upstream reproduction for duplicate General-v5 envelope serialization, including
  direct GeneralExtrinsic, outer Extrinsic, cloning, vectors and CJS/ESM entry points. The local
  experiment's guarded patch is evidence, not an approved production patch.
- [ ] Require metadata lookup types for every v5 extension, including familiar identifiers. Resolve
  unknown-version fallback, canonical-byte validation, absent-extension defaults and fee-asset API
  shape differences before removing MetadataGeneralExtrinsic.
- [ ] Separate historical tests that reproduce a particular stock-library defect from positive
  compatibility tests. A repaired dependency must not prevent the positive assertions from running.

### 2. Stable Transaction and Origin Contracts

- [ ] Introduce an SDK-independent decoded transaction boundary containing authoritative raw bytes/hash,
  format/preamble, extension version, ordered extension values/type identifiers and decoded call.
  Keep wire-format signedness separate from authentication and effective dispatch origin.
- [ ] Cache runtime context by chain genesis and runtime/metadata identity. Explicitly test execution
  with parent-runtime metadata at upgrade boundaries; never reuse current metadata for historic blocks.
- [ ] Build a versioned origin resolver with distinct known-account, known-custom-origin, none and
  unknown outcomes. Cover VerifyMultiSignature, origin-transforming extensions, People wrappers,
  proxy/multisig nesting and AccountId20/AccountId32 without pretending these are one signature scheme.
- [ ] Evaluate unknown origins before call filters. Save raw evidence, alert and stop before advancing
  the checkpoint when correctness cannot be established. Unknown must not silently become unsigned.
- [ ] Define reviewed authorization profiles against runtime identity and pipeline/type fingerprints.
  Unchanged metadata does not prove unchanged authorization code. Arbitrary future runtime behavior
  cannot be inferred from SCALE metadata alone; retain source review or execution-backed evidence.

### 3. Incremental Service Replacement

- [ ] Separate acquisition/runtime-context management, decoding, origin/call traversal, domain entity
  updates and persistence. Keep vendor codecs out of the domain and storage interfaces.
- [ ] Compare a maintained decoder/client against the same snapshot corpus before selecting a new
  stack. Evaluate PAPI/Dedot or a Rust decoder without committing to a full migration first. Preserve
  a historical path: PAPI requires metadata >=14, while our Kusama history includes v13.
- [ ] Run the replacement in shadow mode against the current indexer: compare normalized calls,
  origins, entity fields and relationships without writing into production tables.
- [ ] Verify restart/replay idempotency, transactional entity/checkpoint updates, reorg handling,
  RPC failover and bounded retries/backpressure with PostgreSQL, not only an in-memory store.
- [ ] Preserve GraphQL compatibility and global accounts/account_multisigs ownership. Any reindex,
  database wipe or production checkpoint change needs separate explicit authorization.

### 4. Release Gates and Upgrade Detection

- [ ] Keep old/candidate differential tests for every indexed network and supported historical era:
  v4, bare/general v5, metadata versions, both account widths, fee assets, all pipelines and runtime
  upgrade boundaries. Clearly distinguish captured transactions from modeled upgrades.
- [ ] Add property-based malformed-input and extension-layout tests plus an independent decoder oracle.
  Assert original bytes/hash, authorization, traversal and final entities, not just successful parsing.
- [ ] Retain a real on-chain General-v5 multisig/proxy transaction with its preceding creation history
  and verify the full chain-to-PostgreSQL result. Synthetic entity fixtures do not close this gap.
- [ ] Extend the existing pipeline scanner into a reviewed runtime-upgrade gate. Detect new pipelines
  and type/authorization changes before deployment where possible, with explicit unsupported results.
- [ ] Define migration acceptance and rollback against saved checkpoints: no lost or extra entities,
  no byte/hash drift, crypto canary intact, bounded resource usage and a reproducible locked build.

### Reproducing the Dependency Experiment

The one-off Dockerfile, dependency-overlay/patch helpers and experiment-specific CLI option are not
maintained in this repository. Recreate candidates in disposable containers using the existing
[Podman workflows](doc/development/podman.md) and [diagnostics](doc/development/diagnostics.md).
The [2026-10-09 evidence](doc/evidence/general-v5-api17-experiment.json) records the original versions,
image identities, lock/patch fingerprints and results; its test counts are historical.

1. Establish a baseline with `make podman-build` and `make podman-test-offline`. Reuse saved raw-block
   snapshots for Asset Hub 20494727 and People 10709657, including parent-runtime metadata and genesis.
   If missing, capture them with `debug-asset-hub-block.js --save` before comparing candidates. Record
   input fingerprints and use those same bytes throughout; reduced test fixtures are not full snapshots.
2. Install exact candidate API/types versions in a fresh named volume, with a separate cache volume,
   using rootless Podman only. Bound installs (the experiment used 300 seconds), retain the lockfile and
   replay it with `npm ci`; a new transitive resolution is a different experiment. Mount repository
   source read-only and keep RPC credentials in a mode-0600 env-file outside the repository.
3. First compare codecs with the existing `--api-root` and `--no-types` options, mounting the candidate
   installation into the diagnostic container. This does not upgrade the SubQuery runtime. For the
   runtime comparison, build a disposable local image from a pinned SubQuery base using a temporary
   build context outside the repository. Replace whole dependency packages from the locked candidate
   tree, including transitives; record versions and resolution paths from SubQuery, node-core and
   common-substrate, and restore uid 1000. Keep production pins, Compose and CI unchanged. The original
   comparison used SubQuery 6.4.6, API/types 17.0.2 and util/crypto 14.0.3, not a peer-aligned release.
4. Separate native behavior, any proposed envelope repair, and origin adaptation. In the 17.0.2
   experiment the repair inserted the following at the start of `GenericExtrinsic.toU8aInner()` in
   both `@polkadot/types/cjs/extrinsic/Extrinsic.js` and `@polkadot/types/extrinsic/Extrinsic.js`:

   ```javascript
   if (this.isGeneral() && this.inner.preamble === PreambleMask.general) {
     return [this.inner.toU8a(true)];
   }
   ```

   This is historical reproduction detail, not an approved production patch. Check the source/version
   before applying it once, record before/after hashes, and test direct/outer codecs, clones, vectors
   and both module formats. The guard preserves the project's payload-only inner codec.
5. To isolate origin adaptation, clone the built baseline workspace into a fresh named volume and
   remove only `GeneralExtrinsic: MetadataGeneralExtrinsic` from `withMetadataExtrinsic` in that copy.
   Keep `Extrinsic: MetadataExtrinsic` and rebuild with `yarn build` inside a build container. Do not
   run `podman-compile` on this clone: source synchronization would restore the original registration.
   Select this workspace with `WORKSPACE_VOLUME`; no special diagnostic flag is needed.
6. Run the same offline corpus for the unmodified and repaired candidate images, first with the full
   project adapter, then with the origin-only workspace. For each image, use the normal commands below
   after setting `CANDIDATE_IMAGE` to its local tag and `CANDIDATE_WORKSPACE` to the built named volume:

   ```bash
   make podman-test-offline SUBQL_NODE_IMAGE="$CANDIDATE_IMAGE" WORKSPACE_VOLUME="$CANDIDATE_WORKSPACE"
   SUBQL_NODE_IMAGE="$CANDIDATE_IMAGE" WORKSPACE_VOLUME="$CANDIDATE_WORKSPACE" \
     bash scripts/podman/run.sh debug-asset-hub-block.js polkadot \
     --snapshot=/out/polkadot-20494727.json --sandbox
   SUBQL_NODE_IMAGE="$CANDIDATE_IMAGE" WORKSPACE_VOLUME="$CANDIDATE_WORKSPACE" \
     timeout --signal=TERM 120s bash scripts/podman/block-test.sh \
     project-polkadot-people-chain.yaml 10709657 --workers=1
   ```

   Also inspect the People snapshot with `project-polkadot-people-chain.yaml`; repeat snapshot checks
   with `--no-types` to isolate native codecs. Save separate `--report` files for each variant.
   Check the authenticated account against independent evidence: snapshot decode success alone does
   not assert it, and `--compare` treats an intentional origin correction as a mismatch.
7. Classify failures rather than simply counting them: historical stock-defect assertions may fail
   after a repair, while known-extension SCALE types, malformed input, absent defaults and fee-asset
   accessor differences still need independent checks. Verify raw bytes/hash, the crypto canary,
   origin and final entities through the real VM. Retain a bounded PostgreSQL replay, distinguishing
   timeout/shutdown errors from indexing failures and synthetic entity coverage from on-chain proof.
   Preserve locks, image identities, reports and logs in diagnostic storage. Remove temporary credential
   files, but do not wipe evidence, production data or checkpoints as part of this experiment.

References: [runtime compatibility](doc/runbooks/runtime-compatibility.md),
[General-v5 evidence](doc/runbooks/asset-hub-v5.md),
[PAPI requirements](https://papi.how/requirements/).
