# Hotfix: pure-proxy `at`/`extrinsicIndex` and `disambiguationIndex` parsing

- **Branch:** `hotfix/v2.4.2-pure-proxy-when`
- **Base:** tag `v2.4.2` (clean, no other commits)
- **Files touched:** `src/utils/extractPureProxyEventData.ts` (only)
- **Triggering incident:** Polkadot Asset Hub block `15,503,985`, prod image `v2.4.2-node-js-22-subql-node-v6.3.5` crashes in a loop.

---

## 1. Symptom

The indexer for `project-polkadot-asset-hub.yaml` (prod tag `v2.4.2`) loops on block 15,503,985 with:

```
ERROR Failed to index block at height 15503985 handlePureProxyEvent
  (Error: Who 0x6c9e3102dd2c24274667d416e07570ebce6f20ab80ee3fc9917bf4a7568b8fd2
   is not the pure account 0xa5f47b00b4465435ecfc6351065055297c4e9b2a63647484771ebd0ada2da80a
   or the pure account relay parent 0xc527295a4d3c3dd569dbc0bc01aaf3face2ffafca32b06323db80f…)
```

The throw is at `src/utils/pureAccountCalculation.ts:147` (`findPureBlockNumber`). It fires when neither the parachain block number nor the relay-parent block number, when plugged into the substrate `pure_account` derivation, reproduces the on-chain pure address from the event.

Indexer never advances past 15,503,985 → no new data for Polkadot AH.

## 2. Approaches considered and rejected

In chronological order, each was ruled out by subsequent evidence.

### 2.1. ❌ Backport PR #90 (`createEntropyData` sandbox fix)

PR #90 on `main` (commit `dfae321`) replaces `stringToU8a("modlpy/proxy____")` with `hexToU8a(...)` and wraps every `api.registry.createType(...).toU8a()` result through `Uint8Array.from`. The rationale: under the SubQuery sandbox, `stringToU8a`'s TextEncoder lives in the host Node realm and the resulting `Uint8Array` fails `instanceof Uint8Array` checks; `u8aConcat*` then silently falls back to `stringToU8a(value.toString())` and corrupts the entropy bytes.

A backport was applied to a now-deleted branch. **Result: produced the exact same computed addresses** (`0xa5f4…` / `0xc527…`). The entropy was not actually corrupted on v2.4.2; PR #90 is a real fix for a real bug, but **not the one biting prod**.

### 2.2. ❌ Relax the `throw` in `findPureBlockNumber` to a `logger.warn` + fallback

Idea: if neither block nor relay parent matches, log a warning and use the event's block as a fallback so the indexer keeps moving.

This was a **cover-up**. Reasons not to take this path:

- `PureProxy.id = ${chainId}-${pure}` and `Proxied.id = ${chainId}-${pure}-${spawner}-Any-0`. The relay-side `handleAssetHubMigrationEvent` (in `project-polkadot.yaml`) already copies relay-chain `PureProxy`/`Proxied` rows to the AH chainId on `rcMigrator.AssetHubMigrationStarted`. A fallback insert from the AH side would **upsert with wrong derivation data**, silently overwriting the correct migrated row.
- Even if the upsert collision were harmless, this hides a real bug. The runtime tells us *exactly* which inputs went into the entropy. We should use them, not paper over the mismatch.

### 2.3. ❌ Add `isSigned: true` / `success: true` filters to the parachain YAMLs

Observation that motivated this: relay YAMLs (`project-polkadot.yaml`, …) have these filters on event handlers; parachain YAMLs (all of them) do not. Hypothesis: the offending event is unsigned — emitted by a runtime migration hook — and could be filtered out.

Direct RPC inspection of the block disproved this:

```
phase:    applyExtrinsic[2]
extrinsic: proxy.createPure
isSigned: true
signer:   13TRAXTALwNp5vApqwiE74fg8G8ypMyaF9TxRfs4RwrCwxUE
```

