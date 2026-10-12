#!/usr/bin/env node

// Run under Podman on Linux. Capture once, then compare decoder versions on
// the same snapshot without an RPC connection. See doc/development/diagnostics.md for examples.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { dependencies, createRegistry, loadChainTypes } = require("../lib/decoder");
const { createIndexerFixture, createMetadataFixture } = require("../lib/metadata-fixture");
const { createRpc, fetchMetadata } = require("../lib/rpc");
const { verifyExtrinsic } = require("../lib/general-extrinsic");
const { readManifest } = require("../lib/manifests");
const { parseArgs } = require("node:util");
const specData = require("../data/asset-hub-spec-blocks.json");

// Asset Hub aliases read endpoints from the shared spec map. Any network can instead be
// selected by its manifest (project-<slug>.yaml): endpoint, chain types and genesis from YAML.
const CHAINS = {
  polkadot: { spec: "statemint", bundle: "polkadotAssetHubChaintypes" },
  kusama: { spec: "statemine", bundle: "kusamaAssetHubChaintypes" },
  westend: { spec: "westmint", bundle: "westendAssetHubChaintypes" },
};

function resolveTarget(name) {
  const manifest = /^project-([a-z0-9-]+)\.yaml$/.exec(name ?? "");
  if (manifest) return readManifest(manifest[1]);
  const alias = Object.keys(CHAINS).find((key) => key === name || CHAINS[key].spec === name);
  if (!alias) throw new Error(`Specify one Asset Hub alias (${Object.keys(CHAINS).join(", ")}) or project-<slug>.yaml; see --help`);
  return { ...CHAINS[alias], endpoint: specData[CHAINS[alias].spec].endpoint.replace(/^ws/, "http") };
}

async function capture(endpoint, block, deps, { events = false } = {}) {
  const rpc = createRpc(endpoint);
  const hash = block === "finalized" ? await rpc("chain_getFinalizedHead")
    : typeof block === "number" ? await rpc("chain_getBlockHash", [block]) : block;
  if (!hash) throw new Error("Block not found");
  const raw = await rpc("chain_getBlock", [hash]);
  if (!raw) throw new Error("Block body not available");
  // Extrinsics were executed by the parent's runtime, including upgrade blocks.
  const parent = raw.block.header.parentHash;
  const runtimeVersion = await rpc("state_getRuntimeVersion", [parent]);
  const metadata = await fetchMetadata(rpc, parent, deps);
  const chain = await rpc("system_chain");
  const genesisHash = await rpc("chain_getBlockHash", [0]);
  const snapshot = { formatVersion: 1, chain, genesisHash, hash, runtimeVersion, metadata, raw };
  if (events) {
    const { xxhashAsHex } = deps.from("@polkadot/util-crypto");
    const key = xxhashAsHex("System", 128) + xxhashAsHex("Events", 128).slice(2);
    snapshot.events = await rpc("state_getStorage", [key, hash]);
    if (!snapshot.events) throw new Error("Block events not available");
  }
  return snapshot;
}

