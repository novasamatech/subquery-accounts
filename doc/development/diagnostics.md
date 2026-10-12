# Diagnostic Tool Catalog

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

## Choose by Question

| Question | Tool in `scripts/diagnostics/` | Needed input | Verdict / output |
|---|---|---|---|
| Why can this block not decode? Would another dependency fix it? | `debug-asset-hub-block.js` | Asset Hub alias or `project-<slug>.yaml` + height/hash/`--finalized`, or saved snapshot | Per-extrinsic decode, origin, hash, byte checks; stock/project parity; optional metadata pipelines |
| Which nested call and events caused a mapping failure? | `debug-asset-hub-block.js --calls --events` | Network + block/extrinsic, or snapshot with events | Decoded call arguments and events; optional raw event fixture |
| Which networks advertise General-v5 pipelines, and can each configured decoder handle them? | `scan-extension-pipelines.js` | Optional manifest slugs; manifest RPCs | Per-network pipelines with stock/project verdicts; exit 1 on a decoder failure |
| Did an Asset Hub runtime transition move? | `scan-spec-starts.js` | Optional chain; archive RPC | Candidate spec-to-first-block JSON |
| Does fee-asset decoding work across historical eras? | `scan-asset-hub-decode.js` | Chain, built chainTypes, optional extra heights | Current and alternative type-boundary results |
| What is the on-chain signed-extension type? | `scan-signed-extensions.js` | Chain and shared spec map | Metadata types, including `ChargeAssetTxPayment` |
| Which eras contain a given call? | `scan-methods-by-spec.js` | Chain, optional target methods | Sample calls per era |
| Where did an old Kusama multisig call hash come from? | `debug-kusama-multisig-block.js` | Kusama height | Event fields and extrinsic fallback |
| Is STG missing/different from PROD? | `compare-stg-prod.js` | Public GraphQL endpoints; defaults provided | Read-only entity diff; [comparison runbook](../runbooks/stg-prod.md) |

## Common Runner

~~~bash
make podman-run SCRIPT=debug-asset-hub-block.js ARGS='polkadot --block=20494727 --sandbox --compare'
bash scripts/podman/run.sh debug-asset-hub-block.js --help
~~~

Use the direct Bash form for arguments needing precise shell quoting. `ARGS` is shell syntax, not a
secret store. The runner forwards each argument to Node, mounts source read-only, optionally mounts
an existing build volume at `/work`, and stores output under `/out`. No build is required for GraphQL
comparison or metadata-only tools. Project decoding requires `make podman-build` first.

Private RPC URLs belong in an ephemeral mode-0600 env-file outside the repository:
`ENV_FILE=/tmp/subql-rpc.env bash scripts/podman/run.sh ...`.
The single-block tool, the pipeline scanner and the full replay read `RPC_ENDPOINT_OVERRIDE` (HTTP/S
for the first two; the single-block tool also accepts the legacy `ASSET_HUB_ENDPOINT`).
Do not put private URLs on the command line, in YAML defaults, in
permission allowlists, or in committed snapshots. Remove the env-file after use.
Older scan tools print their configured endpoint; use them only with public endpoints.

## Single-Block Decode

The tool fetches raw JSON-RPC block bytes before decoding and uses the parent's runtime metadata,
including at an upgrade boundary. It prefers metadata v16 when available and falls back on older chains.

~~~bash
make podman-build
bash scripts/podman/run.sh debug-asset-hub-block.js polkadot --block=20494727 \
  --sandbox --compare --extensions --save=/out/polkadot-20494727.json
bash scripts/podman/run.sh debug-asset-hub-block.js polkadot \
  --snapshot=/out/polkadot-20494727.json --sandbox --compare
~~~

- Networks: Asset Hub aliases `polkadot`, `kusama`, `westend` (or `statemint`, `statemine`, `westmint`),
  or any manifest as `project-<slug>.yaml`, which supplies the endpoint and chain types. Manifest mode
  records the genesis hash in new snapshots and refuses a snapshot from another network or without one.
