#!/usr/bin/env node
// Recover intermediate multisig approval events that were never indexed because
// every project manifest filtered on "MultisigApproved" while the pallet event
// is named "MultisigApproval" (fixed in PR #95). Until that fix no
// handleMultisigApprovedEvent ever fired, so every operation is missing the
// approvals between the depositor's NewMultisig and the final
// MultisigExecuted/MultisigCancelled.
//
// The missing data is recovered from chain state, not guessed:
//   - the approvals list of a pending multisig lives in multisig.multisigs
//     storage until the operation resolves;
//   - for a resolved operation the storage entry existed in every block of the
//     [creation, resolution) window, and the approvals array only ever grows;
//   - so each missing approval is a transition block found by binary search
//     over that window on an archive node, and the exact signer / extrinsic
//     index / timestamp are read from that block's MultisigApproval event.
//
// Usage (normally via backfill-multisig-approvals.sh):
//   node scripts/backfill-multisig-approvals.js --schema app [--chains <id,...>] < extract.json > fix.sql
//
// stdin  — JSON {"operations": [{id, chain_id, account_id, call_hash, status,
//            block_created, index_created, threshold, events: [{id, status, block_created}]}]}
// stdout — SQL transaction (nothing to fix -> "-- nothing to fix")
// stderr — per-chain progress, stats and warnings
//
// Endpoints are taken from the network.endpoint of each project-*.yaml (mapped
// by genesis hash). Override with --endpoints <file.json> ({"0x..chainId": "wss://..."})
// when a manifest endpoint is not an archive node — historical storage reads
// REQUIRE an archive node for the whole lifetime of the operations involved.

"use strict";

const fs = require("fs");
const path = require("path");

const { WsProvider, ApiPromise } = require("@polkadot/api");

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const schema = argValue("--schema");
if (!schema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
  console.error("Usage: node scripts/backfill-multisig-approvals.js --schema <db-schema> [--chains <chainId,...>] [--endpoints <file.json>] < extract.json > fix.sql");
  process.exit(2);
}

const chainFilter = argValue("--chains")
  ? new Set(argValue("--chains").split(",").map(s => s.trim().toLowerCase()))
  : null;

// ---------------------------------------------------------------------------
// endpoint discovery: project-*.yaml network.chainId -> network.endpoint
// ---------------------------------------------------------------------------

function loadManifestEndpoints(repoRoot) {
  const endpoints = {};
  for (const file of fs.readdirSync(repoRoot)) {
    if (!/^project-.*\.yaml$/.test(file)) continue;
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const chainMatch = text.match(/chainId:\s*"(0x[0-9a-fA-F]{64})"/);
    // endpoint may be a plain scalar or a folded (>-) block scalar
    const endpointMatch = text.match(/endpoint:\s*(?:>-?\s*\n\s*)?(wss?:\/\/\S+)/);
    if (chainMatch && endpointMatch) {
      endpoints[chainMatch[1].toLowerCase()] = endpointMatch[1];
    }
  }
  return endpoints;
}

const endpoints = loadManifestEndpoints(path.join(__dirname, ".."));
const endpointsOverrideFile = argValue("--endpoints");
if (endpointsOverrideFile) {
  const overrides = JSON.parse(fs.readFileSync(endpointsOverrideFile, "utf8"));
  for (const [chainId, url] of Object.entries(overrides)) {
    endpoints[chainId.toLowerCase()] = url;
  }
}

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

const HEX = /^0x[0-9a-fA-F]+$/;
const EVENT_STATUS = new Set(["approve", "reject"]);

function assertOperationShape(op) {
  if (!HEX.test(op.chain_id) || !HEX.test(op.account_id) || !HEX.test(op.call_hash)) {
    throw new Error(`Malformed hex fields in operation ${op.id}`);
  }
  if (!Number.isInteger(op.block_created) || !Number.isInteger(op.index_created)) {
    throw new Error(`Malformed timepoint in operation ${op.id}`);
  }
  for (const event of op.events) {
    if (!EVENT_STATUS.has(event.status) || !Number.isInteger(event.block_created)) {
      throw new Error(`Malformed event on operation ${op.id}`);
    }
  }
}

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const operations = input.operations ?? [];
for (const op of operations) assertOperationShape(op);

// ---------------------------------------------------------------------------
// chain probing
// ---------------------------------------------------------------------------

