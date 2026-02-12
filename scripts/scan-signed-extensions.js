#!/usr/bin/env node
//
// Scan ChargeAssetTxPayment signed extension types across all spec versions
// for an Asset Hub chain. Uses pre-built spec→block mappings from
// scripts/asset-hub-spec-blocks.json (no slow binary search needed).
//
// Usage:
//   node scripts/scan-signed-extensions.js <chain>
//
// Where <chain> is one of: statemint, statemine, westmint
// (or a unique prefix like "pol", "kus", "wes").
//
// You can also pass an explicit endpoint to override the default:
//   node scripts/scan-signed-extensions.js statemint wss://my-custom-rpc.example.com
//
// Examples:
//   node scripts/scan-signed-extensions.js statemint
//   node scripts/scan-signed-extensions.js statemine
//   node scripts/scan-signed-extensions.js westmint

const { ApiPromise, WsProvider, HttpProvider } = require("@polkadot/api");
const specData = require("./asset-hub-spec-blocks.json");

const CHAIN_ALIASES = {
  statemint: "statemint",
  polkadot: "statemint",
  pol: "statemint",
  statemine: "statemine",
  kusama: "statemine",
  kus: "statemine",
  westmint: "westmint",
  westend: "westmint",
  wes: "westmint",
};

function usage() {
  console.error(
    "Usage: node scripts/scan-signed-extensions.js <chain> [endpoint]"
  );
  console.error("  chain: statemint | statemine | westmint (or alias: polkadot, kusama, westend)");
  console.error(
    "\nExample: node scripts/scan-signed-extensions.js statemint"
  );
  process.exit(1);
}

function resolveType(types, typeId, depth = 0) {
  if (depth > 5) return "...";
  const t = types.find((t) => t.id === typeId);
  if (!t) return `type#${typeId}`;

  const def = t.type.def;
  const path = (t.type.path || []).join("::");

  if (def.primitive) return def.primitive;
  if (def.compact)
    return `Compact<${resolveType(types, def.compact.type, depth + 1)}>`;

  if (def.variant) {
    const variants = def.variant.variants;
    const none = variants.find((v) => v.name === "None");
    const some = variants.find((v) => v.name === "Some");
    if (none && some && variants.length === 2 && some.fields.length === 1) {
      return `Option<${resolveType(types, some.fields[0].type, depth + 1)}>`;
    }
    return path || `Variant(${variants.map((v) => v.name).join("|")})`;
  }

  if (def.composite) {
    if (path) return path;
    const fields = def.composite.fields;
    return `{${fields.map((f) => `${f.name}: ${resolveType(types, f.type, depth + 1)}`).join(", ")}}`;
  }

  if (def.sequence)
    return `Vec<${resolveType(types, def.sequence.type, depth + 1)}>`;
  if (def.array)
    return `[${resolveType(types, def.array.type, depth + 1)}; ${def.array.len}]`;
  if (def.tuple)
    return `(${def.tuple.map((id) => resolveType(types, id, depth + 1)).join(", ")})`;

  return path || JSON.stringify(def).slice(0, 80);
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const chainKey = CHAIN_ALIASES[args[0].toLowerCase()];
  if (!chainKey || !specData[chainKey]) {
    console.error(`Unknown chain: "${args[0]}". Use: statemint, statemine, or westmint`);
    usage();
  }

  const chain = specData[chainKey];
  const endpoint = args[1] || chain.endpoint;
  const specs = chain.specs;
  const specEntries = Object.entries(specs)
    .map(([spec, block]) => [parseInt(spec), block])
    .sort((a, b) => a[1] - b[1]);

  console.log(`Chain: ${chainKey} (${endpoint})`);
  console.log(`Spec eras: ${specEntries.length}\n`);

  const provider = endpoint.startsWith("ws")
    ? new WsProvider(endpoint)
    : new HttpProvider(endpoint);
  const api = await ApiPromise.create({ provider, throwOnUnknown: false });

  console.log(
    "Spec".padEnd(12) +
      "Block".padEnd(12) +
      "asset_id type".padEnd(55) +
      "Pallet"
  );
  console.log("-".repeat(120));

  for (const [spec, block] of specEntries) {
    try {
      const hash = await api.rpc.chain.getBlockHash(block);
      const metaRaw = await api.rpc.state.getMetadata(hash);
      const json = metaRaw.toJSON();
      const meta = json.metadata.v14 || json.metadata.v15;

      if (!meta) {
        console.log(
          String(spec).padEnd(12) +
            String(block).padEnd(12) +
            "(metadata not v14/v15)"
        );
        continue;
      }

      const types = meta.lookup.types;
      const exts = meta.extrinsic.signedExtensions;
      const charge = exts.find(
        (e) => e.identifier === "ChargeAssetTxPayment"
      );

      if (!charge) {
        console.log(
          String(spec).padEnd(12) +
            String(block).padEnd(12) +
            "(no ChargeAssetTxPayment)"
        );
        continue;
      }

      const chargeType = types.find((t) => t.id === charge.type);
      const palletPath = (chargeType?.type?.path || []).join("::");
      const fields = chargeType?.type?.def?.composite?.fields || [];
      const assetField = fields.find((f) => f.name === "asset_id");

      if (!assetField) {
        console.log(
          String(spec).padEnd(12) +
            String(block).padEnd(12) +
            "(no asset_id field)"
        );
        continue;
      }

      const resolved = resolveType(types, assetField.type);
      console.log(
        String(spec).padEnd(12) +
          String(block).padEnd(12) +
          resolved.padEnd(55) +
          palletPath
      );
    } catch (e) {
      console.log(
        String(spec).padEnd(12) +
          String(block).padEnd(12) +
          `ERROR: ${e.message.slice(0, 80)}`
      );
    }
  }

  await api.disconnect();
})().catch((e) => {
  console.error(e.message.slice(0, 300));
  process.exit(1);
});
