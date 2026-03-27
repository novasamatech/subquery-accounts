# AGENTS.md -- AI Agent Reference for subquery-accounts

## Project Purpose

A SubQuery indexer for the Polkadot/Substrate ecosystem. Indexes data about **multisig accounts**, **proxy/pure-proxy relationships**, and the **multisig operation lifecycle** across 20 networks. Data is stored in PostgreSQL and exposed via a GraphQL API. Primary consumer: Nova Spektr.

Framework: [SubQuery](https://subquery.network) (`@subql/node`, `@subql/query`).

---

## Project Structure

```
project-*.yaml              # Network configs (20 files) -- entry point per chain
subquery-multichain.yaml    # Lists all project-*.yaml for multichain deployment
schema.graphql              # GraphQL schema (6 entities, 2 enums)
src/
  index.ts                  # Export entry point (re-exports from mappings)
  mappings/
    index.ts                # Barrel export
    types.ts                # TypeScript interfaces for multisig call arguments
    handlers/
      index.ts              # Barrel export for all handlers
      generic.ts            # MAIN ENTRY POINT -- handleNestedCalls()
      multisigCallHandler.ts    # Parses signatories, creates Account/AccountMultisig
      multisigEventHandler.ts   # MultisigOperation lifecycle (4 handlers)
      multisigRemarkHandler.ts  # Multisig registration via system.remark
      proxyCallHandler.ts       # Handles proxy.removeProxies
      proxyEventHandler.ts      # ProxyAdded / ProxyRemoved
      pureProxyEventHandler.ts  # PureCreated / PureKilled
      assetHubMigrationHandler.ts # Migrates proxy data from relay chain to Asset Hub
  utils/
    operations.ts               # generateOperationId, getDataFromEvent/Call, timestamp
    multisigHelpers.ts          # findExistingOperation, createMultisigEvent, isThreshold1
    addressesDecode.ts          # createKeyMultiAddress, decodeAddress
    pureAccountCalculation.ts   # calculatePureAccount, findPureBlockNumber
    extractProxyEventData.ts    # Proxy event data parsing
    extractPureProxyEventData.ts # Pure proxy event data parsing
    checkAndGetAccount.ts       # Get-or-create for Account
    checkAndGetAccountMultisig.ts # Get-or-create for AccountMultisig
    validateAddress.ts          # Substrate/EVM address validation
    isJson.ts                   # Quick JSON check for remark data
    eventParser.ts              # blockNumber, extrinsicIndex from event
  types/                        # Auto-generated types (subql codegen) + enums
chainTypes/                     # Custom type definitions for specific networks
docker/                         # Dockerfile for PostgreSQL with extensions
docker-compose.yml              # Production multichain deployment
docker-compose-local.yml        # Local development (single network)
local-runner.sh                 # Script for quick local startup
scripts/
  debug-kusama-multisig-block.js # Inspect multisig event format and callHash sources on any Kusama block
```

---

## Key Entities (schema.graphql)

| Entity | Purpose | ID Format |
|---|---|---|
| `Account` | Any account (regular or multisig) | hex public key |
| `AccountMultisig` | Signatory <-> multisig link | `{signatoryId}-{multisigId}` |
| `MultisigOperation` | Multisig call lifecycle | `{callHash}-{accountId}-{blockCreated}-{indexCreated}` |
| `MultisigEvent` | Individual approval/rejection | `{operationId}-{signer}-{status}` |
| `PureProxy` | Pure (anonymous) proxy account | `{chainId}-{accountId}` |
| `Proxied` | Proxy relationship (who can act on behalf of whom) | `{chainId}-{proxied}-{proxy}-{type}-{delay}` |

### Enums
- `OperationStatus`: `pending` -> `executed` | `cancelled` | `error`
- `EventStatus`: `approve` | `reject`

---

## How Call Processing Works

### The `subquery-call-visitor` Library (v1.4.2)

Central to the project. Implements a **visitor pattern** for recursively walking nested Substrate calls (batch > proxy > multisig, etc.).

```
handleNestedCalls(extrinsic)           # generic.ts -- entry point
  -> callWalk.walk(extrinsic, visitor)  # Recursive call tree traversal
    -> on("multisig", "asMulti")        -> handleMultisigCall()
    -> on("multisig", "approveAsMulti") -> handleMultisigCall()
    -> on("multisig", "cancelAsMulti")  -> handleMultisigCall()
    -> on("utility", "asMulti*")        -> handleMultisigCall()   # utility-era Kusama
    -> on("system", "remarkWithEvent")  -> handleRemarkCall()
    -> on("proxy", "removeProxies")     -> handleRemoveProxiesCall()
```

The visitor automatically unwraps: `utility.batch*`, `proxy.proxy`, `proxy.proxyAnnounced`, `utility.asDerivative`.

Safety limit: batches with >10,000 calls/events are skipped (`context.stop()`).

### MultisigOperation Lifecycle

```
NewMultisig         -> creates MultisigOperation (status: pending)
MultisigApproved    -> finds existing operation, adds MultisigEvent
MultisigExecuted    -> finalizes (status: executed | error)
MultisigCancelled   -> cancels (status: cancelled)
```

Operation lookup (`findExistingOperation` in `multisigHelpers.ts`):
1. Exact match: `callHash + blockCreated + indexCreated + accountId`
2. Fallback: `callHash + accountId + status=pending`
3. If not found -- throws Error (crashes indexer on that block)

---

## Networks and Their Specifics

### Standard Configuration
Every network subscribes to the same set of call/event handlers for the `multisig`, `proxy`, `utility`, and `system` modules.

### Special Cases

| Network | Details |
|---|---|
| **Kusama** | Multisig lived in the `utility` module before spec 2007 (block 2,704,203). Requires additional `utility.*` event/call handlers + lowered startBlock. See Kusama deep-dive below. |
| **Polkadot, Kusama, Westend** | Handle `rcMigrator.AssetHubMigrationStarted` for migrating proxy data to Asset Hub |
| **Moonbeam, Moonriver** | EVM-compatible chains. 20-byte addresses (Ethereum format). `createKeyMultiAddress` handles both formats |
| **Asset Hub chains** | Use custom chainTypes with `NovaAssetId` evolving across spec versions |
| **Bittensor** | Custom types (`Balance` as u64), startBlock=1 |
| **Avail** | Extensive DA-specific types, custom `CheckAppId` signed extension |

### Chain ID (Genesis Hash) Mapping for Migrations

```
Polkadot  (0x91b1...) -> Polkadot Asset Hub  (0x68d5...)
Kusama    (0xb0a8...) -> Kusama Asset Hub    (0x4823...)
Westend   (0xe143...) -> Westend Asset Hub   (0x67f9...)
```

---

## Asset Hub Spec Version Maps (RPC-Verified)

Complete spec version -> first block mappings for all three Asset Hub chains are maintained in
`scripts/asset-hub-spec-blocks.json` (the single source of truth, used by all scan scripts).

- **To update**: run `node scripts/scan-spec-starts.js` — it auto-discovers all spec transitions
  and updates the JSON file. Can scan one chain (`node scripts/scan-spec-starts.js polkadot`)
  or all three at once (no arguments).
- Important: these values are **node-dependent** if the RPC is not full archive.
- Security: never commit tokenized RPC URLs in repo files.

Current counts (as of 2026-03-05):
- **statemint** (Polkadot Asset Hub): 35 spec versions (spec 2 .. 2000007)
- **statemine** (Kusama Asset Hub): 46 spec versions (spec 2 .. 2000007)
- **westmint** (Westend Asset Hub): 77 spec versions (spec 2 .. 1022000)

---

## Debugging & Scan Scripts

All scripts live in `scripts/`. Most scripts read endpoints from `scripts/asset-hub-spec-blocks.json` — no need to pass RPC endpoints manually. Never hardcode or commit tokenized RPC URLs.

### `scripts/scan-spec-starts.js` — Auto-discover spec transitions & update JSON

Automatically discovers ALL spec version transitions for Asset Hub chains using binary search (no hardcoded spec list needed). Updates `scripts/asset-hub-spec-blocks.json` with the results. Run this when new runtime upgrades occur.

```bash
node scripts/scan-spec-starts.js              # scan all 3 chains
node scripts/scan-spec-starts.js polkadot     # scan one chain (aliases: kusama, westend, statemint, etc.)
node scripts/scan-spec-starts.js --dry-run    # print results without writing JSON
```

Takes ~6-15 minutes per chain depending on the number of spec versions.

### `scripts/scan-asset-hub-decode.js` — Asset Hub decode regression scan

Verifies that current chaintypes decode ALL spec eras correctly for a given Asset Hub chain, including blocks with non-None `ChargeAssetTxPayment` assetId (e.g. USDT fee payment). Compares current config against multiple alternative `NovaAssetId` type configs to help diagnose type boundary issues. Uses spec→block mappings from `asset-hub-spec-blocks.json`.

```bash
node scripts/scan-asset-hub-decode.js polkadot
node scripts/scan-asset-hub-decode.js kusama
node scripts/scan-asset-hub-decode.js westend

# Test specific blocks:
node scripts/scan-asset-hub-decode.js polkadot --extra=4176632,6172745
```

### `scripts/scan-methods-by-spec.js` — Targeted extrinsic scan

Verifies decode + method parsing for specific call types (e.g. `multisig.asMulti`, `proxy.proxy`) across all spec eras. Uses spec→block mappings from `asset-hub-spec-blocks.json`.

```bash
node scripts/scan-methods-by-spec.js polkadot
node scripts/scan-methods-by-spec.js kusama --targets=multisig.asMulti,proxy.proxy
```

### `scripts/debug-kusama-multisig-block.js` — Kusama multisig event debugger

Prints spec version, event field layout, call hash extraction from both events and extrinsic fallback for multisig events in a specific block. Used for diagnosing call hash extraction issues on old runtimes.

```bash
node scripts/debug-kusama-multisig-block.js --block=2016479
node scripts/debug-kusama-multisig-block.js --block=2704203 --endpoint=wss://kusama-rpc.dwellir.com
```

### `scripts/run-podman-block-test.sh` — Local end-to-end indexer run from a target block

Runs a full SubQuery node + PostgreSQL in rootless Podman, patches `startBlock` in a temporary project spec,
and starts indexing from that exact block. This is the primary script for reproducing block-specific runtime issues
(`handleNestedCalls`, decode regressions, RPC instability, etc.) in an isolated environment.

Default behavior:
- Uses PostgreSQL 16 (`docker.io/library/postgres:16-alpine`).
- Uses `subql-node` image `docker.io/subquerynetwork/subql-node-substrate:v6.4.6` (override via `NODE_IMAGE`).
- Creates a temporary spec `__tmp-subql-block-test-...yaml`, patches `startBlock`, runs node, and cleans up containers/network/temp files.
- For local mode, mounts current workspace as `/app` and runs `-f=/app/<temp-spec>`.

Key debugging modes:
- **Local workspace mode** (default): fastest iteration, uses your current local `dist/` and `node_modules`.
- **Image parity mode** (`USE_IMAGE_PROJECT=1`): uses project bundled inside `NODE_IMAGE` (no workspace bind mount), good for CI/prod parity checks.
- **Image spec parity mode** (`USE_IMAGE_PROJECT=1 USE_IMAGE_SPEC=1`): reads source spec from inside image before patching `startBlock`; use this when local `project-*.yaml` differs from image.
- **RPC A/B mode** (`RPC_ENDPOINT_OVERRIDE=...`): rewrites `network.endpoint` in temp spec to compare behavior on different RPC endpoints without editing repo files.

Examples:

```bash
# 1) Basic local repro (workspace code)
scripts/run-podman-block-test.sh project-kusama.yaml 4401372 --workers=1

# 2) Repro using exact CI/production image project contents
USE_IMAGE_PROJECT=1 \
IMAGE_PROJECT_ROOT=/project \
NODE_IMAGE='ghcr.io/novasamatech/subquery-accounts:many-fixes-node-js-22-subql-node-v6.4.6@sha256:...' \
scripts/run-podman-block-test.sh project-kusama.yaml 4401372 --workers=1

# 3) Same as (2), but spec is also loaded from image (max parity)
USE_IMAGE_PROJECT=1 \
USE_IMAGE_SPEC=1 \
IMAGE_PROJECT_ROOT=/project \
NODE_IMAGE='ghcr.io/novasamatech/subquery-accounts:many-fixes-node-js-22-subql-node-v6.4.6@sha256:...' \
scripts/run-podman-block-test.sh project-kusama.yaml 4401372 --workers=1

# 4) Endpoint A/B test without editing YAML
USE_IMAGE_PROJECT=1 \
USE_IMAGE_SPEC=1 \
IMAGE_PROJECT_ROOT=/project \
NODE_IMAGE='ghcr.io/novasamatech/subquery-accounts:many-fixes-node-js-22-subql-node-v6.4.6@sha256:...' \
RPC_ENDPOINT_OVERRIDE='wss://kusama-rpc.polkadot.io' \
scripts/run-podman-block-test.sh project-kusama.yaml 4401372 --workers=1
```

Practical notes:
- If you compare two environments, keep `NODE_IMAGE` and `startBlock` identical; change only one variable at a time (usually endpoint).
- `--workers=1` is recommended for deterministic troubleshooting logs.
- Avoid committing tokenized RPC endpoints to repo files; prefer `RPC_ENDPOINT_OVERRIDE` for temporary tests.
- The script handles `SIGTERM`/`SIGINT` and tries to stop child containers cleanly before exit.

### `scripts/scan-signed-extensions.js` — Signed extension type scanner

Scans `ChargeAssetTxPayment` fields across all spec versions by querying on-chain metadata.
Use this to verify that chaintypes overrides (`NovaAssetId`) match the actual runtime types.
Uses spec→block mappings from `asset-hub-spec-blocks.json`.

```bash
node scripts/scan-signed-extensions.js polkadot   # or statemint, pol
node scripts/scan-signed-extensions.js kusama      # or statemine, kus
node scripts/scan-signed-extensions.js westend     # or westmint, wes
```

### `scripts/asset-hub-spec-blocks.json` — Spec version → first block mappings

Shared JSON data file used by all scan scripts above. Contains RPC-verified spec→block mappings
for all three Asset Hub chains (statemint, statemine, westmint) plus default RPC endpoints.
**Updated automatically** by `scan-spec-starts.js` — run it when new runtime upgrades occur.

---

## Kusama Multisig Pallet Migration Deep-Dive

This is the most complex troubleshooting area in the project. All findings below are **verified on-chain**.

### Timeline

| Spec | Block Range | Module | Event Format |
|---|---|---|---|
| 1032-1054 | 461,692 - 1,574,407 | `utility` | `NewMultisig(AccountId, AccountId)` -- **2 fields, no callHash** |
| 1055 | 1,574,408 - 2,064,960 | `utility` | `NewMultisig(AccountId, AccountId)` -- **2 fields, no callHash** |
| 1058 | 2,064,961 - 2,201,990 | `utility` | `NewMultisig(AccountId, AccountId)` -- **2 fields, no callHash** |
| 1062 | 2,201,991 - 2,704,202 | `utility` | `NewMultisig(AccountId, AccountId, CallHash)` -- **3 fields, with callHash** |
| 2005 | varies | `utility` (batch etc.) / `multisig` (multisig ops) | transition runtime |
| 2007+ | 2,704,203+ | `multisig` | `NewMultisig(AccountId, AccountId, CallHash)` -- **3 fields, with callHash** |

### Full event field comparison across eras

**New format (spec >= 1062, including post-migration multisig module):**
| Event | Fields |
|---|---|
| `NewMultisig` | `[0] approving: AccountId, [1] multisig: AccountId, [2] callHash: CallHash` |
| `MultisigApproval` | `[0] approving: AccountId, [1] timepoint: Timepoint, [2] multisig: AccountId, [3] callHash: CallHash` |
| `MultisigExecuted` | `[0] approving: AccountId, [1] timepoint: Timepoint, [2] multisig: AccountId, [3] callHash: CallHash, [4] result: DispatchResult` |
| `MultisigCancelled` | `[0] cancelling: AccountId, [1] timepoint: Timepoint, [2] multisig: AccountId, [3] callHash: CallHash` |

**Old format (spec < 1062) -- callHash field is MISSING:**
| Event | Fields |
|---|---|
| `NewMultisig` | `[0] approving: AccountId, [1] multisig: AccountId` |
| `MultisigApproval` | `[0] approving: AccountId, [1] timepoint: Timepoint, [2] multisig: AccountId` |
| `MultisigExecuted` | `[0] approving: AccountId, [1] timepoint: Timepoint, [2] multisig: AccountId, [3] result: DispatchResult` |
| `MultisigCancelled` | `[0] cancelling: AccountId, [1] timepoint: Timepoint, [2] multisig: AccountId` |

**Key observations:**
- Fields `approving`/`cancelling`, `timepoint`, `multisig` are at the **same indices** in both formats
- `callHash` is simply absent in the old format (not shifted -- just missing at the end, except `MultisigExecuted` where `result` occupies index 3 instead of 4)
- For old-format events, `callHash` must be computed from the extrinsic call arguments (`call.hash`) 
- The `getCallHashString()` helper in `multisigHelpers.ts` must handle both formats
- On old `MultisigExecuted`, event index 3 is `DispatchResult`; naive extraction may produce `0x00`, which is **not** a valid call hash
- `getCallHashString()` must validate call hash format (`0x` + 64 hex chars) before accepting event-derived values
- The `getExecutionResult()` helper must check index 4 first, then fall back to index 3

### What was verified on-chain

- At migration block 2,704,203 there were **30 pending multisig operations** created in the utility era
- These operations are stored in `multisig.Multisigs` on-chain storage (migrated automatically by the runtime)
- They get resolved later via `multisig.MultisigCancelled`/`MultisigExecuted` events with timepoints pointing back to pre-migration blocks
- `MetadataApi not available` warning on old blocks is **not fatal** -- `@polkadot/api` falls back to `rpc::state::get_metadata` and works correctly
- `chainTypes/` overrides do NOT help with event structure differences -- those are defined by runtime metadata, not type overrides

### Call names across eras

In both `utility` (old) and `multisig` (new) modules, call names are identical:
- `asMulti` / `as_multi`
- `approveAsMulti` / `approve_as_multi`
- `cancelAsMulti` / `cancel_as_multi`
- `asMultiThreshold1` / `as_multi_threshold1`

When adding `utility.*` call handlers in `project-kusama.yaml`, the same `handleNestedCalls` function works for both modules.  
Do not forget `utility.asMultiThreshold1` (both handler filter and visitor paths), otherwise threshold-1 execution paths may be misclassified.

### Debugging script

See `scripts/debug-kusama-multisig-block.js` (described in [Debugging & Scan Scripts](#debugging--scan-scripts) above).

Verified examples:
- Block `2016479` (`utility.NewMultisig`, spec `1055`): event has 2 fields, no callHash; fallback from `utility.asMulti` call arg returns `0x5f1a...3087`
- Block `2016525` (`utility.MultisigExecuted`, spec `1055`): index 3 is `DispatchResult` (can serialize as `0x00`); valid callHash still comes from extrinsic fallback

---

## Common Problems and Troubleshooting

### 1. "Operation not found" on MultisigCancelled/Executed/Approved

**Symptom:** `Error: Operation not found for call hash: 0x... on block: N index: M`

**Cause:** The event references an operation that was never indexed. This happens when:
- `startBlock` in the project YAML is set later than the block where the operation was created (`NewMultisig`)
- The module that emitted the events is not covered by handlers (e.g., `utility` instead of `multisig` in older runtimes)

**Debugging entry points:**
- `src/utils/multisigHelpers.ts` -> `findExistingOperation()` (~line 120)
- `src/mappings/handlers/multisigEventHandler.ts` -> the handler named in the stack trace

**Diagnosis:**
1. Extract `blockCreated` and `indexCreated` from the error (these come from the timepoint)
2. Check: is `blockCreated < startBlock`? If yes, the operation was created before indexing began
3. Query events at `blockCreated` via RPC -- which module emitted `NewMultisig`?
4. Check chain metadata at `blockCreated` -- what spec version is it? Does a `multisig` pallet exist?

**Fix:** Add event+call handlers for the correct module (e.g., `utility.NewMultisig`) in the project YAML and lower `startBlock` to cover the creation block. The same handler functions work for both `utility` and `multisig` modules since event data formats are identical (for spec >= 1062).

**Important:** In the Substrate ecosystem, pallets are periodically renamed or extracted into separate modules. When adding a new network, always verify which module hosted multisig functions at `startBlock`.

### 2. "Call hash not found" or "call hash: 0x00" on Old Runtime Blocks

**Symptoms:**
- `Error: Call hash not found`
- `Error: Operation not found for call hash: 0x00 ...`

**Cause:** Before spec 1062, multisig events did NOT include a `callHash` field.  
Additionally, on old `MultisigExecuted`, field index 3 is `DispatchResult`, not `callHash`; naive index-based extraction may produce `0x00`.

**Debugging entry points:**
- `src/utils/multisigHelpers.ts` -> `getCallHashString()`, `getExecutionResult()`
- `src/mappings/handlers/multisigEventHandler.ts` -> all 4 event handlers

**Diagnosis:**
1. Check the spec version at the failing block via RPC (`api.rpc.state.getRuntimeVersion(hash)`)
2. Check `event.data.length` -- if it's fewer fields than expected, the event uses the old format
3. If error contains `call hash: 0x00`, verify whether this came from `DispatchResult` serialization
4. Compare against the field tables in the Kusama deep-dive section

**Fix:** Make `getCallHashString()` resilient to missing and invalid event values:
- Accept only valid 32-byte hashes (`0x` + 64 hex chars)
- If event-derived value is missing/invalid (`0x00` etc.), fallback to extrinsic args:
  - named args: `callHash` / `call_hash`
  - inner call hash: `call.hash` (including `utility.asMulti`)
- Keep `getExecutionResult()` fallback logic: index 4 first, then index 3 for old runtimes

**Note:** `chainTypes/` overrides will NOT fix this. Event structure is defined by runtime metadata, not type bundles. The fix must be in handler code.

### 3. "MultisigCanceled" vs "MultisigCancelled" (Typo in Event Name)

**Symptom:** Indexer doesn't catch multisig cancellation events on certain networks.

**Cause:** Some runtimes named the event `MultisigCanceled` (one 'l'), while others use `MultisigCancelled` (two 'l's). See commit `d1ff8b4`.

**Entry point:** project-*.yaml files, `filter.method` section for multisig events.

**Fix:** Add handlers for both spellings, or check the specific chain's metadata.

### 4. Incorrect Pure Proxy Address (Doesn't Match On-Chain)

**Symptom:** Computed pure proxy address doesn't match the actual on-chain address.

**Cause:** For parachains, the entropy block number is the **relay chain block number** (relay parent), not the parachain block number.

**Entry points:**
- `src/utils/pureAccountCalculation.ts` -> `findPureBlockNumber()`, `calculatePureAccount()`
- `src/mappings/handlers/pureProxyEventHandler.ts` -> `handlePureProxyEvent()`

**Diagnosis:**
1. Query `parachainSystem.validationData` at the event's block
2. Compare `relayParentNumber` with the `entropyBlockNumber` used in calculation

### 5. Duplicate or Missing Proxy Records After Asset Hub Migration

**Symptom:** After relay chain -> Asset Hub migration, proxy records are duplicated or lost.

**Entry points:**
- `src/mappings/handlers/assetHubMigrationHandler.ts`
- Genesis hash -> target hash mapping in `CHAIN_ID_MAPPING`

**Diagnosis:**
1. Verify the target chainId in `CHAIN_ID_MAPPING` is correct
2. Check whether original deletion completed (`DELETE_ORIGINALS = true`)
3. Migration runs in batches of 100 -- edge cases possible with large record counts

### 6. Missing callData/method/section in MultisigOperation

**Symptom:** MultisigOperation is created but `callData`, `method`, `section` are null.

**Cause:** Not all multisig calls contain call data. `approveAsMulti` only passes the `call_hash`, without full call data. Call data is only available in `asMulti` (at final approval or when explicitly provided).

**Entry points:**
- `src/mappings/handlers/multisigEventHandler.ts` -> `populateOperationWithCallData()`
- Internal visitor looks for `asMulti`/`asMultiThreshold1` with a `call` field

**This is expected behavior**, not a bug. Call data is populated on the first `asMulti` that contains it.

### 7. Large Batches Crash or Stall the Indexer

**Symptom:** Indexer hangs or crashes on a block with a massive batch call.

**Entry point:**
- `src/mappings/handlers/generic.ts` -> check for `calls.length > 10_000`

**Fix:** The visitor includes a safety check for >10,000 calls/events -- `context.stop()`. If the problem persists, inspect the specific block and add similar limits.

### 8. Address Issues on EVM Chains (Moonbeam/Moonriver)

**Symptom:** Incorrect multisig addresses or errors when creating AccountMultisig records.

**Entry point:**
- `src/utils/addressesDecode.ts` -> `createKeyMultiAddress()`, `decodeAddress()`

**Cause:** EVM chains use 20-byte addresses (Ethereum format) instead of 32-byte Substrate addresses. `createKeyMultiAddress` handles both formats, but any changes must account for both code paths.

### 9. Type Errors After Updating @polkadot/* Dependencies

**Symptom:** Build fails after updating `@polkadot/api` or `@polkadot/types`.

**Entry point:** `package.json` -> `resolutions` and `dependencies` sections.

**Cause:** The project uses `resolutions` to pin specific `@polkadot/*` versions (16.5.4). When updating, ALL packages must be updated in sync.

**Diagnosis:** Warnings like `@polkadot/util has multiple versions` indicate version mismatches.

---

### 10. "TextEncoder is not defined" at Runtime

**Symptom:** Indexer crashes with `ReferenceError: TextEncoder is not defined` when processing blocks. The stack trace points to `@noble/hashes/esm/utils.js` → `@noble/curves/esm/abstract/hash-to-curve.js` → `addressesDecode.ts`.

**Entry point:** `src/index.ts` (polyfill), `@noble/hashes` (root cause).

**Cause:** `@noble/hashes` >= 1.8.0 (pulled in by `@polkadot/util-crypto` → `@noble/curves`) calls `new TextEncoder()` at **module initialization** time (`export const _DST_scalar = utf8ToBytes('HashToScalar-')` in `hash-to-curve.js`). The SubQuery sandbox environment does not provide `TextEncoder`/`TextDecoder` as globals.

**Fix:** Add a polyfill at the very top of `src/index.ts`, before any imports that transitively depend on `@noble/hashes`:

```typescript
if (typeof globalThis.TextEncoder === "undefined") {
  const util = require("util");
  globalThis.TextEncoder = util.TextEncoder;
  globalThis.TextDecoder = util.TextDecoder;
}
```

Webpack places this code before the `@noble/hashes` module in the bundle, so the polyfill runs first. Verified by checking `dist/index.js` — the polyfill appears at an earlier line than the first `TextEncoder` usage.

**Note:** SubQuery previously supported separate polyfill files but removed that feature. The warning "Support for pollyfill files has been removed" confirms the code must live directly in `src/index.ts`.

---

### 11. "Invalid decoded address checksum" After @polkadot/* v16 Upgrade

**Symptom:** Indexer crashes with `Error: Decoding <address>: Invalid decoded address checksum`. Can happen in two places:

1. **`decodeAddress`** — when decoding SS58 addresses from event data (e.g. `extractPureProxyEventData`, `extractProxyEventData`).
2. **`createKeyMultiAddress` → `encodeMultiAddress`** — when computing multisig account addresses from signatories obtained via `call.toHuman()`.

**Entry point:** `src/utils/addressesDecode.ts`.

**Cause:** `@polkadot/util-crypto` v16 is stricter about SS58 checksum validation. On-chain data returned by `.toHuman()` encodes addresses with the chain's SS58 prefix, but the internal `decodeAddress` in `@polkadot/util-crypto` may reject them if the checksum doesn't match the expected generic format.

**Fix (applied):**

1. `decodeAddress()` — pass `ignoreChecksum: true` to `substrateDecode`:
   ```typescript
   return substrateDecode(address, true);
   ```

2. `createKeyMultiAddress()` — pre-decode all addresses through our `decodeAddress` (which ignores checksum) before passing to `encodeMultiAddress`, so the internal `decodeAddress` in `@polkadot/util-crypto` is never called on SS58 strings:
   ```typescript
   const decoded = who.map(addr => typeof addr === "string" ? decodeAddress(addr) : addr);
   const multisigKey = encodeMultiAddress(decoded, threshold);
   ```

**Why it's safe:** Addresses come from on-chain data and are guaranteed to be valid. The checksum mismatch is purely a format issue (different SS58 prefixes), not a data integrity problem.

---

### 12. "Uint8Array expected" on Moonbeam/Moonriver (EVM Address Paths)

**Symptoms:**
- `Failed to index block ... handleProxyEvent(Error: Uint8Array expected ...)`
- Stack path (Moonbeam): `extractProxyEventData` -> `decodeAddress` -> `isEthereumAddress`/`isChecksum` -> `@noble/hashes`
- `Failed to index block ... handleNestedCalls(Error: Uint8Array expected ...)`
- Stack path (Moonriver): `multisigCallHandler` -> `createKeyMultiAddress` -> `encodeAddress` -> `ethereum/encode.js` -> `@noble/hashes`

**Why the previous fix was not enough:**
- The first fix only stabilized `decodeAddress()` (Proxy event path).
- Moonriver crash came from another branch: `createKeyMultiAddress()` -> `encodeAddress()` that still used EVM encoding via keccak path.

**Root cause (deep):**

The error is a regression in `@noble/hashes` (transitive dependency of `@polkadot/util-crypto`), **not** in `@polkadot/*` or in our code.

1. `@polkadot/util-crypto` (all versions 12.x–14.x) depends on `@noble/hashes: "^1.3.3"` (semver range).
2. `@noble/hashes` 1.3.3 had a **lenient** `isBytes` check that tolerated cross-realm `Uint8Array`:
   ```js
   // @noble/hashes 1.3.3
   function isBytes(a) {
       return (a instanceof Uint8Array ||
           (a != null && typeof a === 'object' && a.constructor.name === 'Uint8Array'));
   }
   ```
3. Starting from `@noble/hashes` 1.7.0, the check became **strict** — uses `ArrayBuffer.isView(a)` which is also realm-dependent:
   ```js
   // @noble/hashes 1.7+
   function isBytes(a) {
       return a instanceof Uint8Array ||
           (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array');
   }
   ```
4. When yarn resolves `^1.3.3`, it picks the latest matching version (1.7.1 or 1.8.0). In a normal Node.js environment this works fine, but in **SubQuery's webpack bundle** the `Uint8Array` produced by `@polkadot/util`'s `u8aToU8a()` (via `TextEncoder.encode()`) comes from a different webpack module scope ("realm") than the `Uint8Array` that `@noble/hashes` checks against with `instanceof`. Both `instanceof Uint8Array` and `ArrayBuffer.isView()` return `false` for cross-realm instances.
5. The WASM path (`@polkadot/wasm-crypto`) would bypass `@noble/hashes` entirely, but in SubQuery's webpack runtime `isReady()` returns `false` (WASM not initialized), so the JS fallback through `@noble/hashes` is always used.

**Call chain (full):**
```
generateMultisigAddress(origin)                    // subquery-call-visitor or our code
  → isEthereumAddress(origin)                      // @polkadot/util-crypto
    → isEthereumChecksum(address)                  // only for mixed-case EVM addresses
      → keccakAsU8a(address.toLowerCase())         // keccak/asU8a.js
        → createDualHasher(wa, js)                 // helpers.js
          → u8aToU8a(value)                        // string → TextEncoder.encode() → Uint8Array ✓
          → isReady() ? wa[256](u8a)               // WASM path — would work, but WASM not loaded
                      : js[256](u8a)               // JS fallback → @noble/hashes keccak_256
            → abytes(u8a)                          // @noble/hashes/esm/utils.js
              → isBytes(u8a) → FALSE               // cross-realm Uint8Array fails strict check
              → throw "Uint8Array expected"         // 💥
```
The same crash also happens in `ethereumEncode()` which uses `keccakAsU8a` for checksum encoding.

**Why version pinning (`resolutions`) cannot fix this:**
- The project has 5 installations of `@noble/hashes` (versions 1.7.0, 1.7.1, 1.8.0).
- `@noble/curves@1.9.7` (used by `@polkadot/util-crypto` 14.x for secp256k1/ed25519) has a **hard** dependency on `@noble/hashes: 1.8.0` (exact version, not a range).
- Forcing all `@noble/hashes` to 1.3.3 via global `resolutions` would break `@noble/curves`.
- Selective per-dependency resolution is not supported by yarn for transitive deps of the same package name.

**Fix (current, applied in `src/utils/addressesDecode.ts`):**
1. Use strict EVM detection: `^0x[0-9a-fA-F]{40}$`.
2. `decodeAddress()`:
   - EVM string -> `addressToEvm(address, false)`
   - otherwise -> `substrateDecode(address, true)`
3. `encodeAddress()`:
   - EVM string -> normalized lowercase `0x...`
   - 20-byte `Uint8Array` -> `u8aToHex(publicKey)`
   - otherwise -> `substrateEncode(...)`
4. `createKeyMultiAddress()`:
   - pre-decode signatories to `Uint8Array`
   - for EVM output use `addressToEvm(multisigKey, false)` + `encodeAddress(...)`
   - do not call `ethereumEncode` directly

**RPC verification (real network):**
- Moonbeam: block `14556295` (`proxy.ProxyAdded`) reproduces decode path and passes with fix.
- Moonriver: block `15279799` (`multisig.asMulti`) reproduces multisig encode path and passes with fix.

**Dependency note:**
- Expected tree is split by design:
  - runtime path: `@polkadot/util*` `14.0.1`
  - nested under `@subql/utils`: `13.5.9`
- Do not force one global major via `resolutions` if it breaks `@subql/utils` peers.

**Fix for `subquery-call-visitor` (applied via branch dependency):**
- `package.json` points to the `fix/evm-address` branch: `https://github.com/novasamatech/subquery-call-visitor/archive/refs/heads/fix/evm-address.tar.gz`
- The branch replaces `generateMultisigAddress` in `dist/impls/nodes/multisig/common.js`.
- Avoids `isEthereumAddress` (keccak path) → uses regex `^0x[0-9a-fA-F]{40}$` instead.
- Avoids `ethereumEncode` (keccak path) → uses `u8aToHex(multisigKey.slice(0, 20))` instead.
- Pre-decodes all addresses to `Uint8Array` via `safeDecodeAddress` (same pattern as `src/utils/addressesDecode.ts`).

**Alternative root-level fix (not yet applied):**
- Instead of patching each library that calls keccak, patch `@polkadot/util-crypto/helpers.js` — change one line in `createDualHasher` to re-wrap `Uint8Array` in the current realm before passing to `@noble/hashes` JS fallback:
  ```js
  // helpers.js, createDualHasher, JS fallback path:
  // before: js[bitLength](u8a)
  // after:
  js[bitLength](new Uint8Array(u8a.buffer, u8a.byteOffset, u8a.byteLength))
  ```
- This fixes ALL hash operations (keccak, blake2, etc.) for ALL libraries in one patch, including `subquery-call-visitor`, and would make both the `addressesDecode.ts` workarounds and the `subquery-call-visitor` patch unnecessary for this specific error.

**If error appears again:**
- Check whether crash is inside our `src/utils/addressesDecode.ts`, in patched `subquery-call-visitor`, or in another external path that still uses keccak-based EVM helpers.
- If `subquery-call-visitor` is upgraded, the patch may need to be re-created via `yarn patch subquery-call-visitor`.
- Consider switching to the root-level `@polkadot/util-crypto/helpers.js` patch (see above) if the error keeps appearing in new code paths.

---

### 13. "findMetaCall: Unable to find Call with index [X, Y]" on Asset Hub Blocks

**Symptoms:**
- `createType(ExtrinsicV4):: createType(Call):: findMetaCall: Unable to find Call with index [5, 229]/[5,229]`
- Indexer crashes in a loop on a specific block, unable to decode extrinsics.
- The call index in the error does NOT correspond to any real pallet (e.g., pallet index 5 doesn't exist in the metadata).

**Root cause:** Wrong `NovaAssetId` type override in Asset Hub chaintypes.

The `ChargeAssetTxPayment` signed extension includes an `asset_id` field whose type changed across runtime upgrades:
- **Early specs:** `Option<u32>` (pallet_asset_tx_payment)
- **Later specs:** `Option<MultiLocation>` / `Option<Location>` (pallet_asset_conversion_tx_payment)

If the chaintypes override defines the wrong type for a given spec range (e.g., `Option<AssetId>` = u32 when the runtime already expects `Option<MultiLocation>`), the signed extension bytes are decoded with the wrong size. This shifts the byte stream, causing the extrinsic call index to be read from wrong bytes — producing phantom pallet/call indices like `[5, 229]` instead of the real `[50, 8]`.

**Why it may not reproduce locally:** `@polkadot/api` v16+ uses metadata v14 types directly and may ignore chaintypes overrides for types already described in metadata. But SubQuery node may apply overrides with higher priority, causing the mismatch.

**Correct type boundaries (verified on-chain via `scripts/scan-signed-extensions.js`):**

| Network | `Option<u32>` range | `Option<MultiLocation*>` range |
|---------|--------------------|-----------------------------|
| Polkadot AH | `[0, 1001002]` | `[1002000, null]` |
| Kusama AH | `[0, 9435]` | `[1000000, null]` |
| Westend AH | `[0, 9425]` | `[9435, null]` |

Note: from the `Option<MultiLocation>` boundary onward, the type evolves (xcm v3 → v4 → v5) but remains structurally identical (`{parents: u8, interior: Junctions}`), so `Option<MultiLocationV3>` decodes all variants correctly.

**How to diagnose:**
1. Identify the spec version at the failing block (check the Spec Version Maps above).
2. Run `scripts/scan-signed-extensions.js` for that spec to see the actual `asset_id` type in metadata.
3. Compare with the `NovaAssetId` override in the relevant `chainTypes/*AssetHubChaintypes.ts`.
4. If they don't match, fix the `minmax` boundaries and rebuild.

**Prevention:** When modifying Asset Hub chaintypes, always verify boundaries with `scripts/scan-signed-extensions.js` before deploying. Never assume Polkadot/Kusama/Westend have the same transition points — each network upgraded independently.

---

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

### Preview wipe impact for Kusama (dynamic, no hardcoded chain ID)

```sql
BEGIN;

DO $$
DECLARE
  r record;
  v_chain_name text;
  v_chain_id text;
  v_meta_table text;
  v_rows bigint;
BEGIN
  -- Locate Kusama metadata table dynamically by key='chain'
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'app'
      AND table_name LIKE '\_metadata\_%' ESCAPE '\'
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'SELECT value #>> ''{}'' FROM app.%I WHERE key = ''chain'' LIMIT 1',
      r.table_name
    ) INTO v_chain_name;

    IF v_chain_name = 'Kusama' THEN
      v_meta_table := r.table_name;
      EXECUTE format(
        'SELECT value #>> ''{}'' FROM app.%I WHERE key = ''genesisHash'' LIMIT 1',
        r.table_name
      ) INTO v_chain_id;
      EXIT;
    END IF;
  END LOOP;

  IF v_meta_table IS NULL OR v_chain_id IS NULL THEN
    RAISE EXCEPTION 'Kusama metadata table not found';
  END IF;

  RAISE NOTICE 'Kusama metadata table: %, chain_id: %', v_meta_table, v_chain_id;

  EXECUTE format('SELECT count(*) FROM app.multisig_operations WHERE chain_id = %L', v_chain_id) INTO v_rows;
  RAISE NOTICE 'multisig_operations rows to delete: %', v_rows;

  EXECUTE format(
    'SELECT count(*) FROM app.multisig_events me
     JOIN app.multisig_operations mo ON mo.id = me.multisig_id
     WHERE mo.chain_id = %L',
    v_chain_id
  ) INTO v_rows;
  RAISE NOTICE 'multisig_events rows to delete: %', v_rows;

  EXECUTE format('SELECT count(*) FROM app.proxieds WHERE chain_id = %L', v_chain_id) INTO v_rows;
  RAISE NOTICE 'proxieds rows to delete: %', v_rows;

  EXECUTE format('SELECT count(*) FROM app.pure_proxies WHERE chain_id = %L', v_chain_id) INTO v_rows;
  RAISE NOTICE 'pure_proxies rows to delete: %', v_rows;

  EXECUTE format('SELECT count(*) FROM app.%I', v_meta_table) INTO v_rows;
  RAISE NOTICE 'metadata rows in table to drop (%): %', v_meta_table, v_rows;
END $$;

ROLLBACK;
```

### Wipe Kusama data (example)

```sql
BEGIN;

DO $$
DECLARE
  r record;
  v_chain_name text;
  v_chain_id text;
  v_meta_table text;
BEGIN
  -- Locate Kusama metadata table dynamically by key='chain'
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'app'
      AND table_name LIKE '\_metadata\_%' ESCAPE '\'
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'SELECT value #>> ''{}'' FROM app.%I WHERE key = ''chain'' LIMIT 1',
      r.table_name
    ) INTO v_chain_name;

    IF v_chain_name = 'Kusama' THEN
      v_meta_table := r.table_name;
      EXECUTE format(
        'SELECT value #>> ''{}'' FROM app.%I WHERE key = ''genesisHash'' LIMIT 1',
        r.table_name
      ) INTO v_chain_id;
      EXIT;
    END IF;
  END LOOP;

  IF v_meta_table IS NULL OR v_chain_id IS NULL THEN
    RAISE EXCEPTION 'Kusama metadata table not found';
  END IF;

  -- Delete chain-scoped data
  EXECUTE format(
    'DELETE FROM app.multisig_events me
     USING app.multisig_operations mo
     WHERE me.multisig_id = mo.id
       AND mo.chain_id = %L',
    v_chain_id
  );

  EXECUTE format('DELETE FROM app.multisig_operations WHERE chain_id = %L', v_chain_id);
  EXECUTE format('DELETE FROM app.proxieds WHERE chain_id = %L', v_chain_id);
  EXECUTE format('DELETE FROM app.pure_proxies WHERE chain_id = %L', v_chain_id);

  -- Drop metadata table for this network (full checkpoint reset)
  EXECUTE format('DROP TABLE app.%I', v_meta_table);
END $$;

COMMIT;
```

### Checkpoint note

If you wipe chain data without resetting metadata/checkpoint state, the indexer may resume from a later height and leave data gaps.  
Dropping the target network `_metadata_*` table is an explicit checkpoint reset for that network.

---

## Useful Commands

```bash
yarn codegen          # Generate types from schema.graphql
yarn build            # Build the project (subql build)
yarn test             # Build + run tests
yarn dev              # codegen + build + docker-compose up

# Inspect Kusama multisig parsing on a specific block
node scripts/debug-kusama-multisig-block.js --block=2016479

# Run a single network locally
PROJECT_PATH=./project-kusama.yaml docker-compose -f docker-compose-local.yml up

# Or via the helper script
./local-runner.sh ./project-kusama.yaml
```

---

## SubQuery Runtime Global Variables

Available in handlers without importing:
- `api` -- `ApiPromise` instance (restricted, no unsafeApi)
- `chainId` -- genesis hash of the current network (string)
- `logger` -- SubQuery logger
