#!/usr/bin/env node

// Auto-discover all spec version transitions for Asset Hub chains
// and update scripts/asset-hub-spec-blocks.json.
//
// No hardcoded spec list needed — the script walks the chain from block 1,
// binary-searching for each spec transition until it reaches head.
//
// Usage:
//   node scripts/scan-spec-starts.js              # scan all 3 chains
//   node scripts/scan-spec-starts.js polkadot     # scan one chain
//   node scripts/scan-spec-starts.js --dry-run    # print results, don't write JSON
//
// Chain aliases: polkadot|statemint, kusama|statemine, westend|westmint

const { ApiPromise, WsProvider, HttpProvider } = require("@polkadot/api");
const fs = require("fs");
const path = require("path");

const JSON_PATH = path.join(__dirname, "asset-hub-spec-blocks.json");

const CHAINS = [
  { key: "statemint", aliases: ["polkadot", "statemint"] },
  { key: "statemine", aliases: ["kusama", "statemine"] },
  { key: "westmint", aliases: ["westend", "westmint"] },
];

function createProvider(endpoint) {
  return endpoint.startsWith("ws")
    ? new WsProvider(endpoint)
    : new HttpProvider(endpoint);
}

async function getSpec(api, height) {
  const hash = await api.rpc.chain.getBlockHash(height);
  const rv = await api.rpc.state.getRuntimeVersion(hash);
  return Number(rv.specVersion.toString());
}

async function discoverSpecs(api, latest) {
  const specs = {};
  let pos = 1;
  let currentSpec = await getSpec(api, pos);
  specs[currentSpec] = pos;
  let rpcCalls = 2; // getBlockHash + getRuntimeVersion
  console.log(`  [found] spec=${currentSpec} firstBlock=${pos}`);

  while (pos < latest) {
    // Quick check: has spec changed at head?
    const headSpec = await getSpec(api, latest);
    rpcCalls += 2;
    if (headSpec <= currentSpec) break;

    // Binary search for first block where spec > currentSpec
    let lo = pos + 1;
    let hi = latest;

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midSpec = await getSpec(api, mid);
      rpcCalls += 2;
      if (midSpec <= currentSpec) lo = mid + 1;
      else hi = mid;
    }

    const newSpec = await getSpec(api, lo);
    rpcCalls += 2;
    if (newSpec <= currentSpec) break;

    specs[newSpec] = lo;
    console.log(`  [found] spec=${newSpec} firstBlock=${lo}`);
    currentSpec = newSpec;
    pos = lo;
  }

  console.log(`  RPC calls: ~${rpcCalls}`);
  return specs;
}

function resolveChains(args) {
  const chainArg = args.find((a) => !a.startsWith("--"));
  if (!chainArg) return CHAINS;

  const key = chainArg.toLowerCase();
  const match = CHAINS.find((c) => c.aliases.includes(key));
  if (!match) {
    console.error(`Unknown chain: "${chainArg}". Available: polkadot, kusama, westend`);
    process.exit(1);
  }
  return [match];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const chains = resolveChains(args);

  const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));

  for (const chain of chains) {
    const entry = data[chain.key];
    if (!entry || !entry.endpoint) {
      console.log(`Skipping ${chain.key}: no endpoint in JSON`);
      continue;
    }

    console.log(`\n=== ${chain.key} ===`);
    console.log(`Endpoint: ${entry.endpoint}`);

    const api = await ApiPromise.create({
      provider: createProvider(entry.endpoint),
      throwOnUnknown: false,
    });

    const head = await api.rpc.chain.getHeader();
    const latest = Number(head.number.toString());
    console.log(`Head: #${latest}`);

    const specs = await discoverSpecs(api, latest);

    // Sort by block number for consistent output
    const sorted = Object.entries(specs)
      .map(([spec, block]) => [Number(spec), block])
      .sort((a, b) => a[1] - b[1]);

    const oldSpecs = entry.specs;
    const oldCount = Object.keys(oldSpecs).length;

    // Build new specs object (keys as strings to match JSON format)
    const newSpecs = {};
    for (const [spec, block] of sorted) {
      newSpecs[String(spec)] = block;
    }

    // Compare with existing
    let changed = false;
    const allKeys = new Set([...Object.keys(oldSpecs), ...Object.keys(newSpecs)]);
    for (const k of allKeys) {
      if (oldSpecs[k] === undefined) {
        console.log(`  [new]     spec=${k} block=${newSpecs[k]}`);
        changed = true;
      } else if (newSpecs[k] === undefined) {
        console.log(`  [removed] spec=${k} block=${oldSpecs[k]}`);
        changed = true;
      } else if (oldSpecs[k] !== newSpecs[k]) {
        console.log(`  [changed] spec=${k} block=${oldSpecs[k]} -> ${newSpecs[k]}`);
        changed = true;
      }
    }

    if (!changed) {
      console.log(`  No changes (${oldCount} specs)`);
    } else {
      console.log(`  Specs: ${oldCount} -> ${sorted.length}`);
    }

    entry.specs = newSpecs;
    await api.disconnect();
  }

  if (dryRun) {
    console.log("\n[dry-run] Not writing JSON file.");
  } else {
    const today = new Date().toISOString().slice(0, 10);
    data.description = `Asset Hub spec version → first block mappings. RPC-verified ${today}. Used by scan/debug scripts.`;
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + "\n");
    console.log(`\nUpdated ${JSON_PATH}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
