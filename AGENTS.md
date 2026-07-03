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
    addressesDecode.ts          # createKeyMultiAccountId, decodeAddress
    cryptoIntegrity.ts          # assertCryptoIntegrity -- known-vector canary for derived ids
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

## Running Debug Scripts under Podman (Linux)

**On a Linux host with `podman` available, every node-based debug/scan script in `scripts/` (and any ad-hoc `scripts/_tmp-*.js`) MUST run inside a rootless Podman container.** The project policy forbids invoking `node` / `yarn` / `npm` / `npx` / `ts-node` / `tsc` / `subql-node` on the host directly — there is no `node_modules/` on the host, the host should stay free of project artefacts, and the bundled runtime must match what the indexer uses. Bash invocations in this repo's CLAUDE memory enforce the same.

The shell snippets in the **Debugging & Scan Scripts** section below show the bare `node scripts/foo.js` form for clarity; on Linux always wrap them with the patterns below.

### Image selection

| Image | When to use |
|---|---|
| `docker.io/subquerynetwork/subql-node-substrate:v6.4.6` | Current indexer image (after `281658d`). Has `@polkadot/api` + `@polkadot/util-crypto` baked in. Use for any probe that only needs polkadot-js + bundled chain types. |
| `docker.io/subquerynetwork/subql-node-substrate:v5.6.0` | Older CI image. Useful for comparing decoder behaviour across subql-node versions. |
| `docker.io/library/node:24-alpine` + the project's `subql-workspace` volume | Use when you need the project's exact dependency tree (custom `chainTypes`, `subquery-call-visitor`, etc.). Orchestrated by `make podman-build` / `make podman-test`. |

### Probe a specific block with a `_tmp-*.js` script

Override `--entrypoint /bin/sh` (otherwise the image runs `subql-node` and your `node …` cmdline gets ignored), bind-mount the repo read-only at `/src`, use `--network=host` so the container can reach an external WS RPC, and pass the script via absolute path inside `/src`:

```bash
podman run --rm --entrypoint /bin/sh \
  -v "$PWD":/src:ro,Z \
  --network=host \
  docker.io/subquerynetwork/subql-node-substrate:v6.4.6 \
  -c 'cd / && node /src/scripts/_tmp-probe-block.js'
```

Same for the standing scripts in this section, e.g. the Kusama multisig debugger:

```bash
podman run --rm --entrypoint /bin/sh \
  -v "$PWD":/src:ro,Z \
  --network=host \
  docker.io/subquerynetwork/subql-node-substrate:v6.4.6 \
  -c 'cd / && node /src/scripts/debug-kusama-multisig-block.js --block=2016479 --endpoint=wss://kusama-rpc.polkadot.io'
```

### Private RPC URLs — use `--env-file`, never the cmdline

Do NOT put tokenised/private RPC URLs into `project-*.yaml`, into scripts as defaults, into permission allowlists (`.claude/settings.local.json`), or onto the cmdline (visible via `ps`). Use an ephemeral env-file mode `0600` outside the repo:

```bash
umask 077 && cat > /tmp/k-rpc.env <<'EOF'
KUSAMA_ENDPOINT=wss://<host>/<path>
EOF
chmod 600 /tmp/k-rpc.env

podman run --rm --entrypoint /bin/sh \
  --env-file /tmp/k-rpc.env \
  -v "$PWD":/src:ro,Z \
  --network=host \
  docker.io/subquerynetwork/subql-node-substrate:v6.4.6 \
  -c 'cd / && node /src/scripts/_tmp-probe-block.js'

shred -u /tmp/k-rpc.env   # delete after use
```

The probe script reads it via `process.env.KUSAMA_ENDPOINT` and must NOT print the URL (use `connecting to RPC (redacted)` instead of echoing `endpoint`).

### Determining bundled versions inside an image

Bypass the default subql-node entrypoint with `--entrypoint /bin/sh`, then introspect from inside:

```bash
# Resolved path of @polkadot/api inside the image
podman run --rm --entrypoint /bin/sh \
  docker.io/subquerynetwork/subql-node-substrate:v6.4.6 \
  -c 'node -e "console.log(require.resolve(\"@polkadot/api\"))"'
# → /node_modules/@polkadot/api/cjs/index.js

# Node version
podman run --rm --entrypoint /bin/sh \
  docker.io/subquerynetwork/subql-node-substrate:v6.4.6 \
  -c 'node --version'
# v6.4.6 → v18.20.5 (as of 2026-05)

# Raw bundled package.json (note: version field is STRIPPED in the image)
podman run --rm --entrypoint /bin/sh \
  docker.io/subquerynetwork/subql-node-substrate:v6.4.6 \
  -c 'cat /node_modules/@polkadot/api/package.json'
```

