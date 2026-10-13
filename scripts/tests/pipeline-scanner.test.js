const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { probe } = require("../diagnostics/scan-extension-pipelines");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const { pipelines } = require("../lib/general-extrinsic");
const { createRpc } = require("../lib/rpc");
const { networkCases } = require("./helpers/network-cases");
const { runtime, loadManifest, projectRoot } = require("./helpers/indexer");
const people = require("./fixtures/polkadot-people-general-extrinsic.json");
const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };

test("signed probes reject an AccountId20 runtime before encoding an AccountId32 signer", () => {
  for (const context of networkCases(deps).filter(network => network.evm)) {
    const registry = createRegistry(context.snapshot, {}, deps);
    assert.throws(() => probe({ registry }, null, pipelines(registry).find(p => p.version === 1)),
      /Signed VerifyMultiSignature probes require AccountId32/, context.chain);
  }
});

test("stock-only probes reject lost authentication even when bytes and hash round-trip", t => {
  const context = networkCases(deps).find(network => network.chain === "polkadot-people-chain");
  const types = loadChainTypes(projectRoot, context.bundle, true);
  const registry = createRegistry(context.native, types, deps);
  const project = createRegistry(context.native, types, deps);
  const createType = registry.createType.bind(registry);
  t.mock.method(registry, "createType", (name, ...args) => {
    const ex = createType(name, ...args);
    return name !== "Extrinsic" ? ex : { toHex: () => ex.toHex(), hash: ex.hash, method: ex.method, isSigned: false };
  });
  const { decorateExtrinsics } = runtime("@polkadot/types/metadata/decorate/extrinsics");
  const remark = decorateExtrinsics(registry, registry.metadata, 16).system.remark;
  const pipeline = pipelines(registry).find(p => p.version === 1);
  for (const configured of [null, project]) {
    const result = probe({ registry, remark }, configured, pipeline);
    assert.equal(result.stock.ok, false);
    assert.match(result.stock.error, /Wrong origin/);
    assert.match(result.stock.hash, /^0x[0-9a-f]{64}$/);
    if (configured) assert.equal(result.project.ok, true);
  }
});

test("RPC calls have a timeout signal and reject non-HTTP endpoints", async t => {
  assert.throws(() => createRpc("wss://example.invalid"), /HTTP\(S\)/);
  t.mock.method(global, "fetch", async (endpoint, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(JSON.parse(options.body).method, "system_chain");
    return { ok: true, json: async () => ({ result: "People" }) };
  });
  assert.equal(await createRpc("https://example.invalid")("system_chain"), "People");
});

test("RPC timeout aborts a pending HTTP request", { timeout: 2000 }, async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", delay => {
    assert.ok(Number.isFinite(delay) && delay > 0);
    return timeout(100);
  });
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(createRpc(`http://127.0.0.1:${server.address().port}`)("system_chain"),
      { name: "TimeoutError" });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("scanner CLI verifies genesis, reports securely, redacts overrides and returns 0/1/2", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scanner-"));
  const reportFile = path.join(dir, "report.json");
  const calls = [];
  let failure;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      calls.push(method);
      const responses = {
        chain_getBlockHash: failure === "genesis" ? "0x" + "00".repeat(32) : loadManifest("polkadot-people-chain").network.chainId,
        chain_getFinalizedHead: people.source.hash,
        state_getRuntimeVersion: { specName: people.source.specName, specVersion: people.source.specVersion },
        system_chain: people.source.chain,
        state_getMetadata: people.metadata,
      };
      const message = failure === "rpc" ? `RPC refused http://${req.headers.host}${req.url}`
        : method === "state_call" ? "Metadata_metadata_at_version not supported" : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...(message ? { error: { message } } : { result: responses[method] }) }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/?token=synthetic-test-token`;
  async function run(...args) {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../diagnostics/scan-extension-pipelines.js"),
      "polkadot-people-chain", ...args], { env: { ...process.env, RPC_ENDPOINT_OVERRIDE: endpoint }, timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.doesNotMatch(output, /synthetic-test-token/);
    return { code, output };
  }
  try {
    const configured = await run("--sandbox", `--report=${reportFile}`);
    assert.equal(configured.code, 0, configured.output);
    const report = JSON.parse(fs.readFileSync(reportFile));
    assert.equal(report.formatVersion, 1);
    assert.deepEqual(report.results[0].pipelines.map(p => p.project.ok), [true, true]);
    assert.equal(fs.statSync(reportFile).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(report), /synthetic-test-token/);
    const again = await run("--sandbox", `--report=${reportFile}`);
    assert.equal(again.code, 2, again.output);
    assert.deepEqual(JSON.parse(fs.readFileSync(reportFile)), report);
    const stock = await run("--no-types");
    assert.equal(stock.code, 1, stock.output);
    failure = "genesis";
    calls.length = 0;
    const wrongChain = await run("--sandbox");
    assert.equal(wrongChain.code, 2, wrongChain.output);
    assert.match(wrongChain.output, /RPC genesis differs/);
    assert.deepEqual(calls, ["chain_getBlockHash"]);
    failure = "rpc";
    const unavailable = await run("--sandbox", `--report=${path.join(dir, "error.json")}`);
    assert.equal(unavailable.code, 2, unavailable.output);
    assert.match(unavailable.output, /RPC refused \[RPC\]/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "error.json"), "utf8"), /synthetic-test-token/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
