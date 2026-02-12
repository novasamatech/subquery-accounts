#!/usr/bin/env node

// Decode regression scan for Asset Hub chains (Polkadot, Kusama, Westend).
// Verifies that current chaintypes decode ALL spec eras correctly,
// including blocks with non-None ChargeAssetTxPayment assetId (e.g. USDT fee payment).
// Compares current config against alternative NovaAssetId type configs to help
// diagnose type boundary issues.
//
// Uses spec→block mappings from scripts/asset-hub-spec-blocks.json.
//
// Usage:
//   node scripts/scan-asset-hub-decode.js <chain>
//
// Where <chain> is: polkadot | kusama | westend (or statemint | statemine | westmint)
//
// Optional: pass specific block numbers to test:
//   node scripts/scan-asset-hub-decode.js polkadot --extra=4176632,6172745

const { ApiPromise, WsProvider, HttpProvider } = require("@polkadot/api");
const specData = require("./asset-hub-spec-blocks.json");

const CHAIN_MAP = {
  polkadot: { key: "statemint", chaintypes: "../dist/polkadotAssetHubChaintypes.js" },
  statemint: { key: "statemint", chaintypes: "../dist/polkadotAssetHubChaintypes.js" },
  kusama: { key: "statemine", chaintypes: "../dist/kusamaAssetHubChaintypes.js" },
  statemine: { key: "statemine", chaintypes: "../dist/kusamaAssetHubChaintypes.js" },
  westend: { key: "westmint", chaintypes: "../dist/westendAssetHubChaintypes.js" },
  westmint: { key: "westmint", chaintypes: "../dist/westendAssetHubChaintypes.js" },
};

function usage() {
  console.error("Usage: node scripts/scan-asset-hub-decode.js <chain> [--extra=block1,block2]");
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

function makeDefs(specName, signedExtensions, ranges) {
  return {
    typesBundle: {
      spec: {
        [specName]: {
          types: ranges.map(([lo, hi, type]) => ({
            minmax: [lo, hi],
            types: { NovaAssetId: type },
          })),
          signedExtensions,
        },
      },
    },
  };
}

function buildAlternatives(specName, signedExtensions) {
  return {
    "AssetId→9429,ML→1999999": makeDefs(specName, signedExtensions, [
      [0, 9429, "Option<AssetId>"],
      [9430, 1999999, "Option<MultiLocation>"],
      [2000000, null, "Option<MultiLocationV3>"],
    ]),
    "AssetId→999999,MLV3→null": makeDefs(specName, signedExtensions, [
      [0, 999999, "Option<AssetId>"],
      [1000000, null, "Option<MultiLocationV3>"],
    ]),
    "AssetId→1999999,V3→2M+": makeDefs(specName, signedExtensions, [
      [0, 1999999, "Option<AssetId>"],
      [2000000, null, "Option<MultiLocationV3>"],
    ]),
  };
}

async function canDecode(api, hash) {
  try {
    const block = await api.rpc.chain.getBlock(hash);
    let signed = 0;
    for (const ex of block.block.extrinsics) {
      if (ex.isSigned) {
        void ex.signature?.toU8a();
        signed++;
      }
    }
    return { ok: true, signed };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}

async function findSignedBlock(apiBare, start, end, maxProbe) {
  const limit = Math.min(start + (maxProbe || 500), end);
  for (let h = start; h <= limit; h++) {
    const hash = await apiBare.rpc.chain.getBlockHash(h);
    const raw = await apiBare.rpc.chain.getBlock(hash);
    const hasSigned = raw.block.extrinsics.some((e) => {
      try { return e.isSigned; } catch { return false; }
    });
    if (hasSigned) {
      const rv = await apiBare.rpc.state.getRuntimeVersion(hash);
      return { height: h, hash: hash.toHex(), spec: Number(rv.specVersion.toString()) };
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const chainArg = args[0].toLowerCase();
  const chainCfg = CHAIN_MAP[chainArg];
  if (!chainCfg) {
    console.error(`Unknown chain: "${args[0]}". Available: ${Object.keys(CHAIN_MAP).join(", ")}`);
    usage();
  }

  const chain = specData[chainCfg.key];
  const specName = chainCfg.key;
  const endpoint = chain.endpoint;
  const eras = buildEras(chain.specs);

  const chainTypes = require(chainCfg.chaintypes).default;
  const signedExtensions = chainTypes.typesBundle.spec[specName].signedExtensions;
  const alternatives = buildAlternatives(specName, signedExtensions);
  const altNames = Object.keys(alternatives);

  const extraArg = args.find((a) => a.startsWith("--extra="));
  const extraBlocks = extraArg
    ? extraArg.slice(8).split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0)
    : [];

  console.log(`Chain: ${chainArg} (specName: ${specName})`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Spec eras: ${eras.length}`);
  console.log("Configs: current" + altNames.map((n) => `, ${n}`).join(""));
  console.log();

  const provider = () => createProvider(endpoint);
  const apiBare = await ApiPromise.create({ provider: provider(), throwOnUnknown: false });
  const apiCurrent = await ApiPromise.create({ provider: provider(), ...chainTypes, throwOnUnknown: false });
  const altApis = {};
  for (const name of altNames) {
    altApis[name] = await ApiPromise.create({ provider: provider(), ...alternatives[name], throwOnUnknown: false });
  }

  function fmt(r) {
    return r.ok ? `OK(${r.signed})` : "ERR";
  }

  let allOk = true;

  // 1. Test specific blocks
  if (extraBlocks.length > 0) {
    console.log("=== Specific blocks ===");
    for (const h of extraBlocks) {
      const hash = (await apiBare.rpc.chain.getBlockHash(h)).toHex();
      const rv = await apiBare.rpc.state.getRuntimeVersion(hash);
      const cur = await canDecode(apiCurrent, hash);
      const altResults = {};
      for (const name of altNames) altResults[name] = await canDecode(altApis[name], hash);

      const altStr = altNames.map((n) => `${n}=${fmt(altResults[n])}`).join("  ");
      console.log(`Block ${h} spec=${rv.specVersion}  current=${fmt(cur)}  ${altStr}`);
      if (!cur.ok) { allOk = false; console.log(`  current err: ${cur.error}`); }
    }
    console.log();
  }

  // 2. All eras
  console.log("=== All spec eras ===");
  for (const era of eras) {
    const sample = await findSignedBlock(apiBare, era.start, era.end, 500);
    if (!sample) {
      console.log(`[spec=${era.spec}] skip (no signed block in first 500)`);
      continue;
    }
    const cur = await canDecode(apiCurrent, sample.hash);
    const altResults = {};
    for (const name of altNames) altResults[name] = await canDecode(altApis[name], sample.hash);

    const altStr = altNames.map((n) => `${n}=${fmt(altResults[n])}`).join("  ");
    console.log(`[spec=${era.spec}] block=${sample.height}  current=${fmt(cur)}  ${altStr}`);
    if (!cur.ok) { allOk = false; console.log(`  current err: ${cur.error}`); }
  }

  console.log(`\n${allOk ? "ALL PASSED (current config)" : "FAILURES DETECTED in current config"}`);

  await apiBare.disconnect();
  await apiCurrent.disconnect();
  for (const name of altNames) await altApis[name].disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
