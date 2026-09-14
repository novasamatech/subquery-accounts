# Indexer Architecture

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

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
    mappingHandlers.ts      # Handler exports used by src/index.ts
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
chainTypes/                     # Network type bundles and extrinsic compatibility codecs
docker/                         # Indexer and PostgreSQL images
docker-compose.yml              # Legacy multichain example; not the current deployment source
docker-compose-local.yml        # Legacy single-chain example
local-runner.sh                 # Legacy destructive startup; use scripts/podman/ instead
scripts/
  diagnostics/                 # Runnable RPC / GraphQL diagnostic tools
  lib/                         # Shared diagnostic logic, no CLI side effects
  data/                        # Shared chain/spec inputs
  tests/                       # Offline tests and fixtures
  podman/                      # Rootless build / test / replay workflows
  ci/                          # Docker workflow adapters
  db/                          # Read-only discovery / preview and explicit wipe SQL
doc/                           # Architecture, development guides and runbooks
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

### The `subquery-call-visitor` Library

The installed version is pinned in `package.json`/`yarn.lock`. Central to the project. Implements a **visitor pattern** for recursively walking nested Substrate calls (batch > proxy > multisig, etc.).

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
MultisigApproval    -> finds existing operation, adds MultisigEvent
MultisigExecuted    -> finalizes (status: executed | error)
MultisigCancelled   -> cancels (status: cancelled)
```

Operation lookup (`findExistingOperation` in `multisigHelpers.ts`):
1. Exact match: `callHash + blockCreated + indexCreated + accountId`
2. Fallback: `callHash + accountId + status=pending`
3. If not found -- throws Error (crashes indexer on that block)

## SubQuery Runtime Global Variables

Available in handlers without importing:
- `api` -- `ApiPromise` instance (restricted, no unsafeApi)
- `chainId` -- genesis hash of the current network (string)
- `logger` -- SubQuery logger
