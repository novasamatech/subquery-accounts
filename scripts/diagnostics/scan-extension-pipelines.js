#!/usr/bin/env node

// Which indexed networks advertise General-v5 transaction-extension pipelines, and does each
// manifest's configured decoder round-trip a transaction for every pipeline? Uses the current
// finalized runtime of each manifest's RPC. See doc/development/diagnostics.md.
const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { dependencies, createRegistry, loadChainTypes } = require("../lib/decoder");
const { createRpc, fetchMetadata } = require("../lib/rpc");
const { encodeGeneral, pipelines, verifyExtrinsic } = require("../lib/general-extrinsic");
const { REPO_ROOT, manifestSlugs, readManifest } = require("../lib/manifests");

const ACCOUNT = "0x" + "aa".repeat(32);
const SIGNATURE = "0x" + "11".repeat(64);
const ERROR_PREVIEW_CHARS = 160;

// Synthetic remark for each pipeline: a signed one where VerifyMultiSignature exists.
function probe(stock, project, pipeline) {
  const signed = pipeline.extensions.includes("VerifyMultiSignature");
  if (signed && stock.registry.createType("AccountId").encodedLength !== 32) {
    throw new Error("Signed VerifyMultiSignature probes require AccountId32; this runtime uses a different account width. Review its authorization before modeling a signed probe.");
  }
  const call = stock.remark("0x01020304");
  const values = signed ? { VerifyMultiSignature: { Signed: { account: ACCOUNT, signature: { Sr25519: SIGNATURE } } } } : {};
  const bytes = encodeGeneral(stock.registry, pipeline.version, values, call);
  const result = { version: pipeline.version, signed, extensions: pipeline.extensions };
  for (const [label, registry] of [["stock", stock.registry], ["project", project]]) {
    if (!registry) continue;
    const checked = summary(verifyExtrinsic(registry, bytes));
    const expected = signed ? registry.createType("AccountId", ACCOUNT).toString() : null;
    if (checked.ok && (checked.isSigned !== signed || checked.signer !== expected)) {
      Object.assign(checked, { ok: false, error: `Wrong origin: signed=${checked.isSigned} signer=${checked.signer}` });
    }
    result[label] = checked;
  }
  return result;
}

function summary({ ex, ...result }) {
  return result;
}

async function scan(slug, { deps, projectRoot, sandbox, noTypes, endpoint: override }) {
  const { endpoint, bundle, chainId } = readManifest(slug);
  const rpc = createRpc(override || endpoint);
  if ((await rpc("chain_getBlockHash", [0])) !== chainId) throw new Error("RPC genesis differs from the manifest chainId");
  const hash = await rpc("chain_getFinalizedHead");
  const runtimeVersion = await rpc("state_getRuntimeVersion", [hash]);
  const snapshot = { chain: await rpc("system_chain"), runtimeVersion, metadata: await fetchMetadata(rpc, hash, deps) };
  const registry = createRegistry(snapshot, {}, deps);
  const metadataVersion = new deps.Metadata(new deps.TypeRegistry(), snapshot.metadata).version;
  const result = { manifest: `project-${slug}.yaml`, chain: snapshot.chain, hash, bundle,
    specName: runtimeVersion.specName, specVersion: runtimeVersion.specVersion, metadataVersion, pipelines: [] };
  const advertised = metadataVersion >= 16 ? pipelines(registry) : [];
  if (!advertised.length) return { ...result, ok: true };
  const project = noTypes ? null : createRegistry(snapshot, bundle ? loadChainTypes(projectRoot, bundle, sandbox) : {}, deps);
  const remark = deps.decorateExtrinsics(registry, registry.metadata, metadataVersion).system.remark;
  result.pipelines = advertised.map(pipeline => probe({ registry, remark }, project, pipeline));
  return { ...result, ok: result.pipelines.every(p => (noTypes ? p.stock : p.project).ok) };
}

function print(result) {
  if (result.error) return console.log(`${result.manifest}: ERROR ${result.error}`);
  const head = `${result.manifest}: ${result.chain} ${result.specName} ${result.specVersion} metadata=v${result.metadataVersion} chaintypes=${result.bundle || "none"}`;
  if (!result.pipelines.length) return console.log(`${head}\n  no transaction-extension pipelines (General-v5 not advertised)`);
  console.log(head);
  for (const p of result.pipelines) {
    const verdict = r => r.ok ? `OK signed=${r.isSigned}` : `FAIL ${r.error.slice(0, ERROR_PREVIEW_CHARS)}`;
    console.log(`  v${p.version}${p.signed ? " (VerifyMultiSignature)" : ""}: ${p.extensions.join(", ")}`);
    console.log(`    stock:   ${verdict(p.stock)}`);
    if (p.project) console.log(`    project: ${verdict(p.project)}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "project-root": { type: "string", default: process.env.PROJECT_ROOT || REPO_ROOT },
      sandbox: { type: "boolean" }, "no-types": { type: "boolean" }, report: { type: "string" }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: scripts/diagnostics/scan-extension-pipelines.js [manifest-slug ...] [--sandbox] [--no-types] [--report=FILE]");
    console.log("  manifest-slug        e.g. polkadot-people-chain for project-polkadot-people-chain.yaml (default: every manifest)");
    console.log("  --sandbox            Load built chain types through the SubQuery VM (SUBQL_ROOT defaults to /)");
    console.log("  --no-types           Stock decoder only; the verdict then shows which networks need a decoder change");
    console.log("  --project-root=DIR   Built project directory (default: PROJECT_ROOT or repository root)");
    console.log("  --report=FILE        Save the per-network results as JSON (mode 0600, no overwrite)");
    console.log("  RPC_ENDPOINT_OVERRIDE  HTTP(S) RPC for exactly one manifest; pass private URLs via a Podman env-file");
    console.log("Exit: 0 every pipeline decodes, 1 a decoder fails, 2 invalid input, RPC/setup failure or an unsupported probe");
    return;
  }
  for (const key of ["project-root", "report"]) {
    if (values[key] !== undefined && values[key].trim() === "") throw new Error(`--${key} cannot be empty`);
  }
  for (const slug of positionals) readManifest(slug);
  const slugs = positionals.length ? positionals : manifestSlugs();
  const override = process.env.RPC_ENDPOINT_OVERRIDE;
  if (override && slugs.length !== 1) throw new Error("RPC_ENDPOINT_OVERRIDE requires exactly one manifest");
  const deps = dependencies();
  const options = { deps, projectRoot: values["project-root"], sandbox: values.sandbox, noTypes: values["no-types"], endpoint: override };
  const results = [];
  for (const slug of slugs) {
    let result;
    try {
      result = await scan(slug, options);
    } catch (error) {
      const message = [error.message, error.cause?.code].filter(Boolean).join(": ");
      result = { manifest: `project-${slug}.yaml`, error: override ? message.split(override).join("[RPC]") : message };
    }
    print(result);
    results.push(result);
  }
  if (values.report) {
    fs.writeFileSync(values.report, JSON.stringify({ formatVersion: 1, results }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  process.exitCode = results.some(r => r.ok === false) ? 1 : results.some(r => r.error) ? 2 : 0;
}

module.exports = { probe, scan };

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
