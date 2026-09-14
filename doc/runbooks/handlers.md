# Handler and Data Failures

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

Use this runbook when fetching/decoding succeeds and a mapping fails or produces unexpected entities. For failures before handlers run, start with [block failure triage](block-failure.md).

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
4. Compare against the field tables in [Kusama history](kusama-multisig.md)

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
- `src/utils/addressesDecode.ts` -> `createKeyMultiAccountId()`, `decodeAddress()`

**Cause:** EVM chains use 20-byte addresses (Ethereum format) instead of 32-byte Substrate addresses. `createKeyMultiAccountId` handles both formats, but any changes must account for both code paths.

### 14. "Who X is not the pure account …" on Asset Hub Blocks (`createPure(when=Some(...))`)

**Symptoms:**
- Indexer loops on a specific AH block with `Error: Who 0x… is not the pure account 0x… or the pure account relay parent 0x…`.
- Throw originates at `src/utils/pureAccountCalculation.ts` (`findPureBlockNumber`).
- Affects mostly Polkadot/Kusama/Westend Asset Hub during/after the active relay→AH migration window.

**Root cause:** The substrate proxy pallet's `pure_account(who, proxy_type, index, maybe_when)` derivation accepts an optional `maybe_when = Some((historic_block, historic_ext_idx))`. AH users recreate their relay-chain pure proxies on AH by calling `proxy.createPure(..., when = Some((original_relay_block, original_ext_idx)))`, so the runtime hashes the *historic relay* `(height, ext_idx)` into the entropy, not the AH envelope. The runtime exposes those values in event data fields `at` (data[4]) and `extrinsic_index` (data[5]). Older `extractPureProxyEventData` ignored both fields and pulled `blockNumber` / `extrinsicIndex` from the AH envelope (`event.block.block.header.number`, `event.extrinsic.idx`) — for legacy `createPure` without `when` they coincide; for migration-era `createPure(when=Some(...))` they diverge, derivation fails, and `findPureBlockNumber` throws.

**Entry points:**
- `src/utils/extractPureProxyEventData.ts` — must prefer payload `at` / `extrinsic_index` over envelope.
- `src/utils/pureAccountCalculation.ts` → `findPureBlockNumber()` — assertion site.

**How to diagnose:**
1. Pull the offending block over RPC, find the `proxy.PureCreated` event, dump `event.toHuman()`. If `data.at` differs from the block's own number — this case.
2. Quick DB check (substitute target chain genesis as `chain_id`):
   ```sql
   SELECT count(*) FROM app.proxieds
   WHERE chain_id = '0x68d5…' AND is_pure_proxy = true AND block_number > 20000000;
   ```
   This was a historical heuristic when AH height was below 20M. Do not use it as a current verdict; compare the event payload with its envelope.

**Fix:** In `extractPureProxyEventData`, read `data.at(4)` / `data.at(5)` first and only fall back to `eventParser.blockNumber(event)` / `eventParser.extrinsicIndex(event)` when those fields are absent (older `AnonymousCreated` runtimes). Covered by test `src/test/polkadot-asset-hub/pureProxyEventHandler-when.test.ts` (block 15,503,985).

**Related but distinct:** §4 is the same family of "computed pure ≠ on-chain pure" symptoms; that section covers the parachain-relay-parent fallback. §14 is the migration-era `maybe_when` override which neither the parachain block nor the relay-parent block can reproduce.

## Derived Account Integrity

`src/utils/cryptoIntegrity.ts` checks a real 4-of-7 multisig vector before the first derived account is stored. `createKeyMultiAccountId` returns raw hex and builds the multisig prefix from hex bytes in the sandbox realm. Preserve the canary and the on-chain signer checks when changing address derivation. A `Crypto integrity check failed` error must be investigated in the actual SubQuery VM; do not disable the check to resume indexing.