**Gotcha:** subql-node images ship a minimised `package.json` for `@polkadot/api` that has NO `"version"` field. `require("@polkadot/api/package.json").version` returns `undefined`. For the version the project pins, look at the repo's `package.json` → `resolutions` (currently `@polkadot/api: 16.5.4`, `@polkadot/util: 14.0.1`).

### Pitfalls observed in practice

- **Never pipe `node …` through `tail -N` when running async / in background.** `tail` buffers stdin in chunks and only flushes on EOF, so you'll see nothing until the script exits. Use no pipe (or `stdbuf -oL`).
- **`wss://kusama-rpc.dwellir.com` (the value currently in `project-kusama.yaml`) has been unreliable** — drops WebSocket with `1006 Abnormal Closure` in a tight loop. For probes prefer `wss://kusama-rpc.polkadot.io` or a private endpoint via env-file.
- **`WsProvider` default auto-reconnect loops forever** when the endpoint refuses connections. For one-shot probes disable autoreconnect and wrap connect in a 20 s timeout:
  ```js
  const provider = new WsProvider(endpoint, false);
  const t = setTimeout(() => { console.error("connect timeout 20s"); process.exit(2); }, 20000);
  await provider.connect();
  await new Promise((res, rej) => { provider.on("connected", res); provider.on("error", rej); });
  clearTimeout(t);
  const api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  ```
- **`-v "$PWD":/src:ro,Z`** — the `:Z` SELinux relabel is harmless on non-SELinux distros but required if you're on Fedora/RHEL/CentOS. `:ro` is critical: the script must not write to your repo from inside the container.
- **Background runs:** start with `podman run --rm …` and let the harness's background facility track it; do not chain `sleep && tail` loops.

### Cleanup

- `--rm` removes the container on exit (already in every snippet above).
- After ad-hoc probes: delete `scripts/_tmp-*.js`, `shred -u /tmp/<rpc-env-file>` if used.
- Long-running build/test workflows: `make podman-clean` (removes containers, network, and the `subql-workspace` volume).

---

## Debugging & Scan Scripts

All scripts live in `scripts/`. Most scripts read endpoints from `scripts/asset-hub-spec-blocks.json` — no need to pass RPC endpoints manually. Never hardcode or commit tokenized RPC URLs.

**On Linux these scripts must be executed under Podman — see the section above for the wrapper pattern.**

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
- `src/utils/addressesDecode.ts` -> `createKeyMultiAccountId()`, `decodeAddress()`

**Cause:** EVM chains use 20-byte addresses (Ethereum format) instead of 32-byte Substrate addresses. `createKeyMultiAccountId` handles both formats, but any changes must account for both code paths.

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
   Non-zero count on an AH chain (current height ≪ 20M) indicates `createPure(when=...)` flow is live and the fix is needed.

**Fix:** In `extractPureProxyEventData`, read `data.at(4)` / `data.at(5)` first and only fall back to `eventParser.blockNumber(event)` / `eventParser.extrinsicIndex(event)` when those fields are absent (older `AnonymousCreated` runtimes). Covered by test `src/test/polkadot-asset-hub/pureProxyEventHandler-when.test.ts` (block 15,503,985).

**Related but distinct:** §4 is the same family of "computed pure ≠ on-chain pure" symptoms; that section covers the parachain-relay-parent fallback. §14 is the migration-era `maybe_when` override which neither the parachain block nor the relay-parent block can reproduce.

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

### Networks indexed by this project

Both scripts below select the chain by its `chain` value stored in `app._metadata_*` (populated by SubQuery from `system.chain()` at index time). Set that string in **one place** at the top of the script.

Genesis hashes are listed for cross-reference with `chain_id` in operational tables.

