#!/usr/bin/env node

// Run under Podman on Linux. Capture once, then compare decoder versions on
// the same snapshot without an RPC connection. See doc/development/diagnostics.md for examples.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { dependencies, createRegistry, loadChainTypes } = require("../lib/decoder");
const { parseArgs } = require("node:util");
const specData = require("../data/asset-hub-spec-blocks.json");

const CHAINS = {
  polkadot: { spec: "statemint", bundle: "polkadotAssetHubChaintypes" },
  kusama: { spec: "statemine", bundle: "kusamaAssetHubChaintypes" },
  westend: { spec: "westmint", bundle: "westendAssetHubChaintypes" },
};

async function capture(endpoint, block, deps) {
  if (!/^https?:\/\//.test(endpoint)) throw new Error("Use an HTTP(S) endpoint in ASSET_HUB_ENDPOINT");
  let id = 0;
  async function rpc(method, params = []) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`${method}: ${result.error.message}`);
    return result.result;
  }

  const hash = typeof block === "number" ? await rpc("chain_getBlockHash", [block]) : block;
  if (!hash) throw new Error("Block not found");
  const raw = await rpc("chain_getBlock", [hash]);
  if (!raw) throw new Error("Block body not available");
  // Extrinsics were executed by the parent's runtime, including upgrade blocks.
  const parent = raw.block.header.parentHash;
  const runtimeVersion = await rpc("state_getRuntimeVersion", [parent]);
  const registry = new deps.TypeRegistry();
  let metadata;
  try {
    const bytes = await rpc("state_call", ["Metadata_metadata_at_version", "0x10000000", parent]);
    const opaque = registry.createType("Option<OpaqueMetadata>", registry.createType("Raw", bytes).toU8a());
    if (opaque.isSome) metadata = opaque.unwrap().toHex();
  } catch (error) {
    if (!/not found|not exported|not available|not supported|does not exist/i.test(error.message)) throw error;
  }
  metadata ||= await rpc("state_getMetadata", [parent]);
  const chain = await rpc("system_chain");
  return { formatVersion: 1, chain, hash, runtimeVersion, metadata, raw };
}

function inspect(snapshot, registry, label, index, showExtensions) {
  console.log(`\n${label}:`);
  const meta = registry.metadata.extrinsic;
  if (showExtensions) {
    for (const [version, indices] of meta.transactionExtensionsByVersion) {
      console.log(`  Extensions v${version}: ${indices.map((i) => meta.transactionExtensions[i.toNumber()].identifier).join(", ")}`);
    }
    for (const extension of meta.transactionExtensions) {
      console.log(`  ${extension.identifier}: ${registry.lookup.getTypeDef(extension.type).type}`);
    }
  }
  let ok = true;
  const extrinsics = [];
  const rows = snapshot.raw.block.extrinsics;
  if (index !== undefined && index >= rows.length) throw new Error(`Extrinsic index ${index} is outside this block`);
  for (let i = 0; i < rows.length; i++) {
    if (index !== undefined && index !== i) continue;
    const hex = rows[i];
    const result = { index: i, ok: false };
    try {
      const bytes = registry.createType("Raw", hex).toU8a();
      const length = registry.createType("Compact<u32>", bytes);
      result.preamble = bytes[length.encodedLength];
      const ex = registry.createType("Extrinsic", hex);
      if (ex.toHex() !== hex) throw new Error("Decoded extrinsic does not round-trip to the original bytes");
      if (!ex.hash.eq(registry.hash(bytes))) throw new Error("Decoded extrinsic hash differs from the original bytes");
      Object.assign(result, { ok: true, method: `${ex.method.section}.${ex.method.method}`,
        isSigned: ex.isSigned, signer: ex.isSigned ? ex.signer.toString() : null, hash: ex.hash.toHex() });
      console.log(`  #${i} preamble=0x${result.preamble.toString(16)} OK ${result.method} signed=${result.isSigned}${result.signer ? ` signer=${result.signer}` : ""}`);
      console.log(`    hash=${result.hash}`);
    } catch (error) {
      ok = false;
      result.error = error.message;
      console.log(`  #${i} FAIL ${result.error}`);
    }
    extrinsics.push(result);
  }
  return { label, ok, extrinsics };
}