- Choose exactly one `--block=N`, `--hash=0x...`, `--finalized` (current finalized block), `--snapshot=FILE`.
- `--extrinsic=N` narrows output; `--extensions` shows the per-version extension pipeline and SCALE types.
- `--calls` prints the full decoded arguments, including nested calls.
- `--events` fetches `System.Events` at the selected block with the same 20-second request bound,
  prints the selected events and includes their raw SCALE bytes in `--save`. Snapshot replay
  requires events to have been captured already and never makes a supplementary RPC request.
- `--compare` shows stock then project, with the exit verdict based on the project. Every extrinsic the
  stock codec decodes must decode identically (method, origin, hash); otherwise `MISMATCH` and exit 1.
- `--no-types` tests only the stock decoder; it is mutually exclusive with `--compare`.
- `--sandbox` loads the compiled bundle via the actual SubQuery VM.
- `--project-root` defaults to `PROJECT_ROOT` (the runner sets `/work`).
- `--api-root=DIR` resolves polkadot-js from another dependency installation.
  Use `/` for runtime packages, `/work` for project packages, or mount a candidate installation.
- `--known-types-root=DIR` replaces only `@polkadot/types-known` for a focused type-bundle test.
  Its transitive dependencies can produce mixed-version warnings; also test a coherent full upgrade.
- `--report=FILE` saves actual versions/resolution paths, metadata/raw-transaction SHA-256
  fingerprints and per-extrinsic results as JSON. It creates a mode-0600 file without overwrite.
- `--fixture=FILE --extrinsic=N` exports one raw transaction plus reduced v16 metadata for
  indexer call/event tests. SCALE IDs and variant indices are retained. Unsupported metadata
  versions or missing required pallets/calls fail explicitly; the file is mode 0600, no overwrite.
- `--metadata-fixture=FILE` exports reduced real metadata with chain/block/hash provenance,
  without requiring or inventing a transaction. It has the same version, permission and overwrite checks.
- `SUBQL_ROOT` identifies the runtime installation used for the VM loader; default `/`.
- `--save` creates a new mode-0600 snapshot and refuses overwrite. It stores no endpoint.
- Exit: `0` selected decoder passes, `1` decoding/round-trip/hash check fails, `2` invalid input or RPC/setup failure.
  Each HTTP request is bounded to 20 seconds; snapshot replay needs no RPC.

### Create a Mapping Fixture

~~~bash
bash scripts/podman/run.sh debug-asset-hub-block.js polkadot \
  --snapshot=/out/polkadot-20494727.json --sandbox --extrinsic=2 \
  --fixture=/out/polkadot-ah-indexer-fixture.json
~~~

Review the generated candidate before updating `scripts/tests/fixtures/`. The reducer in
`scripts/lib/metadata-fixture.js` retains transaction extensions and the indexer's System,
Utility, Multisig and Proxy call/event dependencies, plus `Staking.payout_stakers`, MetaTx and
`PeopleLite.dispatch_as_signer` when the runtime has them, without
copying the full runtime metadata or editing SCALE hex manually. When the snapshot contains
events, the fixture also retains every raw `EventRecord` belonging to the selected extrinsic,
including its original phase and topics, and the metadata needed to decode those events.
Without `--events`, no event values are fetched. The tool does not execute mappings.
The exit verdict still describes decoding; a stock failure can coexist with a successful raw export.