async function connect(endpoint) {
  const provider = new WsProvider(endpoint, false);
  const timer = setTimeout(() => {
    console.error(`ERROR connect timeout 20s`);
    process.exit(3);
  }, 20000);
  await provider.connect();
  await new Promise((resolve, reject) => {
    provider.on("connected", resolve);
    provider.on("error", reject);
  });
  clearTimeout(timer);
  return ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
}

// multisig storage moved from `utility` to `multisig` on old Kusama runtimes;
// pick whichever module exposes the map at the queried block.
function multisigStorage(apiAt) {
  return apiAt.query.multisig?.multisigs ?? apiAt.query.utility?.multisigs ?? null;
}

async function readEntry(api, blockNumber, accountId, callHash, blockHashCache) {
  if (!blockHashCache.has(blockNumber)) {
    blockHashCache.set(blockNumber, await api.rpc.chain.getBlockHash(blockNumber));
  }
  const apiAt = await api.at(blockHashCache.get(blockNumber));
  const storage = multisigStorage(apiAt);
  if (!storage) return null;

  const entry = await storage(accountId, callHash);
  return entry && entry.isSome ? entry.unwrap() : null;
}

// Number of approvals of THIS operation instance at the given block. The
// (account, callHash) key can host only one live instance at a time, and our
// probes stay inside [creation, resolution), so a Some entry either matches the
// operation's timepoint or the probe is outside the instance's lifetime.
async function approvalsAt(api, blockNumber, op, blockHashCache) {
  const entry = await readEntry(api, blockNumber, op.account_id, op.call_hash, blockHashCache);
  if (!entry) return null;

  const sameTimepoint =
    entry.when.height.toNumber() === op.block_created && entry.when.index.toNumber() === op.index_created;

  return sameTimepoint ? entry.approvals.map(a => a.toHex().toLowerCase()) : null;
}

// First block in (low, high] where the approvals count reaches `target`.
// Invariant: count(low) < target, count(high) >= target.
async function findTransitionBlock(api, op, low, high, target, blockHashCache) {
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    const approvals = await approvalsAt(api, mid, op, blockHashCache);
    // A missing entry mid-window can only mean the probe landed before the
    // creation block took effect — treat as "not enough approvals yet".
    if (approvals && approvals.length >= target) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high;
}

