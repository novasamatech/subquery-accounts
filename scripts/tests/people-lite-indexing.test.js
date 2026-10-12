const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const reference = require("./fixtures/polkadot-people-general-extrinsic.json");
const { networkCases, extensionValues } = require("./helpers/network-cases");
const { encodeGeneral, projectPallet } = require("./helpers/transaction-pipeline");
const { projectRoot, runtime, createIndexer } = require("./helpers/indexer");
const { decorateExtrinsics } = runtime("@polkadot/types/metadata/decorate/extrinsics");
const { createKeyMulti } = runtime("@polkadot/util-crypto");
const { u8aToHex } = runtime("@polkadot/util");
const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };

const SIGNER = "0xaa303ae720886af4b297843c52c04a3b1ac3f07bdf176ff7205cf317e4e5d343";
const OTHER = "0x04e9b1ce673275463848cbd73f08a273af6192ba67301d876061cf9876514464";
const ONE = u8aToHex(createKeyMulti([SIGNER, OTHER], 1));
const TWO = u8aToHex(createKeyMulti([SIGNER, OTHER], 2));
const HEIGHT = 10709700;
const TIME = 1791450000;
const weight = { refTime: 1000000000, proofSize: 10000 };
const sorted = rows => rows.sort((a, b) => a.id.localeCompare(b.id));
const signatories = [SIGNER, OTHER].map(id => ({ id, accountId: id, isMultisig: false, threshold: 0 }));
const multisig = (account, threshold) => ({ id: account, accountId: account, isMultisig: true, threshold });
const links = account => [SIGNER, OTHER].map(id => ({ id: `${id}-${account}`, signatoryId: id, multisigId: account }));

