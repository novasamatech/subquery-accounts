#!/usr/bin/env node

// Targeted scan for specific extrinsic kinds across all spec ranges.
// Verifies decode + method parsing for calls you care about in every spec era.
//
// Uses spec→block mappings from scripts/asset-hub-spec-blocks.json.
//
// Usage:
//   node scripts/scan-methods-by-spec.js <chain> [--targets=section.method,...]
//
// Where <chain> is: polkadot | kusama | westend (or statemint | statemine | westmint)
//
// Examples:
//   node scripts/scan-methods-by-spec.js polkadot
//   node scripts/scan-methods-by-spec.js kusama --targets=multisig.asMulti,proxy.proxy

const { ApiPromise, WsProvider, HttpProvider } = require("@polkadot/api");
const specData = require("./asset-hub-spec-blocks.json");

const CHAIN_MAP = {
  polkadot: "statemint",
  statemint: "statemint",
  kusama: "statemine",
  statemine: "statemine",
  westend: "westmint",
  westmint: "westmint",
};

const DEFAULT_TARGETS = [
  { section: "multisig", method: "asMulti" },
  { section: "proxy", method: "proxy" },
  { section: "assets", method: "transferKeepAlive" },
];

const MAX_BLOCKS_PER_ERA = 20000;
const MAX_HITS_PER_TARGET = 3;

function usage() {
  console.error("Usage: node scripts/scan-methods-by-spec.js <chain> [--targets=section.method,...]");
  console.error("  chain: polkadot | kusama | westend");
  process.exit(1);
}

function createProvider(endpoint) {
  return endpoint.startsWith("ws") ? new WsProvider(endpoint) : new HttpProvider(endpoint);
}

function buildEras(specs) {
  const entries = Object.entries(specs)
    .map(([spec, block]) => [parseInt(spec), block])
    .sort((a, b) => a[1] - b[1]);

  const eras = [];
  for (let i = 0; i < entries.length; i++) {
    const [spec, start] = entries[i];
    const end = i + 1 < entries.length ? entries[i + 1][1] - 1 : start + 100000;
    eras.push({ spec, start, end });
  }
  return eras;
}

function parseTargets(args) {
  const targetsArg = args.find((a) => a.startsWith("--targets="));
  if (!targetsArg) return DEFAULT_TARGETS;
  return targetsArg
    .slice(10)
    .split(",")
    .map((t) => {
      const [section, method] = t.trim().split(".");
      return { section, method };
    });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const chainArg = args[0].toLowerCase();
  const chainKey = CHAIN_MAP[chainArg];
  if (!chainKey) {
    console.error(`Unknown chain: "${args[0]}". Available: ${Object.keys(CHAIN_MAP).join(", ")}`);
    usage();
  }

  const chain = specData[chainKey];
  const endpoint = chain.endpoint;
  const eras = buildEras(chain.specs);
  const targets = parseTargets(args);

  console.log(`Chain: ${chainArg} (${chainKey})`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Targets: ${targets.map((t) => `${t.section}.${t.method}`).join(", ")}`);
  console.log(`Spec eras: ${eras.length}\n`);

  const api = await ApiPromise.create({ provider: createProvider(endpoint), throwOnUnknown: false });

  for (const era of eras) {
    const hits = Object.fromEntries(targets.map((t) => [`${t.section}.${t.method}`, 0]));
    const limit = Math.min(era.start + MAX_BLOCKS_PER_ERA, era.end);
    let allDone = false;

    for (let h = era.start; h <= limit && !allDone; h++) {
      let block;
      try {
        const hash = await api.rpc.chain.getBlockHash(h);
        block = await api.rpc.chain.getBlock(hash);
      } catch (e) {
        console.log(`[spec=${era.spec}] block=${h} DECODE_ERR: ${String(e.message).slice(0, 150)}`);
        continue;
      }

      for (const ex of block.block.extrinsics) {
        const key = `${ex.method.section}.${ex.method.method}`;
        if (hits[key] !== undefined && hits[key] < MAX_HITS_PER_TARGET) {
          hits[key]++;
          const signed = ex.isSigned ? "signed" : "unsigned";
          console.log(`[spec=${era.spec}] block=${h} ${key} (${signed})`);

          if (ex.isSigned) {
            try {
              void ex.signature?.toU8a();
              console.log(`  signedExtensions: OK`);
            } catch (e) {
              console.log(`  signedExtensions: ERR ${String(e.message).slice(0, 150)}`);
            }
          }
        }
      }

      allDone = Object.values(hits).every((c) => c >= MAX_HITS_PER_TARGET);
    }

    console.log(`[spec=${era.spec}] summary: ${JSON.stringify(hits)}`);
  }

  await api.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