async function extractApprovalEvent(api, blockNumber, op, blockHashCache) {
  if (!blockHashCache.has(blockNumber)) {
    blockHashCache.set(blockNumber, await api.rpc.chain.getBlockHash(blockNumber));
  }
  const blockHash = blockHashCache.get(blockNumber);
  const apiAt = await api.at(blockHash);
  const [events, timestampNow] = await Promise.all([apiAt.query.system.events(), apiAt.query.timestamp.now()]);

  for (const record of events) {
    const { event, phase } = record;
    if (event.method !== "MultisigApproval") continue;
    if (event.section !== "multisig" && event.section !== "utility") continue;

    const names = event.data.names ?? [];
    const approving = event.data[names.indexOf("approving")] ?? event.data[0];
    const timepoint = event.data[names.indexOf("timepoint")] ?? event.data[1];
    const multisig = event.data[names.indexOf("multisig")] ?? event.data[2];
    const callHash = event.data[names.indexOf("callHash")] ?? event.data[3];

    if (multisig.toHex().toLowerCase() !== op.account_id.toLowerCase()) continue;
    if (callHash.toHex().toLowerCase() !== op.call_hash.toLowerCase()) continue;
    if (timepoint.height.toNumber() !== op.block_created || timepoint.index.toNumber() !== op.index_created) continue;

    return {
      signer: approving.toHex().toLowerCase(),
      blockCreated: blockNumber,
      indexCreated: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : 0,
      timestamp: Math.floor(timestampNow.toNumber() / 1000),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// per-operation recovery
// ---------------------------------------------------------------------------

function resolutionBlock(op) {
  // The creation event carries the creation block; MultisigExecuted / reject
  // events carry the block they actually happened in (see createMultisigEvent).
  const blocks = op.events.map(e => e.block_created).filter(b => b > op.block_created);
  return blocks.length > 0 ? Math.max(...blocks) : null;
}

async function recoverOperation(api, op, headNumber, blockHashCache) {
  let windowEnd;
  let endApprovals;

  if (op.status === "pending") {
    windowEnd = headNumber;
    endApprovals = await approvalsAt(api, headNumber, op, blockHashCache);
    if (!endApprovals) {
      return { warn: `operation ${op.id} is 'pending' in DB but absent from head storage — resolved on-chain; re-run after the indexer catches up` };
    }
  } else {
    const resolved = resolutionBlock(op);
    if (!resolved) {
      return { warn: `operation ${op.id} (${op.status}) has no resolution event block — cannot bound the search window` };
    }
    windowEnd = resolved - 1;
    endApprovals = await approvalsAt(api, windowEnd, op, blockHashCache);
    if (!endApprovals) {
      // resolved in the same block it got its last approval, or a non-archive node
      return { warn: `operation ${op.id}: no storage entry at block ${windowEnd} — same-block resolution or non-archive endpoint` };
    }
  }

  if (endApprovals.length <= 1) return { rows: [] };

  const knownEventIds = new Set(op.events.map(e => e.id));
  const rows = [];

  for (let target = 2; target <= endApprovals.length; target++) {
    const block = await findTransitionBlock(api, op, op.block_created, windowEnd, target, blockHashCache);
    const approval = await extractApprovalEvent(api, block, op, blockHashCache);
    if (!approval) {
      return { warn: `operation ${op.id}: approvals grew to ${target} at block ${block} but no matching MultisigApproval event found there` };
    }

    const eventId = `${op.id}-${approval.signer}-approve`;
    if (knownEventIds.has(eventId)) continue;

    rows.push({
      id: eventId,
      accountId: approval.signer,
      blockCreated: approval.blockCreated,
      indexCreated: approval.indexCreated,
      multisigId: op.id,
      timestamp: approval.timestamp,
    });
  }

  return { rows };
}

// ---------------------------------------------------------------------------
// SQL emission
// ---------------------------------------------------------------------------

function sqlString(value) {
  if (!/^[0-9a-zA-Z_:.\-]+$/.test(value)) throw new Error(`Refusing to inline suspicious SQL value: ${value}`);
  return `'${value}'`;
}

function emitSql(rows) {
  if (rows.length === 0) {
    console.log("-- nothing to fix");
    return;
  }

  console.log("BEGIN;");
  console.log(`-- ${rows.length} recovered multisig approval events`);
  for (const row of rows) {
    console.log(
      `INSERT INTO ${schema}.multisig_events (id, account_id, status, block_created, index_created, multisig_id, timestamp)\n` +
        `VALUES (${sqlString(row.id)}, ${sqlString(row.accountId)}, 'approve', ${row.blockCreated}, ${row.indexCreated}, ${sqlString(row.multisigId)}, ${row.timestamp})\n` +
        `ON CONFLICT (id) DO NOTHING;`,
    );
  }
  console.log("COMMIT;");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const byChain = new Map();
  for (const op of operations) {
    const chainId = op.chain_id.toLowerCase();
    if (chainFilter && !chainFilter.has(chainId)) continue;
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(op);
  }

  const allRows = [];
  let warnings = 0;

  for (const [chainId, chainOps] of byChain) {
    const endpoint = endpoints[chainId];
    if (!endpoint) {
      console.error(`WARN no endpoint known for chain ${chainId} — skipping ${chainOps.length} operations`);
      warnings += chainOps.length;
      continue;
    }

    console.error(`== chain ${chainId}: ${chainOps.length} operations via ${endpoint}`);
    const api = await connect(endpoint);

    try {
      const headNumber = (await api.rpc.chain.getHeader()).number.toNumber();
      const blockHashCache = new Map();
      let done = 0;

      for (const op of chainOps) {
        try {
          const result = await recoverOperation(api, op, headNumber, blockHashCache);
          if (result.warn) {
            console.error(`WARN ${result.warn}`);
            warnings += 1;
          } else {
            allRows.push(...result.rows);
          }
        } catch (error) {
          console.error(`WARN operation ${op.id} failed: ${error.message}`);
          warnings += 1;
        }
        done += 1;
        if (done % 25 === 0 || done === chainOps.length) {
          console.error(`   ${done}/${chainOps.length} processed, ${allRows.length} events recovered so far`);
        }
      }
    } finally {
      await api.disconnect();
    }
  }

  emitSql(allRows);
  console.error(`== done: ${allRows.length} events recovered, ${warnings} warnings`);
}

main().catch(error => {
  console.error(`ERROR ${error.stack ?? error}`);
  process.exit(1);
});