Use `scripts/tests/helpers/indexer.js` to dispatch metadata-encoded calls/events through real
manifest filters and the built SubQuery VM mappings, then assert final records at the store
boundary. Synthetic envelopes use copied signatures only as SCALE data and must never be
submitted to a chain. Keep real-chain and synthetic evidence distinct in the incident runbook;
see [v5 indexed-data verification](../runbooks/asset-hub-v5.md#indexed-data-not-just-decoding).

The [MetaTx runbook](../runbooks/handlers.md#15-westend-asset-hub-metatx-dispatch-hides-a-threshold-one-multisig)
has a complete event-fixture capture and mapping-replay example.

### Test a Format Before Transactions Appear

~~~bash
bash scripts/podman/run.sh debug-asset-hub-block.js kusama --block=21390618 \
  --sandbox --save=/out/kusama-21390618.json --metadata-fixture=/out/kusama-ah-metadata.json
bash scripts/podman/run.sh debug-asset-hub-block.js westend --block=17469988 \
  --sandbox --save=/out/westend-17469988.json --metadata-fixture=/out/westend-ah-metadata.json
make podman-test-offline
~~~

Review the reduced metadata and provenance before updating the committed fixtures. Store real
metadata only; generate hypothetical upgrades at test time, never label them on-chain metadata.
`scripts/tests/helpers/transaction-pipeline.js` models a known extension pipeline from a reference
runtime: its authorizers (extensions absent from the reference pipeline 0) and their portable type graph
are prepended to the target's own pipeline 0, so the target keeps its fee extension and v4 decoding.
It preserves the target's existing types, call/event indices, extensions and pipeline 0, which the
network matrix asserts independently. People's zero-byte `AuthorizeCall` moves after `RestrictOrigins`
in this model; the tests verify SCALE decoding, not the runtime's authorization execution.
`projectPallet` models a missing pallet such as MetaTx or PeopleLite.
The encoder then builds synthetic envelopes from those SCALE types without using the decoder
under test. Signatures are test bytes, not runtime-authorized transactions.

`scripts/tests/helpers/network-cases.js` binds each fixture to its actual manifest and compiled
chainTypes bundle, keyed by manifest slug. Both decoder and entity suites consume these cases. To refresh
or add a network, capture its current runtime with
`debug-asset-hub-block.js project-<slug>.yaml --finalized --save=... --metadata-fixture=...`. Extend them for a shared
format bug even when only one network currently exposes it; keep native and modeled results separate.
Replace a modeled case with real captured metadata when that pipeline is available, and retain
historical fixtures when they protect a distinct compatibility boundary.

### Compare a Dependency Upgrade

Capture once, then replay the same snapshot. Do not change the RPC, block and dependency all at once.
Install a candidate version into a disposable container volume, never on the host or into the project
lockfile merely to test it. This example pins the candidate to the version from the v5 incident;
substitute a deliberately chosen version when testing a future release.

~~~bash
podman run --rm -v subql-api-candidate:/probe -w /probe docker.io/library/node:24-alpine \
  npm install --ignore-scripts --no-audit --no-fund --save-exact \
  @polkadot/api@16.5.6 @polkadot/types@16.5.6 @polkadot/types-known@16.5.6
podman run --rm --network=none --entrypoint node \
  -v "$PWD":/src:ro,Z -v subql-diagnostics:/out -v subql-api-candidate:/probe:ro \
  docker.io/subquerynetwork/subql-node-substrate:v6.4.6 \
  /src/scripts/diagnostics/debug-asset-hub-block.js polkadot \
  --snapshot=/out/polkadot-20494727.json --no-types --api-root=/probe --report=/out/candidate.json
podman volume rm subql-api-candidate
~~~

Repeat the replay before deleting the candidate volume, replacing `--api-root=/probe` with
`--known-types-root=/probe`, to test only its native chain type definitions. Choose a different report
filename for every run. Compare fingerprints before comparing outcomes; use the full saved metadata,
not a fixture reduced differently for each candidate.

The tool prints actual `packageInfo.version` values for API, types and types-known, with resolved paths.
Runtime images may strip `package.json.version`;
do not infer a runtime package version from the project's resolutions or from the image tag alone.
For the verified September 2026 incident see the [v5 runbook](../runbooks/asset-hub-v5.md).

## Transaction-Extension Pipelines

~~~bash
make podman-build
bash scripts/podman/run.sh scan-extension-pipelines.js --sandbox --report=/out/pipelines.json
ENV_FILE=/tmp/subql-rpc.env bash scripts/podman/run.sh scan-extension-pipelines.js kusama --sandbox
~~~

For each manifest (default: all; or the given slugs) the scanner checks that the RPC genesis equals
the manifest `chainId`, reads the finalized runtime's metadata and, for metadata v16, encodes a synthetic
`system.remark` for every advertised pipeline (signed through `VerifyMultiSignature` where present). It
decodes each with the stock codec and with the manifest's chain types, requiring an exact round trip, hash
and origin for both decoders, including stock-only runs. A native General-v5 codec reporting unsigned
for a known authenticated probe fails the indexer-compatibility check even if its bytes are correct.
`--no-types` reports the stock verdict only. `RPC_ENDPOINT_OVERRIDE` is accepted for exactly
one manifest. `--report` writes a mode-0600 JSON file without overwrite. Each request is bounded to 20 seconds.

Exit: `0` every advertised pipeline decodes, `1` a configured (or, with `--no-types`, stock) decoder fails,
`2` invalid input, RPC/setup failure or an unsupported probe (unless a decoder failure already yields `1`).
Signed probes require AccountId32; an AccountId20 runtime advertising `VerifyMultiSignature` fails
explicitly until its authorization is reviewed and the probe is extended. It checks the current runtime only, synthetic
envelopes only, and only `VerifyMultiSignature` signed origins; a new authorization extension still needs
a source review. Run it after runtime upgrades; see the [v5 assessment](../runbooks/asset-hub-v5.md#all-network-assessment).

## Spec Transitions

~~~bash
bash scripts/podman/run.sh scan-spec-starts.js polkadot --dry-run
bash scripts/podman/run.sh scan-spec-starts.js polkadot --output=/out/asset-hub-spec-blocks.json
~~~

Omit the chain to scan all three. Usually takes 6-15 minutes per chain; incomplete archive nodes can
give node-dependent results. The shared input is `scripts/data/asset-hub-spec-blocks.json`.
Review the generated candidate against that tracked file before updating it; no scan writes to the
read-only repository mount. Do not blindly replace a full map with results from a pruned RPC.

## Historical Decode and Methods

~~~bash
make podman-build
bash scripts/podman/run.sh scan-asset-hub-decode.js polkadot --extra=4176632,6172745
bash scripts/podman/run.sh scan-signed-extensions.js kusama
bash scripts/podman/run.sh scan-methods-by-spec.js kusama --targets=multisig.asMulti,proxy.proxy
~~~

Aliases are listed in each tool's source header. The decode scanner compares the current chainTypes
with alternative `NovaAssetId` boundaries. The method scanner samples calls per era. These are
historical sampling tools, not exhaustive chain proofs or substitutes for raw single-block replay.
Their older ApiPromise setup can reconnect indefinitely on an unavailable WS endpoint; interrupt
such runs and use the bounded HTTP single-block tool for incident triage.

## Kusama Multisig

~~~bash
bash scripts/podman/run.sh debug-kusama-multisig-block.js --block=2016479
bash scripts/podman/run.sh debug-kusama-multisig-block.js --block=2704203
~~~

Prints runtime version, event fields and call-hash sources. See [Kusama history](../runbooks/kusama-multisig.md)
before modifying utility-era handlers. Public Kusama RPCs may be intermittent; a reconnect loop is not
evidence of a parser regression.

## Add or Extend a Tool

1. Start from this catalog and reuse the closest tool. Extend it if the question fits its purpose.
2. Put a new command in `scripts/diagnostics/`, shared logic in `scripts/lib/`, immutable inputs in
   `scripts/data/` or test fixtures. Shared modules must not execute a CLI when imported.
3. Accept chain/block inputs, bound network waits, validate arguments, and return meaningful exit codes.
   Keep credentials out of logs and snapshots. Do not leave reusable logic in temporary scripts.
4. Add offline tests in `scripts/tests/`; use real raw fixtures where practical. Add a handler test
   when the change affects SubQuery filtering, origins or entity persistence.
5. Update this catalog and the relevant runbook with inputs, outputs, limitations and a verified command.
   Makefile should not gain a new incident-specific target; use `podman-run` or the shared test suite.
