# Runtime and Dependency Compatibility

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

Use this for dependency, sandbox, address and historical Asset Hub type failures. These notes retain earlier incident evidence and alternative fixes; package versions and old helper names are historical, not instructions to downgrade or copy code blindly. Current implementations are authoritative: `addressesDecode.ts` uses `createKeyMultiAccountId`, `cryptoIntegrity.ts` guards derived ids, and the visitor version comes from `package.json`.

## Runtime Upgrade Checklist

1. Update `NODE_VERSION` / `SUBQL_NODE_VERSION` in [versions.env](../../versions.env), not individual
   workflows. Verify both runtime publishers: diagnostics/tests use `subquerynetwork`, the production
   Dockerfile uses `onfinality`. Keep project package resolutions and manifest minimums compatible.
2. Check the internal entry points below in the candidate image. They are not stable public APIs;
   if they move, update the loader/harness and verify behavior instead of skipping the VM tests.
3. Rebuild and run `make podman-test` with the candidate runtime, then build the production image.
   Its final stage runs the offline suite too, so an incompatible internal API intentionally fails
   the image build. Inspect the final image for accidentally included local caches/database files.
4. Compare old/candidate dependencies on the same raw snapshot and run the VM byte/hash, signed-origin,
   crypto-canary and entity assertions. Use historical and new-format transactions. Do not remove a
   chainTypes override based only on a newer package version or a successful bare-v5 decode.

### Internal Runtime APIs

[scripts/lib/runtime.js](../../scripts/lib/runtime.js) resolves packages from `SUBQL_ROOT` (default `/`)
and initializes logging before importing the sandbox. This root is independent of the project's
dependencies and a diagnostic's `--api-root` / `--known-types-root` candidate installations.

| Path relative to the runtime installation | Contract used by tooling |
|---|---|
| `@subql/node-core/dist/logger` | `initLogger` before VM imports |
| `@subql/node-core/dist/indexer/sandbox` | `IndexerSandbox`, `setGlobal`, `securedExec` for real mappings |
| `./dist/utils/project` | `loadChainTypesFromJs` for chainTypes VM loading |
| `./dist/utils/substrate` | `wrapExtrinsics`, `wrapEvents`, `filterExtrinsic`, `filterEvent` for dispatch |
| `@polkadot/types/metadata/decorate/events` | `decorateEvents` for runtime event predicates |
| `@polkadot/types/metadata/decorate/extrinsics` | `decorateExtrinsics` for fixture calls |

The last two are polkadot-js package entry points; the SubQuery `dist` paths are private implementation
details. The offline decoder and entity tests exercise these contracts in both the test and final
production runtime. A relocated entry point needs inspection, not a silent fallback to project packages.

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

## Address Checksums and Sandbox Bytes

**Symptoms:** checksum failures, `Uint8Array expected`, or silently incorrect derived
multisig account ids. These are distinct failure modes; a valid on-chain address does
not prove that the local byte/hash pipeline is correct.

**Current implementation:** `src/utils/addressesDecode.ts` returns hex ids from
`createKeyMultiAccountId`. It constructs the multisig prefix with `hexToU8a`, sorts
decoded signatories, appends the SCALE count and little-endian threshold, hashes, and
avoids an SS58 round-trip for the derived id. `src/utils/cryptoIntegrity.ts` checks a
real 4-of-7 multisig from Polkadot AH block `6706950` before derived ids are stored.
The expected id is `0x4e289015f60c88b9b1d1b58ba4110ed1e3e745b82101db274e1afba4b19eed63`.

The historical `createKeyMultiAddress -> encodeMultiAddress` workaround is superseded
by this implementation (main commit `75b5474`). Do not restore it from old incident
snippets, disable the integrity canary, or assume ignoring checksums fixes the cause.
`decodeAddress` still uses `substrateDecode(address, true)` for existing indexed
inputs; that is not a general validation policy for untrusted user input.

### EVM Paths

Historical failures were observed at:
- Moonbeam block `14556295`: `proxy.ProxyAdded`, via Ethereum checksum validation.
- Moonriver block `15279799`: `multisig.asMulti`, via multisig address encoding.

The current helpers detect 20-byte EVM hex addresses with a regex, normalize output
to lowercase hex, and avoid Ethereum checksum hashing in those paths. The visitor is
a pinned package in `package.json` (currently `1.4.4`), not the old
`fix/evm-address` branch dependency. Test both Substrate and EVM paths after upgrades.

### What the VM Boundary Changes

Host-created typed arrays can fail `instanceof Uint8Array` inside a sandbox. A VM
proxy can also fail byte-view checks. Merely being in a different webpack module is
not a different JavaScript realm, and `ArrayBuffer.isView` does recognize ordinary
cross-realm typed arrays. The old explanation conflated these cases.

The observed hashing failure can occur before the hash function: a byte utility
misclassifies a typed array and converts its comma-separated string representation
to bytes. Silencing a later `@noble/hashes` type check cannot recover those bytes.
Likewise, blindly downgrading or globally overriding transitive crypto dependencies
can break peer contracts. The earlier proposed `createDualHasher` re-wrap was not
validated as an end-to-end remedy and must not be treated as one.

For a recurrence, record the exact resolved packages, trace the first byte conversion
that diverges, and verify known-vector output through the actual SubQuery VM.
Use the existing handler tests and integrity canary. Keep runtime dependencies distinct
from project dependencies: changing the lockfile does not replace the image's decoder.

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

**Why it may not reproduce locally:** the build dependency tree and the image's decoder are separate installations. Record their resolved versions and compare the same raw bytes, metadata and type overrides; do not assume signed extensions are entirely metadata-derived in polkadot-js 16.5.x.

**Correct type boundaries (verified on-chain via `scripts/diagnostics/scan-signed-extensions.js`):**

| Network | `Option<u32>` range | `Option<MultiLocation*>` range |
|---------|--------------------|-----------------------------|
| Polkadot AH | `[0, 1001002]` | `[1002000, null]` |
| Kusama AH | `[0, 9435]` | `[1000000, null]` |
| Westend AH | `[0, 9425]` | `[9435, null]` |

The outer `{parents, interior}` shape alone does not establish SCALE compatibility across XCM versions: nested junction/network variants can differ. Existing `MultiLocationV3` overrides are historical compatibility settings, not proof that every foreign asset decodes correctly. Test non-None fee assets from the affected era and compare native `types-known` fixes before extending them. The v5 general decoder instead uses the exact metadata lookup types.

**How to diagnose:**
1. Identify the spec version at the failing block (see the [network reference](../architecture/networks.md)).
2. Run `scripts/diagnostics/scan-signed-extensions.js` for that spec to see the actual `asset_id` type in metadata.
3. Compare with the `NovaAssetId` override in the relevant `chainTypes/*AssetHubChaintypes.ts`.
4. If they don't match, fix the `minmax` boundaries and rebuild.

**Prevention:** When modifying Asset Hub chaintypes, always verify boundaries with `scripts/diagnostics/scan-signed-extensions.js` before deploying. Never assume Polkadot/Kusama/Westend have the same transition points — each network upgraded independently.

For v5 `GeneralExtrinsic` / `Mortal era` failures, use the [separate v5 runbook](asset-hub-v5.md). For any dependency upgrade, compare the same raw snapshot with both versions and verify in the runtime image, not only the build container.
