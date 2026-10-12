const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const { fixture } = require("./helpers/asset-hub");
const { encodeGeneral } = require("./helpers/transaction-pipeline");
const { networkCases, extensionValues } = require("./helpers/network-cases");
const { projectRoot, runtime, entityNames, createIndexer: createVmIndexer } = require("./helpers/indexer");
const { decorateExtrinsics } = runtime("@polkadot/types/metadata/decorate/extrinsics");
const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };

// Independent on-chain address vector, also covered by the live legacy test at 1317999.
const S1 = "0xaa303ae720886af4b297843c52c04a3b1ac3f07bdf176ff7205cf317e4e5d343";
const S2 = "0x04e9b1ce673275463848cbd73f08a273af6192ba67301d876061cf9876514464";
const S3 = "0xecb7781c052e8798e620acafcbe8488a2d12639c5da962450ce57657f1ba2956";
const MULTI = "0x9b63daadfbe5f27e3a8810dbdf0110fcc5f7be3b4c062ee00f200bd36509b1b1";
const OUTER = "0x4c2545283514c51c1b5aeac53e68694cbd5913c14044657db192a3e014d8df66";
const HEIGHT = 20494728;
const TIME = 1800000000;
const weight = { refTime: 1000000000, proofSize: 10000 };

// Full multisig lifecycle assertions use 32-byte accounts; EVM proxy entities are checked below.
for (const context of networkCases(deps).filter(network => !network.evm)) {
  const { chainId, snapshot, bundle, chain } = context;
  const registry = createRegistry(snapshot, loadChainTypes(projectRoot, bundle, true), deps);
  const tx = decorateExtrinsics(registry, registry.metadata, 16);
  const createIndexer = registry => createVmIndexer(registry, { chain, specVersion: snapshot.runtimeVersion.specVersion });
  const check = (name, run) => test(`${context.label}: ${name}`, run);
  const inner = tx.system.remark("0x01020304");
  const hash = inner.hash.toHex();
  const operationId = `${hash}-${MULTI}-${HEIGHT}-0`;
  const sorted = rows => rows.sort((a, b) => a.id.localeCompare(b.id));
  const accounts = sorted([...[S1, S2, S3].map(id => ({ id, accountId: id, isMultisig: false, threshold: 0 })),
    { id: MULTI, accountId: MULTI, isMultisig: true, threshold: 2 }]);
  const links = sorted([S1, S2, S3].map(id => ({ id: `${id}-${MULTI}`, multisigId: MULTI, signatoryId: id })));

  function encoded(call, account = S1, version = 5, signed = true) {
    if (version === 5) {
      return encodeGeneral(registry, 1, extensionValues(account, signed), call);
    }
    const Legacy = registry.createClassUnsafe("GenericExtrinsic");
    const legacy = new Legacy(registry, { method: call }, { version: 4 });
    const signature = registry.createType("MultiSignature", extensionValues(account).VerifyMultiSignature.Signed.signature);
    legacy.addSignature(account, signature.toHex(), { era: "0x4607", nonce: 334, tip: 0, assetId: null, mode: 0 });
    return legacy.toHex();
  }

  function operation(status = "pending") {
    return { id: operationId, chainId, accountId: MULTI, callHash: hash, callData: inner.toHex(),
      section: "system", method: "remark", depositor: S1, status, blockCreated: HEIGHT, indexCreated: 0, timestamp: TIME };
  }

  function approval(signer, height = HEIGHT, status = "approve") {
    return { id: `${operationId}-${signer}-${status}`, accountId: signer, status,
      blockCreated: height, indexCreated: 0, multisigId: operationId, timestamp: TIME + height - HEIGHT };
  }

  async function start(indexer, version = 5) {
    const { event } = indexer;
    const call = tx.utility.forceBatch([tx.multisig.asMulti(2, [S2, S3], null, inner, weight)]);
    const result = await indexer.dispatch(encoded(call, S1, version), [
      event("multisig", "NewMultisig", [S1, MULTI, hash]), event("utility", "ItemCompleted"), event("utility", "BatchCompleted"),
    ]);
    assert.deepEqual(result.invoked, ["handleNestedCalls", "handleNewMultisigEvent"]);
    assert.deepEqual(indexer.snapshot(), { Account: accounts, AccountMultisig: links,
      MultisigOperation: [operation()], MultisigEvent: [approval(S1)], PureProxy: [], Proxied: [] });
  }

  for (const version of [4, 5]) {
    check(`v${version}: actual VM persists exact multisig entities through creation, approval and proxied execution`, async () => {
      const activeRegistry = version === 4
        ? createRegistry(context.native, loadChainTypes(projectRoot, bundle, true), deps)
        : registry;
      const indexer = createIndexer(activeRegistry);
      const { event } = indexer;
      await start(indexer, version);
      await indexer.dispatch(encoded(tx.multisig.approveAsMulti(2, [S1, S3], { height: HEIGHT, index: 0 }, hash, weight), S2, version),
        [event("multisig", "MultisigApproval", [S2, { height: HEIGHT, index: 0 }, MULTI, hash])],
        { height: HEIGHT + 1, timestamp: TIME + 1 });
      assert.deepEqual(indexer.rows("MultisigOperation"), [operation()]);
      const call = tx.proxy.proxy(S3, null, tx.multisig.asMulti(2, [S2, S1], { height: HEIGHT, index: 0 }, inner, weight));
      await indexer.dispatch(encoded(call, OUTER, version), [
        event("multisig", "MultisigExecuted", [S3, { height: HEIGHT, index: 0 }, MULTI, hash, { Ok: null }]),
        event("proxy", "ProxyExecuted", [{ Ok: null }]),
      ], { height: HEIGHT + 2, timestamp: TIME + 2 });
      assert.deepEqual(indexer.snapshot(), { Account: accounts, AccountMultisig: links,
        MultisigOperation: [operation("executed")], MultisigEvent: sorted([approval(S1), approval(S2, HEIGHT + 1), approval(S3, HEIGHT + 2)]),
        PureProxy: [], Proxied: [] });
    });
  }

  check("v5: cancelled and failed operations retain creation data and correct event status", async () => {
    for (const status of ["cancelled", "error"]) {
      const indexer = createIndexer(registry);
      await start(indexer);
      const when = { height: HEIGHT, index: 0 };
      const cancelled = status === "cancelled";
      const call = cancelled ? tx.multisig.cancelAsMulti(2, [S2, S3], when, hash) : tx.multisig.asMulti(2, [S1, S3], when, inner, weight);
      const signer = cancelled ? S1 : S2;
      const fields = [signer, when, MULTI, hash];
      if (!cancelled) fields.push({ Err: "BadOrigin" });
      await indexer.dispatch(encoded(call, signer), [indexer.event("multisig", cancelled ? "MultisigCancelled" : "MultisigExecuted", fields)],
        { height: HEIGHT + 1, timestamp: TIME + 1 });
      assert.deepEqual(indexer.rows("MultisigOperation"), [operation(status)]);
      assert.deepEqual(indexer.rows("MultisigEvent"), sorted([approval(S1), approval(signer, HEIGHT + 1, cancelled ? "reject" : "approve")]));
    }
  });

  check("v5: multiple multisig calls in a batch preserve each operation's own callData and callHash", async () => {
    const indexer = createIndexer(registry);
    const calls = [inner, tx.system.remark("0x05060708")];
    await indexer.dispatch(encoded(tx.utility.forceBatch(calls.map(call => tx.multisig.asMulti(2, [S2, S3], null, call, weight)))), [
      ...calls.flatMap(call => [indexer.event("multisig", "NewMultisig", [S1, MULTI, call.hash.toHex()]), indexer.event("utility", "ItemCompleted")]),
      indexer.event("utility", "BatchCompleted"),
    ]);
    assert.deepEqual(indexer.rows("MultisigOperation"), sorted(calls.map(call => ({ ...operation(),
      id: `${call.hash.toHex()}-${MULTI}-${HEIGHT}-0`, callHash: call.hash.toHex(), callData: call.toHex() }))));
    assert.equal(indexer.rows("MultisigEvent").length, 2);
    assert.deepEqual(indexer.rows("Account"), accounts);
  });

  check("v5: failed batch items do not create accounts or relations", async () => {
    const indexer = createIndexer(registry);
    await indexer.dispatch(encoded(tx.utility.forceBatch([
      tx.multisig.asMulti(2, [S2, S3], null, inner, weight),
      tx.multisig.approveAsMulti(3, [S2, S3], null, hash, weight),
    ])), [indexer.event("multisig", "NewMultisig", [S1, MULTI, hash]), indexer.event("utility", "ItemCompleted"),
      indexer.event("utility", "ItemFailed", ["BadOrigin"]), indexer.event("utility", "BatchCompletedWithErrors")]);
    assert.deepEqual(indexer.snapshot(), { Account: accounts, AccountMultisig: links,
      MultisigOperation: [operation()], MultisigEvent: [approval(S1)], PureProxy: [], Proxied: [] });
  });

  check("v5: remark registration persists exact multisig membership without inventing an operation", async () => {
    const indexer = createIndexer(registry);
    const payload = Buffer.from(JSON.stringify({ signatories: [S1, S2, S3], threshold: 2 }));
    await indexer.dispatch(encoded(tx.system.remarkWithEvent(`0x${payload.toString("hex")}`)),
      [indexer.event("system", "Remarked", [S1, registry.hash(payload).toHex()])]);
    assert.deepEqual(indexer.snapshot(), { Account: accounts, AccountMultisig: links,
      MultisigOperation: [], MultisigEvent: [], PureProxy: [], Proxied: [] });
  });

  check("v5: proxy fields persist and proxied removeProxies deletes only the real origin's links", async () => {
    const indexer = createIndexer(registry);
    const id = `${chainId}-${S1}-${S2}-Any-5`;
    const expected = { id, chainId, accountId: S1, proxyAccountId: S2, type: "Any", delay: 5,
      blockNumber: HEIGHT, extrinsicIndex: 0, isPureProxy: false };
    await indexer.dispatch(encoded(tx.proxy.addProxy(S2, "Any", 5)), [indexer.event("proxy", "ProxyAdded", [S1, S2, "Any", 5])]);
    assert.deepEqual(indexer.rows("Proxied"), [expected]);
    const other = { ...expected, id: `${chainId}-${OUTER}-${S2}-Any-5`, accountId: OUTER };
    await indexer.store.set("Proxied", other.id, other);
    await indexer.dispatch(encoded(tx.proxy.proxy(S1, null, tx.proxy.removeProxies()), OUTER), [indexer.event("proxy", "ProxyExecuted", [{ Ok: null }])]);
    assert.deepEqual(indexer.rows("Proxied"), [other]);
  });

  // Older proxy pallets (e.g. Bittensor, Hydration) emit PureCreated without `at`/`extrinsic_index`;
  // derivation then uses the block coordinates, which the transaction format does not change.
  const proxyEvents = registry.lookup.getSiType(registry.metadata.pallets.find(p => p.name.eq("Proxy")).events.unwrap().type);
  const eventCoordinates = proxyEvents.def.asVariant.variants.find(v => v.name.eq("PureCreated")).fields.length === 6;
  if (eventCoordinates) check("v5: pure proxy keeps event derivation coordinates rather than the new envelope coordinates", async () => {
    const indexer = createIndexer(registry);
    const pure = "0x32b451ddfb7b71e4463c38a5bac29bd9679f4c04d853bae12bb1ee4440c1e1ac";
    const spawner = "0x40ff75e9f6e5eea6579fd37a8296c58b0ff0f0940ea873e5d26b701163b1b325";
    // Reuse an independently verified event/address vector; this is a mapping
    // regression, not execution of createPure in the chain's Rust runtime.
    await indexer.dispatch(encoded(tx.proxy.createPure("Any", 0, 0), spawner),
      [indexer.event("proxy", "PureCreated", [pure, spawner, "Any", 0, 6601748, 2])]);
    assert.deepEqual(indexer.rows("PureProxy"), [{ id: `${chainId}-${pure}`, chainId, accountId: pure,
      spawner, disambiguationIndex: 0, entropyBlockNumber: 6601748, extrinsicIndex: 2 }]);
    assert.deepEqual(indexer.rows("Proxied"), [{ id: `${chainId}-${pure}-${spawner}-Any-0`, chainId,
      accountId: pure, proxyAccountId: spawner, type: "Any", delay: 0, blockNumber: 6601748, extrinsicIndex: 2,
      isPureProxy: true, disambiguationIndex: 0, spawner }]);
  });

  check("v5: failed or unauthenticated multisig calls never write indexed records", async () => {
    const call = tx.multisig.asMulti(2, [S2, S3], null, inner, weight);
    for (const [signed, success] of [[true, false], [false, true]]) {
      const indexer = createIndexer(registry);
      const result = await indexer.dispatch(encoded(call, S1, 5, signed), [], { success });
      assert.deepEqual(result.invoked, []);
      assert.equal(indexer.writes, 0);
    }
  });

  if (chain === "polkadot-asset-hub") check("real incident staking call reaches the mapping but performs zero store writes", async () => {
    const indexer = createIndexer(registry);
    const result = await indexer.dispatch(fixture.extrinsic, [indexer.event("utility", "ItemCompleted"), indexer.event("utility", "BatchCompleted")]);
    assert.deepEqual(result.invoked, ["handleNestedCalls"]);
    assert.equal(indexer.writes, 0);
    assert.deepEqual(indexer.snapshot(), Object.fromEntries(entityNames.map(name => [name, []])));
  });
}

