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
// Several databases can be backfilled from ONE chain pass: operations are
// unified by id across the given extracts (the id is derived from chain data,
// so it is identical in every database), probed once, and a separate SQL file
// is emitted per database containing only the events that database lacks.
//
// Usage (normally via backfill-multisig-approvals.sh):
//   node scripts/backfill-multisig-approvals.js --schema app \
//     --extract db1=extract1.json [--extract db2=extract2.json ...] \
//     [--out-dir .] [--chains <chainId,...>] [--concurrency 8] [--endpoints <file.json>]
//
// extract file — JSON {"operations": [{id, chain_id, account_id, call_hash, status,
//                  block_created, index_created, threshold, events: [{id, status, block_created}]}]}
// output       — <out-dir>/fix-multisig-approvals-<name>.sql per extract
// stderr       — per-chain progress, stats and warnings
//
// Endpoints are taken from the network.endpoint of each project-*.yaml (mapped
// by genesis hash). Override with --endpoints <file.json> mapping a chainId to
// a url or an ARRAY of urls (operations are distributed round-robin across
// them) when a manifest endpoint is not an archive node — historical storage
// reads REQUIRE an archive node for the whole lifetime of the operations
// involved.

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

function argValues(flag) {
  const values = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag) values.push(process.argv[i + 1]);
  }
  return values;
}

const schema = argValue("--schema");
const extractArgs = argValues("--extract");
if (!schema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || extractArgs.length === 0) {
  console.error(
    "Usage: node scripts/backfill-multisig-approvals.js --schema <db-schema> --extract <name>=<file.json> [--extract <name>=<file.json> ...] [--out-dir <dir>] [--chains <chainId,...>] [--concurrency <n>] [--endpoints <file.json>]",
  );
  process.exit(2);
}

const outDir = argValue("--out-dir") ?? ".";
const concurrency = Math.max(1, Number(argValue("--concurrency") ?? 8));
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
      endpoints[chainMatch[1].toLowerCase()] = [endpointMatch[1]];
    }
  }
  return endpoints;
}

const endpoints = loadManifestEndpoints(path.join(__dirname, ".."));
const endpointsOverrideFile = argValue("--endpoints");
if (endpointsOverrideFile) {
  const overrides = JSON.parse(fs.readFileSync(endpointsOverrideFile, "utf8"));
  for (const [chainId, urls] of Object.entries(overrides)) {
    endpoints[chainId.toLowerCase()] = Array.isArray(urls) ? urls : [urls];
  }
}

// ---------------------------------------------------------------------------
// input loading and unification
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