// Synthetic SCALE envelopes on real People metadata; never cryptographically valid transactions.
// AsLitePerson turns the VerifyMultiSignature origin into LitePerson(signer); only
// peopleLite.dispatchAsSigner restores Signed(signer) for its inner call.
for (const context of networkCases(deps, "people")) {
  const modeled = context.projected;
  const snapshot = modeled
    ? { ...context.snapshot, metadata: projectPallet(context.snapshot.metadata, reference.metadata, "PeopleLite", deps) }
    : context.snapshot;
  const registry = createRegistry(snapshot, loadChainTypes(projectRoot, context.bundle, true), deps);
  const tx = decorateExtrinsics(registry, registry.metadata, 16);
  const create = () => createIndexer(registry, { chain: context.chain, specVersion: snapshot.runtimeVersion.specVersion });
  const check = (name, run) => test(`${context.chain} (${modeled ? "modeled pipeline 1 and PeopleLite" : "real metadata"}): ${name}`, run);
  const inner = tx.system.remark("0x01020304");
  const hash = inner.hash.toHex();
  const asSigner = call => tx.peopleLite.dispatchAsSigner(call);
  const encoded = call => encodeGeneral(registry, 1, { ...extensionValues(SIGNER), PeopleLiteAuth: { AsLitePerson: 0 } }, call);
  const operation = (account, status) => ({ id: `${hash}-${account}-${HEIGHT}-0`, chainId: context.chainId, accountId: account,
    callHash: hash, callData: inner.toHex(), section: "system", method: "remark", depositor: SIGNER,
    status, blockCreated: HEIGHT, indexCreated: 0, timestamp: TIME });
  const approval = account => ({ id: `${hash}-${account}-${HEIGHT}-0-${SIGNER}-approve`, accountId: SIGNER, status: "approve",
    multisigId: `${hash}-${account}-${HEIGHT}-0`, blockCreated: HEIGHT, indexCreated: 0, timestamp: TIME });
  const executed = indexer => indexer.event("multisig", "MultisigExecuted",
    [SIGNER, { height: HEIGHT, index: 0 }, ONE, hash, { Ok: null }]);

  check("decoded envelope carries the LitePerson authorization and the wrapper", () => {
    const ex = registry.createType("Extrinsic", encoded(asSigner(inner)));
    assert.equal(ex.unwrap().get("PeopleLiteAuth").unwrap().type, "AsLitePerson");
    assert.equal(ex.signer.toString(), registry.createType("AccountId", SIGNER).toString());
    assert.equal(`${ex.method.section}.${ex.method.method}`, "peopleLite.dispatchAsSigner");
  });

  check("threshold-one multisig inside dispatchAsSigner persists exact entities instead of failing the lookup", async () => {
    const indexer = create();
    const result = await indexer.dispatch(encoded(asSigner(tx.multisig.asMultiThreshold1([OTHER], inner))), [executed(indexer)],
      { height: HEIGHT, timestamp: TIME });
    assert.deepEqual(result.invoked, ["handleNestedCalls", "handleMultisigExecutedEvent"]);
    assert.deepEqual(indexer.snapshot(), { Account: sorted([...signatories, multisig(ONE, 1)]), AccountMultisig: sorted(links(ONE)),
      MultisigOperation: [operation(ONE, "executed")], MultisigEvent: [approval(ONE)], PureProxy: [], Proxied: [] });
  });

  check("batch -> dispatchAsSigner -> batch preserves sibling event boundaries and failed calls", async () => {
    const indexer = create();
    const batch = tx.utility.forceBatch([asSigner(tx.utility.batch([tx.multisig.asMultiThreshold1([OTHER], inner)])),
      tx.multisig.asMulti(2, [OTHER], null, inner, weight),
      asSigner(tx.multisig.asMulti(2, [OTHER], null, inner, weight))]);
    await indexer.dispatch(encoded(batch), [executed(indexer), indexer.event("utility", "ItemCompleted"),
      indexer.event("utility", "BatchCompleted"), indexer.event("utility", "ItemCompleted"),
      indexer.event("utility", "ItemFailed", ["BadOrigin"]),
      indexer.event("multisig", "NewMultisig", [SIGNER, TWO, hash]), indexer.event("utility", "ItemCompleted"),
      indexer.event("utility", "BatchCompletedWithErrors")], { height: HEIGHT, timestamp: TIME });
    assert.deepEqual(indexer.snapshot(), { Account: sorted([...signatories, multisig(ONE, 1), multisig(TWO, 2)]),
      AccountMultisig: sorted([...links(ONE), ...links(TWO)]),
      MultisigOperation: sorted([operation(ONE, "executed"), operation(TWO, "pending")]),
      MultisigEvent: sorted([approval(ONE), approval(TWO)]), PureProxy: [], Proxied: [] });
  });

  check("remark registration and removeProxies use the restored signed origin", async () => {
    const indexer = create();
    const payload = Buffer.from(JSON.stringify({ signatories: [SIGNER, OTHER], threshold: 2 }));
    await indexer.dispatch(encoded(asSigner(tx.system.remarkWithEvent(`0x${payload.toString("hex")}`))),
      [indexer.event("system", "Remarked", [SIGNER, registry.hash(payload).toHex()])]);
    assert.deepEqual(indexer.rows("Account"), sorted([...signatories, multisig(TWO, 2)]));
    assert.deepEqual(indexer.rows("AccountMultisig"), sorted(links(TWO)));
    const proxied = account => ({ id: `${context.chainId}-${account}-${TWO}-Any-0`, chainId: context.chainId, accountId: account,
      proxyAccountId: TWO, type: "Any", delay: 0, blockNumber: HEIGHT, extrinsicIndex: 0, isPureProxy: false });
    for (const account of [SIGNER, OTHER]) await indexer.store.set("Proxied", proxied(account).id, proxied(account));
    await indexer.dispatch(encoded(asSigner(tx.proxy.removeProxies())), []);
    assert.deepEqual(indexer.rows("Proxied"), [proxied(OTHER)]);
  });

  check("a failed wrapper, whose inner error fails the extrinsic, writes nothing", async () => {
    const indexer = create();
    const result = await indexer.dispatch(encoded(asSigner(tx.multisig.asMultiThreshold1([OTHER], inner))), [], { success: false });
    assert.deepEqual(result.invoked, []);
    assert.equal(indexer.writes, 0);
  });

  check("a non-signed People origin cannot register remarks, multisigs or proxies without the wrapper", async () => {
    const payload = Buffer.from(JSON.stringify({ signatories: [SIGNER, OTHER], threshold: 2 }));
    const calls = [tx.system.remarkWithEvent(`0x${payload.toString("hex")}`),
      tx.multisig.asMulti(2, [OTHER], null, inner, weight), tx.proxy.removeProxies()];
    for (const call of calls) {
      const indexer = create();
      const result = await indexer.dispatch(encoded(call), [], { success: false });
      assert.deepEqual(result.invoked, call.method === "remarkWithEvent" ? ["handleNestedCalls"] : []);
      assert.equal(indexer.writes, 0);
    }
    for (const method of ["batch", "batchAll", "forceBatch"]) {
      const indexer = create();
      const events = method === "batch" ? [indexer.event("utility", "BatchInterrupted", [0, "BadOrigin"])]
        : method === "forceBatch" ? [...calls.map(() => indexer.event("utility", "ItemFailed", ["BadOrigin"])),
          indexer.event("utility", "BatchCompletedWithErrors")] : [];
      await indexer.dispatch(encoded(tx.utility[method](calls)), events, { success: method !== "batchAll" });
      assert.equal(indexer.writes, 0, method);
    }
  });

  check("failed wrappers in a batch and under a signed proxy do not register their inner remark", async () => {
    const payload = Buffer.from(JSON.stringify({ signatories: [SIGNER, OTHER], threshold: 2 }));
    const wrapped = asSigner(tx.system.remarkWithEvent(`0x${payload.toString("hex")}`));
    const indexer = create();
    // Without AsLitePerson, a signed proxy origin cannot enter dispatchAsSigner.
    const signed = call => encodeGeneral(registry, 1, extensionValues(SIGNER), call);
    await indexer.dispatch(signed(tx.proxy.proxy(OTHER, null, wrapped)),
      [indexer.event("proxy", "ProxyExecuted", [{ Err: "BadOrigin" }])]);
    await indexer.dispatch(signed(tx.utility.forceBatch([wrapped])),
      [indexer.event("utility", "ItemFailed", ["BadOrigin"]), indexer.event("utility", "BatchCompletedWithErrors")]);
    assert.equal(indexer.writes, 0);
  });

  check("a multisig's signed origin cannot enter dispatchAsSigner or register the inner remark", async () => {
    const third = "0x" + "33".repeat(32);
    const payload = Buffer.from(JSON.stringify({ signatories: [SIGNER, third], threshold: 2 }));
    const wrapped = asSigner(tx.system.remarkWithEvent(`0x${payload.toString("hex")}`));
    const wrappedHash = wrapped.hash.toHex();
    const indexer = create();
    const signed = (call, account) => encodeGeneral(registry, 1, extensionValues(account), call);
    await indexer.dispatch(signed(tx.multisig.asMulti(2, [OTHER], null, wrapped, weight), SIGNER),
      [indexer.event("multisig", "NewMultisig", [SIGNER, TWO, wrappedHash])], { height: HEIGHT });
    const before = indexer.rows("Account");
    await indexer.dispatch(signed(tx.multisig.asMulti(2, [SIGNER], { height: HEIGHT, index: 0 }, wrapped, weight), OTHER),
      [indexer.event("multisig", "MultisigExecuted", [OTHER, { height: HEIGHT, index: 0 }, TWO, wrappedHash, { Err: "BadOrigin" }])],
      { height: HEIGHT + 1 });
    assert.deepEqual(indexer.rows("Account"), before);
    assert.deepEqual(indexer.rows("AccountMultisig"), sorted(links(TWO)));
    assert.equal(indexer.rows("MultisigOperation")[0].status, "error");
    assert.equal(indexer.rows("MultisigOperation")[0].callData, wrapped.toHex());
  });
}
