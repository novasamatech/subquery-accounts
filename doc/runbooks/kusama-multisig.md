# Kusama Multisig History

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

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

See `scripts/diagnostics/debug-kusama-multisig-block.js` (described in [diagnostic catalog](../development/diagnostics.md#kusama-multisig)).

Verified examples:
- Block `2016479` (`utility.NewMultisig`, spec `1055`): event has 2 fields, no callHash; fallback from `utility.asMulti` call arg returns `0x5f1a...3087`
- Block `2016525` (`utility.MultisigExecuted`, spec `1055`): index 3 is `DispatchResult` (can serialize as `0x00`); valid callHash still comes from extrinsic fallback