for (const context of networkCases(deps).filter(network => network.evm)) {
  test(`${context.chain}: native and modeled metadata preserve signed-v4 proxy entities with 20-byte accounts`, async () => {
    const account = "0x" + "aa".repeat(20);
    const delegate = "0x" + "bb".repeat(20);
    for (const snapshot of [context.native, context.snapshot]) {
      const registry = createRegistry(snapshot, loadChainTypes(projectRoot, context.bundle, true), deps);
      const tx = decorateExtrinsics(registry, registry.metadata, 16);
      const indexer = createVmIndexer(registry, { chain: context.chain, specVersion: snapshot.runtimeVersion.specVersion });
      const signed = call => {
        const ex = registry.createType("Extrinsic", { method: call }, { version: 4 });
        ex.addSignature(account, "0x" + "11".repeat(65), { era: "0x00", nonce: 0, tip: 0, mode: 0 });
        return ex.toHex();
      };
      await indexer.dispatch(signed(tx.utility.batchAll([tx.proxy.addProxy(delegate, "Any", 0)])), [
        indexer.event("proxy", "ProxyAdded", [account, delegate, "Any", 0]),
        indexer.event("utility", "ItemCompleted"), indexer.event("utility", "BatchCompleted"),
      ], { height: HEIGHT });
      assert.deepEqual(indexer.snapshot(), { Account: [], AccountMultisig: [], MultisigOperation: [], MultisigEvent: [], PureProxy: [],
        Proxied: [{ id: `${context.chainId}-${account}-${delegate}-Any-0`, chainId: context.chainId, accountId: account,
          proxyAccountId: delegate, type: "Any", delay: 0, blockNumber: HEIGHT, extrinsicIndex: 0, isPureProxy: false }] });
      await indexer.dispatch(signed(tx.proxy.removeProxies()), []);
      assert.deepEqual(indexer.rows("Proxied"), []);
    }
  });
}
