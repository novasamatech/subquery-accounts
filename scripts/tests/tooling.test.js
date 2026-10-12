const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../..");
const diagnostic = path.join(root, "scripts/diagnostics/debug-asset-hub-block.js");
const { validateSnapshot } = require("../diagnostics/debug-asset-hub-block");
const fixture = require("./fixtures/polkadot-ah-general-extrinsic.json");

function snapshot() {
  return { formatVersion: 1, chain: fixture.source.chain, hash: fixture.source.hash,
    runtimeVersion: { specName: "statemint", specVersion: fixture.source.specVersion },
    metadata: fixture.metadata, raw: { block: { header: { number: '0x' + fixture.source.block.toString(16), parentHash: '0x' + '00'.repeat(32) },
      extrinsics: [fixture.extrinsic] } } };
}

test("single-block CLI rejects invalid selectors before contacting RPC", () => {
  for (const args of [
    ["polkadot"],
    ["polkadot", "--hash="],
    ["polkadot", "--hash=0x1234"],
    ["polkadot", "--block=-1"],
    ["polkadot", "--block=9007199254740992"],
    ["polkadot", "--block=1", "--hash=0x" + "00".repeat(32)],
    ["polkadot", "--block=1", "--compare", "--no-types"],
    ["polkadot", "--block=1", "--fixture=/out/fixture.json"],
    ["polkadot", "--block=1", "--extrinsic=2", "--fixture="],
    ["polkadot", "--block=1", "--metadata-fixture="],
    ["polkadot", "--finalized", "--block=1"],
    ["unknown", "--block=1"],
    ["project-unknown.yaml", "--block=1"],
    ["project-polkadot-people-chain.yaml"],
    ["project-polkadot-people-chain.yaml", "kusama", "--finalized"],
  ]) {
    const result = spawnSync(process.execPath, [diagnostic, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 2, JSON.stringify(args) + result.stderr);
    assert.doesNotMatch(result.stdout, /@polkadot\/api/);
  }
});

test("manifest mode refuses a snapshot whose genesis is missing or belongs to another network", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-snapshot-"));
  try {
    const input = path.join(dir, "snapshot.json");
    const people = require("./fixtures/polkadot-people-general-extrinsic.json");
    const raw = { ...snapshot(), chain: people.source.chain, metadata: people.metadata,
      runtimeVersion: { specName: people.source.specName, specVersion: people.source.specVersion } };
    raw.raw.block.extrinsics = [people.extrinsic];
    for (const genesisHash of [undefined, "0x" + "00".repeat(32)]) {
      fs.writeFileSync(input, JSON.stringify({ ...raw, genesisHash }));
      const result = spawnSync(process.execPath, [diagnostic, "project-polkadot-people-chain.yaml", `--snapshot=${input}`, "--no-types"],
        { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /genesis does not match the manifest chainId/);
    }
    fs.writeFileSync(input, JSON.stringify({ ...raw, genesisHash: "0x67fa177a097bfa18f77ea95ab56e9bcdfeb0e5b8a40e46298bb93e16b6fc5008" }));
    const stock = spawnSync(process.execPath, [diagnostic, "project-polkadot-people-chain.yaml", `--snapshot=${input}`, "--no-types"],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(stock.status, 1, stock.stderr);
    assert.match(stock.stdout, /Invalid data passed to Mortal era/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline scanner validates manifests and override scope before contacting RPC", () => {
  const scanner = path.join(root, "scripts/diagnostics/scan-extension-pipelines.js");
  const help = spawnSync(process.execPath, [scanner, "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /RPC_ENDPOINT_OVERRIDE/);
  for (const [args, env] of [[["unknown-network"], {}], [["--report="], {}],
    [["polkadot", "kusama"], { RPC_ENDPOINT_OVERRIDE: "http://127.0.0.1:9" }], [[], { RPC_ENDPOINT_OVERRIDE: "http://127.0.0.1:9" }]]) {
    const result = spawnSync(process.execPath, [scanner, ...args], { encoding: "utf8", timeout: 5000, env: { ...process.env, ...env } });
    assert.equal(result.status, 2, JSON.stringify(args) + result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("snapshot validation rejects missing provenance and malformed bytes", () => {
  validateSnapshot(snapshot());
  for (const mutate of [s => { s.formatVersion = 2; }, s => { delete s.raw; },
    s => { s.metadata = '0x123'; }, s => { s.raw.block.extrinsics[0] = 'invalid'; },
    s => { s.runtimeVersion.specVersion = '2005000'; }, s => { s.events = '0x123'; }, s => { s.events = null; }]) {
    const s = snapshot();
    mutate(s);
    assert.throws(() => validateSnapshot(s), /Invalid raw-block snapshot/);
  }
});

test("single-block reports identify all dependency packages and refuse overwrite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-report-'));
  const input = path.join(dir, 'snapshot.json');
  const output = path.join(dir, 'report.json');
  try {
    fs.writeFileSync(input, JSON.stringify(snapshot()));
    const args = [diagnostic, 'polkadot', `--snapshot=${input}`, `--report=${output}`, '--no-types'];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(fs.readFileSync(output));
    assert.ok(report.packages['@polkadot/types-known'].version);
    assert.match(report.metadataSha256, /^[0-9a-f]{64}$/);
    assert.match(report.decoders[0].extrinsics[0].error, /Mortal era/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const again = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(again.status, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), report);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("single-block compare fails when a project codec changes a successfully decoded legacy signer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decoder-parity-"));
  try {
    const legacy = require("./fixtures/westend-ah-meta-tx.json");
    const input = path.join(dir, "snapshot.json");
    const reportFile = path.join(dir, "report.json");
    fs.writeFileSync(input, JSON.stringify({ ...snapshot(), chain: legacy.source.chain, metadata: legacy.metadata,
      runtimeVersion: { specName: legacy.source.specName, specVersion: legacy.source.specVersion },
      raw: { block: { header: { number: "0x" + legacy.source.block.toString(16), parentHash: legacy.source.parentHash },
        extrinsics: [legacy.extrinsic] } } }));
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist/westendAssetHubChaintypes.js"), `
      exports.default = { types: { Extrinsic: class {
        constructor(registry, value, options) {
          const Base = registry.createClassUnsafe("GenericExtrinsic");
          const ex = new Base(registry, value, options);
          Object.defineProperty(ex, "signer", { value: registry.createType("Address", "0x" + "aa".repeat(32)) });
          return ex;
        }
      } } };
    `);
    const result = spawnSync(process.execPath, [diagnostic, "westend", `--snapshot=${input}`, "--compare",
      `--project-root=${dir}`, `--report=${reportFile}`], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /#0 MISMATCH stock and project decoders disagree/);
    const report = JSON.parse(fs.readFileSync(reportFile));
    assert.equal(report.decoders[0].ok, true);
    assert.equal(report.decoders[1].extrinsics[0].ok, true);
    assert.equal(report.decoders[1].ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("single-block RPC override takes precedence over the legacy variable and is redacted", () => {
  const endpoint = "https:///?token=synthetic-primary-token";
  for (const env of [{ RPC_ENDPOINT_OVERRIDE: endpoint, ASSET_HUB_ENDPOINT: "invalid-legacy-scheme" },
    { RPC_ENDPOINT_OVERRIDE: "", ASSET_HUB_ENDPOINT: endpoint }]) {
    const result = spawnSync(process.execPath, [diagnostic, "polkadot", "--finalized"],
      { encoding: "utf8", timeout: 10000, env: { ...process.env, ...env } });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /\[RPC\]/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-primary-token|invalid-legacy-scheme/);
  }
});

test("single-block help does not load a decoder or connect to RPC", () => {
  const result = spawnSync(process.execPath, [diagnostic, "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--snapshot=FILE/);
  assert.match(result.stdout, /--sandbox/);
  assert.match(result.stdout, /--fixture=FILE/);
  assert.match(result.stdout, /--metadata-fixture=FILE/);
  assert.match(result.stdout, /--events/);
  assert.match(result.stdout, /--calls/);
});

test("event fixture export preserves raw records, MetaTx calls and their event metadata", () => {
  const meta = require("./fixtures/westend-ah-meta-tx.json");
  const { dependencies, createRegistry } = require("../lib/decoder");
  const deps = dependencies();
  const raw = { formatVersion: 1, chain: meta.source.chain, hash: meta.source.hash,
    runtimeVersion: { specName: meta.source.specName, specVersion: meta.source.specVersion }, metadata: meta.metadata,
    raw: { block: { header: { number: '0x' + meta.source.block.toString(16), parentHash: meta.source.parentHash },
      extrinsics: [meta.extrinsic, meta.extrinsic, meta.extrinsic] } } };
  const registry = createRegistry(raw, {}, deps);
  raw.events = registry.createType("Vec<EventRecord>", meta.events).toHex();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-tx-fixture-"));
  try {
    const input = path.join(dir, "snapshot.json");
    const output = path.join(dir, "fixture.json");
    fs.writeFileSync(input, JSON.stringify(raw));
    const args = [diagnostic, "westend", `--snapshot=${input}`, "--extrinsic=2", `--fixture=${output}`, "--events", "--calls", "--no-types"];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /metaTx\.dispatch/);
    assert.match(result.stdout, /multisig\.MultisigExecuted/);
    assert.match(result.stdout, /asMultiThreshold1/);
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), meta);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 }).status, 2);
    delete raw.events;
    fs.writeFileSync(input, JSON.stringify(raw));
    const missing = spawnSync(process.execPath, [diagnostic, "westend", `--snapshot=${input}`, "--events", "--no-types"],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Snapshot has no events/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata fixture export retains real provenance without inventing a transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-fixture-"));
  try {
    const input = path.join(dir, "snapshot.json");
    const output = path.join(dir, "metadata.json");
    const raw = snapshot();
    raw.raw.block.extrinsics = [];
    fs.writeFileSync(input, JSON.stringify(raw));
    const args = [diagnostic, "polkadot", `--snapshot=${input}`, `--metadata-fixture=${output}`, "--no-types"];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const reduced = JSON.parse(fs.readFileSync(output));
    assert.equal(reduced.metadata, fixture.metadata);
    assert.equal(reduced.source.hash, raw.hash);
    assert.equal(reduced.source.parentHash, raw.raw.block.header.parentHash);
    assert.equal(reduced.source.specName, "statemint");
    assert.equal(reduced.extrinsic, undefined);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 }).status, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), reduced);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture export preserves the transaction and metadata indices and refuses overwrite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-fixture-"));
  const input = path.join(dir, "snapshot.json");
  const output = path.join(dir, "fixture.json");
  try {
    fs.writeFileSync(input, JSON.stringify(snapshot()));
    const args = [diagnostic, "polkadot", `--snapshot=${input}`, "--extrinsic=0", `--fixture=${output}`, "--no-types"];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr); // Stock decode fails, raw fixture export succeeds.
    const reduced = JSON.parse(fs.readFileSync(output));
    assert.equal(reduced.extrinsic, fixture.extrinsic);
    assert.equal(reduced.extrinsicHash, fixture.extrinsicHash);
    assert.equal(reduced.metadata, fixture.metadata, "Reduction is idempotent and keeps SCALE IDs");
    assert.equal(reduced.source.hash, fixture.source.hash);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 }).status, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), reduced);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith(".md") ? [file] : [];
  });
}

test("documentation navigation resolves local files and heading anchors", () => {
  const files = ["AGENTS.md", "README.md", "TODO.md", "scripts/README.md"].map(file => path.join(root, file));
  files.push(...markdownFiles(path.join(root, "doc")));
  let checked = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8")
      .replace(/^(\x60{3}|~{3}).*\n[\s\S]*?^\1\s*$/gm, "")
      .replace(/\x60[^\x60]*\x60/g, "");
    for (const [, target] of content.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [relative, anchor] = target.split("#");
      const destination = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : file;
      assert.ok(fs.existsSync(destination), `${path.relative(root, file)} -> ${target}`);
      if (anchor && destination.endsWith(".md")) {
        const headings = [...fs.readFileSync(destination, "utf8").matchAll(/^#+\s+(.+)$/gm)].map(([, heading]) =>
          heading.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s/g, "-"),
        );
        assert.ok(headings.includes(anchor), `${path.relative(root, file)} -> missing #${anchor}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 50, "Check the documentation graph, not just one file");
});