const extracts = extractArgs.map(arg => {
  const eq = arg.indexOf("=");
  if (eq === -1) throw new Error(`--extract expects <name>=<file.json>, got: ${arg}`);
  const name = arg.slice(0, eq);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid extract name: ${name}`);
  const operations = JSON.parse(fs.readFileSync(arg.slice(eq + 1), "utf8")).operations ?? [];
  for (const op of operations) assertOperationShape(op);
  return { name, operations };
});

// The operation id is `${callHash}-${account}-${block}-${index}` — pure chain
// data, so the same operation carries the same id in every database. One
// unified entry per id records which databases contain it and which event ids
// each already has; the resolution window is merged across databases (one may
// have caught a resolution event the other missed).
function unifyOperations() {
  const unified = new Map();

  for (const { name, operations } of extracts) {
    for (const op of operations) {
      let entry = unified.get(op.id);
      if (!entry) {
        entry = {
          id: op.id,
          chain_id: op.chain_id.toLowerCase(),
          account_id: op.account_id,
          call_hash: op.call_hash,
          block_created: op.block_created,
          index_created: op.index_created,
          resolved: false,
          resolutionBlock: null,
          perDb: new Map(),
        };
        unified.set(op.id, entry);
      }

      if (op.status !== "pending") entry.resolved = true;
      for (const event of op.events) {
        if (event.block_created > entry.block_created) {
          entry.resolutionBlock = Math.max(entry.resolutionBlock ?? 0, event.block_created);
        }
      }

      entry.perDb.set(name, new Set(op.events.map(e => e.id)));
    }
  }

  return Array.from(unified.values());
}

// ---------------------------------------------------------------------------
// chain probing
// ---------------------------------------------------------------------------

// Auto-reconnect (2.5s) keeps a multi-hour run alive across WebSocket drops:
// requests in flight during a drop fail and surface as per-operation warnings,
// the rest of the run proceeds after reconnect (failed operations are picked up
// by an idempotent re-run). The initial connect is still bounded by a timeout.
async function connect(endpoint) {
  const provider = new WsProvider(endpoint, 2500);
  let timer;
  try {
    return await Promise.race([
      ApiPromise.create({ provider, noInitWarn: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`connect timeout 30s for ${endpoint}`)), 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// multisig storage moved from `utility` to `multisig` on old Kusama runtimes;
// pick whichever module exposes the map at the queried block.
function multisigStorage(apiAt) {
  return apiAt.query.multisig?.multisigs ?? apiAt.query.utility?.multisigs ?? null;
}

// The block-hash cache stores promises so concurrent operations probing the
// same block share one in-flight RPC call instead of racing duplicates.
function getBlockHash(api, blockNumber, blockHashCache) {
  let cached = blockHashCache.get(blockNumber);
  if (!cached) {
    cached = api.rpc.chain.getBlockHash(blockNumber);
    blockHashCache.set(blockNumber, cached);
  }
  return cached;
}

async function readEntry(api, blockNumber, accountId, callHash, blockHashCache) {
  const apiAt = await api.at(await getBlockHash(api, blockNumber, blockHashCache));
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
  const apiAt = await api.at(await getBlockHash(api, blockNumber, blockHashCache));
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

async function recoverOperation(api, op, headNumber, blockHashCache) {
  let windowEnd;
  let endApprovals;

  if (op.resolved && op.resolutionBlock) {
    // The creation event carries the creation block; MultisigExecuted / reject
    // events carry the block they actually happened in (see createMultisigEvent).
    windowEnd = op.resolutionBlock - 1;
    endApprovals = await approvalsAt(api, windowEnd, op, blockHashCache);
    if (!endApprovals) {
      // resolved in the same block it got its last approval, or a non-archive node
      return { warn: `operation ${op.id}: no storage entry at block ${windowEnd} — same-block resolution or non-archive endpoint` };
    }
  } else if (op.resolved) {
    return { warn: `operation ${op.id}: resolved but no resolution event block in any extract — cannot bound the search window` };
  } else {
    windowEnd = headNumber;
    endApprovals = await approvalsAt(api, headNumber, op, blockHashCache);
    if (!endApprovals) {
      return { warn: `operation ${op.id} is 'pending' in every extract but absent from head storage — resolved on-chain; re-run after the indexer catches up` };
    }
  }

  if (endApprovals.length <= 1) return { rows: [] };

  const rows = [];

  for (let target = 2; target <= endApprovals.length; target++) {
    const block = await findTransitionBlock(api, op, op.block_created, windowEnd, target, blockHashCache);
    const approval = await extractApprovalEvent(api, block, op, blockHashCache);
    if (!approval) {
      return { warn: `operation ${op.id}: approvals grew to ${target} at block ${block} but no matching MultisigApproval event found there` };
    }

    rows.push({
      id: `${op.id}-${approval.signer}-approve`,
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
// concurrency pool
// ---------------------------------------------------------------------------

async function mapConcurrent(items, limit, fn) {
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  });

  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// SQL emission
// ---------------------------------------------------------------------------

function sqlString(value) {
  if (!/^[0-9a-zA-Z_:.\-]+$/.test(value)) throw new Error(`Refusing to inline suspicious SQL value: ${value}`);
  return `'${value}'`;
}

function writeSqlFile(filePath, rows) {
  const lines = [];
  if (rows.length === 0) {
    lines.push("-- nothing to fix");
  } else {
    lines.push("BEGIN;");
    lines.push(`-- ${rows.length} recovered multisig approval events`);
    for (const row of rows) {
      lines.push(
        `INSERT INTO ${schema}.multisig_events (id, account_id, status, block_created, index_created, multisig_id, timestamp)\n` +
          `VALUES (${sqlString(row.id)}, ${sqlString(row.accountId)}, 'approve', ${row.blockCreated}, ${row.indexCreated}, ${sqlString(row.multisigId)}, ${row.timestamp})\n` +
          `ON CONFLICT (id) DO NOTHING;`,
      );
    }
    lines.push("COMMIT;");
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const operations = unifyOperations();

  const byChain = new Map();
  for (const op of operations) {
    if (chainFilter && !chainFilter.has(op.chain_id)) continue;
    if (!byChain.has(op.chain_id)) byChain.set(op.chain_id, []);
    byChain.get(op.chain_id).push(op);
  }

  const rowsPerDb = new Map(extracts.map(e => [e.name, []]));
  let warnings = 0;

  for (const [chainId, chainOps] of byChain) {
    const chainEndpoints = endpoints[chainId];
    if (!chainEndpoints || chainEndpoints.length === 0) {
      console.error(`WARN no endpoint known for chain ${chainId} — skipping ${chainOps.length} operations`);
      warnings += chainOps.length;
      continue;
    }

    console.error(
      `== chain ${chainId}: ${chainOps.length} operations via ${chainEndpoints.join(", ")} (concurrency ${concurrency})`,
    );
    const apis = [];
    for (const endpoint of chainEndpoints) {
      try {
        apis.push(await connect(endpoint));
      } catch (error) {
        console.error(`WARN endpoint ${endpoint} failed to connect: ${error.message}`);
      }
    }
    if (apis.length === 0) {
      console.error(`WARN no reachable endpoint for chain ${chainId} — skipping ${chainOps.length} operations`);
      warnings += chainOps.length;
      continue;
    }

    try {
      const headNumber = (await apis[0].rpc.chain.getHeader()).number.toNumber();
      const blockHashCache = new Map();
      let done = 0;
      let recovered = 0;

      await mapConcurrent(chainOps, concurrency, async (op, index) => {
        const api = apis[index % apis.length];
        try {
          const result = await recoverOperation(api, op, headNumber, blockHashCache);
          if (result.warn) {
            console.error(`WARN ${result.warn}`);
            warnings += 1;
          } else {
            for (const row of result.rows) {
              recovered += 1;
              for (const [dbName, knownEventIds] of op.perDb) {
                if (knownEventIds.has(row.id)) continue;
                rowsPerDb.get(dbName).push(row);
              }
            }
          }
        } catch (error) {
          console.error(`WARN operation ${op.id} failed: ${error.message}`);
          warnings += 1;
        }
        done += 1;
        if (done % 50 === 0 || done === chainOps.length) {
          console.error(`   ${done}/${chainOps.length} processed, ${recovered} approvals recovered on this chain`);
        }
      });
    } finally {
      await Promise.all(apis.map(api => api.disconnect().catch(() => {})));
    }
  }

  for (const { name } of extracts) {
    const rows = rowsPerDb.get(name);
    const filePath = path.join(outDir, `fix-multisig-approvals-${name}.sql`);
    writeSqlFile(filePath, rows);
    console.error(`== ${name}: ${rows.length} events -> ${filePath}`);
  }
  console.error(`== done, ${warnings} warnings`);
}

main().catch(error => {
  console.error(`ERROR ${error.stack ?? error}`);
  process.exit(1);
});