function inspect(snapshot, registry, label, { index, extensions = false, calls = false, events = false } = {}) {
  console.log(`\n${label}:`);
  const meta = registry.metadata.extrinsic;
  if (extensions) {
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
    const bytes = registry.createType("Raw", rows[i]).toU8a();
    const { ex, ...checked } = verifyExtrinsic(registry, bytes);
    const result = { index: i, preamble: bytes[registry.createType("Compact<u32>", bytes).encodedLength], ...checked };
    if (result.ok) {
      console.log(`  #${i} preamble=0x${result.preamble.toString(16)} OK ${result.method} signed=${result.isSigned}${result.signer ? ` signer=${result.signer}` : ""}`);
      console.log(`    hash=${result.hash}`);
      if (calls) console.log(`    call=${JSON.stringify(ex.method.toHuman())}`);
    } else {
      ok = false;
      console.log(`  #${i} FAIL ${result.error}`);
    }
    extrinsics.push(result);
  }
  if (events) {
    if (!snapshot.events) throw new Error("Snapshot has no events; capture again with --events");
    const records = registry.createType("Vec<EventRecord>", snapshot.events);
    records.forEach((record, eventIndex) => {
      const extrinsicIndex = record.phase.isApplyExtrinsic ? record.phase.asApplyExtrinsic.toNumber() : null;
      if (index !== undefined && index !== extrinsicIndex) return;
      console.log(`  Event #${eventIndex} extrinsic=${extrinsicIndex} ${record.event.section}.${record.event.method} ${JSON.stringify(record.event.data.toHuman())}`);
    });
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
      typeof snapshot.runtimeVersion?.specName !== "string" || !Number.isSafeInteger(snapshot.runtimeVersion.specVersion) ||
      (snapshot.events !== undefined && !hex(snapshot.events)) ||
      (snapshot.genesisHash !== undefined && !hash(snapshot.genesisHash))) {
    throw new Error("Invalid raw-block snapshot (expected formatVersion=1, block, parent runtime and metadata)");
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      block: { type: "string" }, hash: { type: "string" }, snapshot: { type: "string" },
      save: { type: "string" }, report: { type: "string" }, fixture: { type: "string" }, "api-root": { type: "string" },
      "metadata-fixture": { type: "string" },
      "known-types-root": { type: "string" },
      "project-root": { type: "string", default: process.env.PROJECT_ROOT || path.resolve(__dirname, "../..") },
      extrinsic: { type: "string" }, compare: { type: "boolean" },
      "no-types": { type: "boolean" }, sandbox: { type: "boolean" }, finalized: { type: "boolean" },
      extensions: { type: "boolean" }, calls: { type: "boolean" }, events: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: node scripts/diagnostics/debug-asset-hub-block.js <polkadot|kusama|westend|project-<slug>.yaml> (--block=N | --hash=0x... | --finalized | --snapshot=FILE)");
    console.log("  polkadot|kusama|westend  Asset Hub aliases; any network by manifest, e.g. project-polkadot-people-chain.yaml");
    console.log("  --finalized          Capture the current finalized block, e.g. for a --metadata-fixture");
    console.log("  --save=FILE          Save raw block and parent metadata (no endpoint or credentials)");
    console.log("  --compare            Show stock decoder before project decoder; exit verdict uses project");
    console.log("  --no-types           Use only stock decoder, e.g. with --api-root=/probe for a candidate upgrade");
    console.log("  --known-types-root=DIR  Change only @polkadot/types-known, keeping the selected decoder");
    console.log("  --report=FILE        Save versions, input fingerprints and decode results as JSON (no overwrite)");
    console.log("  --fixture=FILE       Reduce v16 metadata to indexer calls/events; requires --extrinsic=N (no overwrite)");
    console.log("  --metadata-fixture=FILE  Export real reduced metadata without requiring a target transaction");
    console.log("  --sandbox            Load built chain types through the SubQuery VM (SUBQL_ROOT defaults to /)");
    console.log("  --project-root=DIR   Built project directory (default: repository root)");
    console.log("  --extrinsic=N        Inspect only this index (default: every extrinsic)");
    console.log("  --extensions         Print metadata extension pipelines and their SCALE types");
    console.log("  --calls              Print decoded call arguments, including nested calls");
    console.log("  --events             Capture/print raw block events (also included in --save and --fixture)");
    console.log("  RPC_ENDPOINT_OVERRIDE  HTTP(S) RPC override (legacy name: ASSET_HUB_ENDPOINT); pass private URLs via a Podman env-file");
    return;
  }
  if (positionals.length !== 1) throw new Error("Specify one Asset Hub alias or project-<slug>.yaml; see --help");
  const config = resolveTarget(positionals[0]);
  if ([values.block, values.hash, values.snapshot, values.finalized].filter((v) => v !== undefined).length !== 1) {
    throw new Error("Specify exactly one of --block, --hash, --finalized or --snapshot");
  }
  if (values.compare && values["no-types"]) throw new Error("--compare and --no-types are mutually exclusive");
  if (values.fixture && values.extrinsic === undefined) throw new Error("--fixture requires --extrinsic=N");
  for (const key of ["hash", "snapshot", "save", "report", "fixture", "metadata-fixture", "api-root", "known-types-root", "project-root"]) {
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
  const endpoint = overrideEndpoint() || config.endpoint;
  const snapshot = values.snapshot
    ? JSON.parse(fs.readFileSync(values.snapshot, "utf8"))
    : await capture(endpoint, values.finalized ? "finalized" : values.hash || Number(values.block), deps, { events: values.events });
  validateSnapshot(snapshot);
  if (values.events && !snapshot.events) throw new Error("Snapshot has no events; capture again with --events");
  if (config.spec && snapshot.runtimeVersion.specName !== config.spec) throw new Error("Snapshot/RPC runtime does not match the selected chain");
  if (config.chainId && snapshot.genesisHash !== config.chainId) {
    throw new Error("Snapshot/RPC genesis does not match the manifest chainId (older snapshots lack it; capture again)");
  }
  if (values.save) fs.writeFileSync(values.save, JSON.stringify(snapshot) + "\n", { mode: 0o600, flag: "wx" });
  if (values.fixture) fs.writeFileSync(values.fixture, JSON.stringify(createIndexerFixture(snapshot, Number(values.extrinsic), deps), null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (values["metadata-fixture"]) fs.writeFileSync(values["metadata-fixture"], JSON.stringify(createMetadataFixture(snapshot, deps), null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const height = Number.parseInt(snapshot.raw.block.header.number, 16);
  const metadataVersion = new deps.Metadata(new deps.TypeRegistry(), snapshot.metadata).version;
  console.log(`${snapshot.chain} block=${height} hash=${snapshot.hash} spec=${snapshot.runtimeVersion.specVersion} metadata=v${metadataVersion}`);
  const sha256 = value => createHash("sha256").update(Buffer.from(value.slice(2), "hex")).digest("hex");
  const report = { formatVersion: 1, packages, blockHash: snapshot.hash, height,
    runtimeVersion: snapshot.runtimeVersion, metadataVersion, metadataSha256: sha256(snapshot.metadata),
    extrinsicSha256: snapshot.raw.block.extrinsics.map(sha256), decoders: [] };
  const index = values.extrinsic === undefined ? undefined : Number(values.extrinsic);
  const options = { index, extensions: values.extensions, calls: values.calls, events: values.events };
  if (values.compare) report.decoders.push(inspect(snapshot, createRegistry(snapshot, {}, deps), "Stock decoder", options));
  const types = values["no-types"] || !config.bundle ? {} : loadChainTypes(values["project-root"], config.bundle, values.sandbox);
  const label = values["no-types"] ? "Stock decoder" : "Project decoder";
  const result = inspect(snapshot, createRegistry(snapshot, types, deps), label, options);
  report.decoders.push(result);
  if (values.compare) {
    // Whatever the stock codec decodes correctly must be unchanged: the project only adds General-v5.
    for (const before of report.decoders[0].extrinsics.filter(row => row.ok)) {
      const after = result.extrinsics.find(row => row.index === before.index);
      if (after.ok && ["method", "isSigned", "signer", "hash"].every(key => before[key] === after[key])) continue;
      console.log(`  #${before.index} MISMATCH stock and project decoders disagree`);
      result.ok = false;
    }
  }
  if (values.report) fs.writeFileSync(values.report, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.exitCode = result.ok ? 0 : 1;
}

// The same variable as the scanner and full replay; the Asset Hub name is kept for existing env-files.
function overrideEndpoint() {
  return process.env.RPC_ENDPOINT_OVERRIDE || process.env.ASSET_HUB_ENDPOINT;
}

module.exports = { capture, inspect, validateSnapshot };

if (require.main === module) {
  main().catch((error) => {
    const endpoint = overrideEndpoint();
    console.error(endpoint ? error.message.split(endpoint).join("[RPC]") : error.message);
    process.exitCode = 2;
  });
}