function validateSnapshot(snapshot) {
  const hash = value => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
  const hex = value => typeof value === "string" && /^0x(?:[\da-f]{2})+$/i.test(value);
  if (snapshot?.formatVersion !== 1 || typeof snapshot.chain !== "string" || !hash(snapshot.hash) ||
      !hash(snapshot.raw?.block?.header?.parentHash) || !/^0x[\da-f]+$/i.test(snapshot.raw?.block?.header?.number) ||
      !Number.isSafeInteger(Number(snapshot.raw.block.header.number)) || !hex(snapshot.metadata) ||
      !Array.isArray(snapshot.raw.block.extrinsics) || !snapshot.raw.block.extrinsics.every(hex) ||
      typeof snapshot.runtimeVersion?.specName !== "string" || !Number.isSafeInteger(snapshot.runtimeVersion.specVersion)) {
    throw new Error("Invalid raw-block snapshot (expected formatVersion=1, block, parent runtime and metadata)");
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      block: { type: "string" }, hash: { type: "string" }, snapshot: { type: "string" },
      save: { type: "string" }, report: { type: "string" }, "api-root": { type: "string" },
      "known-types-root": { type: "string" },
      "project-root": { type: "string", default: process.env.PROJECT_ROOT || path.resolve(__dirname, "../..") },
      extrinsic: { type: "string" }, compare: { type: "boolean" },
      "no-types": { type: "boolean" }, sandbox: { type: "boolean" },
      extensions: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: node scripts/diagnostics/debug-asset-hub-block.js <polkadot|kusama|westend> (--block=N | --hash=0x... | --snapshot=FILE)");
    console.log("  --save=FILE          Save raw block and parent metadata (no endpoint or credentials)");
    console.log("  --compare            Show stock decoder before project decoder; exit verdict uses project");
    console.log("  --no-types           Use only stock decoder, e.g. with --api-root=/probe for a candidate upgrade");
    console.log("  --known-types-root=DIR  Change only @polkadot/types-known, keeping the selected decoder");
    console.log("  --report=FILE        Save versions, input fingerprints and decode results as JSON (no overwrite)");
    console.log("  --sandbox            Load built chain types through the SubQuery VM (SUBQL_ROOT defaults to /)");
    console.log("  --project-root=DIR   Built project directory (default: repository root)");
    console.log("  --extrinsic=N        Inspect only this index (default: every extrinsic)");
    console.log("  --extensions         Print metadata extension pipelines and their SCALE types");
    console.log("  ASSET_HUB_ENDPOINT   HTTP(S) RPC override; pass private URLs via a Podman env-file");
    return;
  }
  const name = Object.keys(CHAINS).find((key) => key === positionals[0] || CHAINS[key].spec === positionals[0]);
  if (!name || positionals.length !== 1) throw new Error("Specify one Asset Hub chain; see --help");
  if ([values.block, values.hash, values.snapshot].filter((v) => v !== undefined).length !== 1) {
    throw new Error("Specify exactly one of --block, --hash or --snapshot");
  }
  if (values.compare && values["no-types"]) throw new Error("--compare and --no-types are mutually exclusive");
  for (const key of ["hash", "snapshot", "save", "report", "api-root", "known-types-root", "project-root"]) {
    if (values[key] !== undefined && values[key].trim() === "") throw new Error(`--${key} cannot be empty`);
  }
  if (values.hash && !/^0x[\da-f]{64}$/i.test(values.hash)) throw new Error("Invalid block hash");
  for (const key of ["block", "extrinsic"]) {
    if (values[key] !== undefined && (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])))) {
      throw new Error(`--${key} must be a non-negative integer`);
    }
  }
  const deps = dependencies(values["api-root"], values["known-types-root"]);
  const packages = {};
  for (const name of ["@polkadot/api", "@polkadot/types", "@polkadot/types-known"]) {
    const from = name === "@polkadot/types-known" ? deps.knownFrom : deps.from;
    packages[name] = { version: from(`${name}/packageInfo`).packageInfo.version, path: from.resolve(name) };
    console.log(`${name} ${packages[name].version} (${packages[name].path})`);
  }
  const config = CHAINS[name];
  const endpoint = process.env.ASSET_HUB_ENDPOINT || specData[config.spec].endpoint.replace(/^ws/, "http");
  const snapshot = values.snapshot
    ? JSON.parse(fs.readFileSync(values.snapshot, "utf8"))
    : await capture(endpoint, values.hash || Number(values.block), deps);
  validateSnapshot(snapshot);
  if (snapshot.runtimeVersion.specName !== config.spec) throw new Error("Snapshot/RPC runtime does not match the selected chain");
  if (values.save) fs.writeFileSync(values.save, JSON.stringify(snapshot) + "\n", { mode: 0o600, flag: "wx" });
  const height = Number.parseInt(snapshot.raw.block.header.number, 16);
  const metadataVersion = new deps.Metadata(new deps.TypeRegistry(), snapshot.metadata).version;
  console.log(`${snapshot.chain} block=${height} hash=${snapshot.hash} spec=${snapshot.runtimeVersion.specVersion} metadata=v${metadataVersion}`);
  const sha256 = value => createHash("sha256").update(Buffer.from(value.slice(2), "hex")).digest("hex");
  const report = { formatVersion: 1, packages, blockHash: snapshot.hash, height,
    runtimeVersion: snapshot.runtimeVersion, metadataVersion, metadataSha256: sha256(snapshot.metadata),
    extrinsicSha256: snapshot.raw.block.extrinsics.map(sha256), decoders: [] };
  const index = values.extrinsic === undefined ? undefined : Number(values.extrinsic);
  if (values.compare) report.decoders.push(inspect(snapshot, createRegistry(snapshot, {}, deps), "Stock decoder", index, values.extensions));
  const types = values["no-types"] ? {} : loadChainTypes(values["project-root"], config.bundle, values.sandbox);
  const result = inspect(snapshot, createRegistry(snapshot, types, deps), values["no-types"] ? "Stock decoder" : "Project decoder", index, values.extensions);
  report.decoders.push(result);
  if (values.report) fs.writeFileSync(values.report, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { capture, inspect, validateSnapshot };

if (require.main === module) {
  main().catch((error) => {
    const endpoint = process.env.ASSET_HUB_ENDPOINT;
    console.error(endpoint ? error.message.split(endpoint).join("[RPC]") : error.message);
    process.exitCode = 2;
  });
}