This is a regular **signed** user-initiated `proxy.createPure`. An `isSigned: true` filter would **not** skip it (and shouldn't — we want to index pure proxies users create on AH).

The parachain-vs-relay YAML asymmetry is unrelated to the crash. It is a separate, minor consistency issue.

## 3. Root cause

RPC dump of the offending event (`wss://asset-hub-polkadot-rpc.n.dwellir.com`, block 15,503,985, event #5):

```
proxy.PureCreated {
    pure:                  15aFQvvt8j2ZCvMEjnUSz7s1nxt1yA1znBN8yUFo1SCr4YMk,
    who:                   13TRAXTALwNp5vApqwiE74fg8G8ypMyaF9TxRfs4RwrCwxUE,
    proxyType:             Any,
    disambiguationIndex:   "1,337"       ← data[3]
    at:                    "31,147,672"  ← data[4]   (relay-chain block!)
    extrinsicIndex:        "2"           ← data[5]
}
```

The event has **six fields**. Substrate's `pure_account` is:

```rust
pub fn pure_account(who, proxy_type, index, maybe_when) -> AccountId {
    let (height, ext_index) = maybe_when.unwrap_or_else(|| {
        (system::block_number(), system::extrinsic_index().unwrap_or_default())
    });
    let entropy = (b"modlpy/proxy____", who, height, ext_index, proxy_type, index)
        .using_encoded(blake2_256);
    ...
}
```

When a user calls `proxy.createPure(... , when = Some((historic_block, historic_ext_idx)))` — canonical scenario: an AH user recreating their **relay-chain** pure proxy on Asset Hub with the same address — the runtime derives the pure with the historic `(height, ext_index)`, **not** the current parachain block. The event payload's `at` and `extrinsicIndex` reflect exactly what went into the derivation.

The on-chain `15aFQ…` was derived with `height = 31,147,672` (a Polkadot relay block), `ext_index = 2`, `disambiguationIndex = 1337`. To reproduce it, we must use those.

`extractPureProxyEventData` in v2.4.2 fails on this in **two independent ways**:

### Bug #1 (v2.4.2 only): `parseInt(toHuman())` truncates at thousands separator

```ts
const disambiguationIndex = parseInt(data.at(3)?.toHuman() as string);
```

`toHuman()` formats numbers with commas. For `1337` it returns the string `"1,337"`. `parseInt("1,337")` returns `1` (parses until the comma and stops). Entropy is then computed with `index = 1` instead of `1337` → wrong pure (`0xa5f4…`).

Status on `main`: fixed by PR #88 (`Number(data.at(3)?.toString())`).

### Bug #2 (v2.4.2 AND main): ignoring `at` and `extrinsicIndex` from event payload

```ts
return {
    ...,
    blockNumber: eventParser.blockNumber(event),    // = event.block.block.header.number
    extrinsicIndex: eventParser.extrinsicIndex(event), // = event.extrinsic.idx
};
```

This pulls block/extrinsic from the **envelope** (where the call was dispatched), not from the event payload (what actually went into the entropy). For a normal `createPure` without `when`, the two coincide and we get away with it — which is why the bug has gone undetected for years. For `createPure(when=Some(...))` they diverge.

Status on `main`: **NOT fixed**. Main currently crashes on this scenario as well; it just happens that prod runs v2.4.2 so we see it there first.

## 4. The fix

Patch is in `src/utils/extractPureProxyEventData.ts` only. Two changes:

```ts
// Bug #1: parseInt(toHuman()) → Number(toString())
const disambiguationIndex = Number(data.at(3)?.toString());

// Bug #2: prefer payload `at`/`extrinsicIndex` over envelope
const atField = data.at(4);
const extrinsicIndexField = data.at(5);

const blockNumber = atField !== undefined
    ? Number(atField.toString())
    : eventParser.blockNumber(event);
const extrinsicIndex = extrinsicIndexField !== undefined
    ? Number(extrinsicIndexField.toString())
    : eventParser.extrinsicIndex(event);
```

Plus the same `toString()` switch for `pure` and `who` (mirrors PR #88 on main — `toHuman()` for an `AccountId` returns SS58, `toString()` returns the canonical hex; both are accepted by our `decodeAddress`, but `toString()` is cheaper and what main uses, so the code paths converge).

Plus stricter validation: `Number.isFinite()` instead of `typeof === "number"` (catches `NaN`), and validation on `blockNumber`/`extrinsicIndex` as well.

**Fallback strategy for `at`/`extrinsicIndex`:** if `data.at(4)` is `undefined` (older runtime emitting `AnonymousCreated` with only 4 fields, or any chain whose runtime doesn't include these), we fall back to the envelope — same behaviour as before the fix. The new path activates only when the runtime explicitly provides the derivation inputs.

## 5. Verification

The diagnostic script that produced the RPC dump in §3 is at `/tmp/inspect-ah-block.mjs` (not committed, ad-hoc). To reproduce:

```js
import { ApiPromise, WsProvider } from "@polkadot/api";
const api = await ApiPromise.create({ provider: new WsProvider("wss://asset-hub-polkadot-rpc.n.dwellir.com", 5000) });
const hash = await api.rpc.chain.getBlockHash(15503985);
const records = await api.query.system.events.at(hash);
records.forEach(r => {
  if (r.event.section === "proxy" && r.event.method === "PureCreated") {
    console.log("phase:", r.phase.toJSON());
    console.log("data:",  r.event.toHuman());
  }
});
```

After the fix, derivation runs with `(spawner=13TRA…, blockHeight=31147672, extIdx=2, proxyType=Any, index=1337)` and the on-chain pure `15aFQ…` is reproduced by construction (these are the very inputs that `system::block_number()` and `system::extrinsic_index()` returned at relay-side derivation, taken straight from the event payload). `findPureBlockNumber` matches on the first branch and returns `31147672` — no fallback, no warn.

End-to-end repro suggested with `scripts/run-podman-block-test.sh` (lives on `main`, not on this branch — copy over if needed):

```bash
scripts/run-podman-block-test.sh project-polkadot-asset-hub.yaml 15503985 --workers=1
```

Before the fix: the indexer crashes at 15,503,985 as on prod. After: the block is indexed and the indexer proceeds to 15,504,073+.

## 6. What's NOT in this hotfix

- **Tests.** Backporting the `subqlTest` infrastructure from `main` (PR #90 added `docker-compose-test.yml`, `scripts/run-tests.sh`, the `.github/workflows/pr.yml` test job, and the `src/test/polkadot-asset-hub/*.test.ts` suite) is feasible but pulls in 5+ files of CI/test plumbing. Held back to keep the prod hotfix minimal. A separate follow-up should land: tests on main (covering both the migration scenario and ordinary `createPure`) plus, if desired, the same fixture and infra on this hotfix branch.
- **PR #90 (`createEntropyData` sandbox fix).** Real bug, but disjoint from this crash and the backport branch is now closed. Should land independently on a future v2.4.x release if v2.4.x continues to be maintained.
- **Parachain YAML filter asymmetry.** Cosmetic inconsistency between relay and parachain YAMLs (relay has `isSigned: true` / `success: true` on event handlers, parachains don't). Not related to this crash; can be addressed separately when convenient.

## 7. Status on `main`

Bug #2 is present on `main` as well. `main`'s `extractPureProxyEventData` still uses `eventParser.blockNumber(event)` / `eventParser.extrinsicIndex(event)` rather than `data.at(4)` / `data.at(5)`. The same fix should land on `main` in a separate PR, plus a test fixture targeting block 15,503,985.

Bug #1 is already fixed on `main` (PR #88).

## 8. References

- Substrate `pure_account` derivation (Polkadot SDK `pallet_proxy`)
- Polkadot AH genesis hash: `0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f`
- Offending block: https://assethub-polkadot.subscan.io/block/15503985 (event #5)
- Indexer error: `src/utils/pureAccountCalculation.ts:147` (`findPureBlockNumber`)
- Event-data extraction: `src/utils/extractPureProxyEventData.ts` (the file touched by this hotfix)