| Project YAML                          | `chain` (in `_metadata_*.chain`) | Genesis hash |
|---------------------------------------|----------------------------------|--------------|
| `project-polkadot.yaml`               | `Polkadot`                       | `0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3` |
| `project-kusama.yaml`                 | `Kusama`                         | `0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe` |
| `project-westend.yaml`                | `Westend`                        | `0xe143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e` |
| `project-polkadot-asset-hub.yaml`     | `Polkadot Asset Hub`             | `0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f` |
| `project-kusama-asset-hub.yaml`       | `Kusama Asset Hub`               | `0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a` |
| `project-westend-asset-hub.yaml`      | `Westend Asset Hub`              | `0x67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9` |
| `project-polkadot-collectives.yaml`   | `Collectives`                    | `0x46ee89aa2eedd13e988962630ec9fb7565964cf5023bb351f2b6b25c1b68b0b2` |
| `project-polkadot-people-chain.yaml`  | `Polkadot People`                | `0x67fa177a097bfa18f77ea95ab56e9bcdfeb0e5b8a40e46298bb93e16b6fc5008` |
| `project-kusama-people-chain.yaml`    | `Kusama People`                  | `0xc1af4cb4eb3918e5db15086c0cc5ec17fb334f728b7c65dd44bfe1e174ff8b3f` |
| `project-polkadot-coretime.yaml`      | `Polkadot Coretime`              | `0xefb56e30d9b4a24099f88820987d0f45fb645992416535d87650d98e00f46fc4` |
| `project-kusama-coretime.yaml`        | `Kusama Coretime`                | `0x638cd2b9af4b3bb54b8c1f0d22711fc89924ca93300f0caf25a580432b29d050` |
| `project-moonbeam.yaml`               | `Moonbeam`                       | `0xfe58ea77779b7abda7da4ec526d14db9b1e9cd40a217c34892af80a9b332b76d` |
| `project-moonriver.yaml`              | `Moonriver`                      | `0x401a1f9dca3da46f5c4091016c8a2f26dcea05865116b286f60f668207d1474b` |
| `project-hydradx.yaml`                | `Hydration`                      | `0xafdc188f45c71dacbaa0b62e16a91f726c7b8699a9748cdf715459de6b7f366d` |
| `project-aleph-zero.yaml`             | `Aleph Zero`                     | `0x70255b4d28de0fc4e1a193d7e175ad1ccef431598211c55538f1018651a0344e` |
| `project-mythos.yaml`                 | `Mythos`                         | `0xf6ee56e9c5277df5b4ce6ae9983ee88f3cbed27d31beeb98f9f84f997a1ab0b9` |
| `project-avail.yaml`                  | `Avail DA Mainnet`               | `0xb91746b45e0346cc2f815a520b9c6cb4d5c0902af848db0a80f85932d2e8276a` |
| `project-testnet.yaml`                | `Development`                    | `0x3dbb473ae9b2b77ecf077c03546f0f8670c020e453dddb457da155e6cc7cba42` |
| `project-rococo.yaml`                 | _(not currently in DB; re-run discovery query after indexing)_ | `0x6408de7737c59c238890533af25896a2c20608d8b380bb01029acb392781063e` |
| `project-bittensor.yaml`              | _(not currently in DB; re-run discovery query after indexing)_ | `0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03` |

> Values verified from the live `_metadata_*` tables. The `chain` string comes from the chain runtime itself, so a runtime upgrade may rename it (e.g. `HydraDX` → `Hydration`, `Avail` → `Avail DA Mainnet`). If a wipe ever fails with `Metadata table not found for chain=...`, re-run [`scripts/list-indexed-chains.sql`](scripts/list-indexed-chains.sql) and update this table.

### SQL scripts

All three scripts live in `scripts/` and use the same single-variable convention (`v_target_chain` at the top, must match `_metadata_*.chain` exactly).

| Script                                                              | Purpose                                                                                                                       |
|---------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| [`scripts/list-indexed-chains.sql`](scripts/list-indexed-chains.sql) | Discovery: list every `_metadata_*` table with its stored `chain` and `genesisHash`. Run first to find the exact target string. |
| [`scripts/wipe-chain-preview.sql`](scripts/wipe-chain-preview.sql)   | Dry-run preview: prints row counts that **would** be deleted for the target chain. Wrapped in `BEGIN; … ROLLBACK;` — no writes. |
| [`scripts/wipe-chain.sql`](scripts/wipe-chain.sql)                   | Actual wipe: deletes chain-scoped rows from `multisig_events`, `multisig_operations`, `proxieds`, `pure_proxies`, then drops the `_metadata_*` table. Idempotent — re-running after success is a clean no-op. Prints per-table deleted row counts so output can be diffed against the preview. |

Typical flow:

```bash
psql "$DATABASE_URL" -f scripts/list-indexed-chains.sql                          # confirm exact chain name
# edit v_target_chain in both files (or sed -i "s/'Kusama'/'<your chain>'/" ...)
psql "$DATABASE_URL" -f scripts/wipe-chain-preview.sql                           # verify counts
psql "$DATABASE_URL" -f scripts/wipe-chain.sql                                   # commit the wipe
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
