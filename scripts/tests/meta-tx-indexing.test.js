const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const fixture = require("./fixtures/westend-ah-meta-tx.json");
const { assetHubCases, SIGNATURE } = require("./helpers/asset-hub-cases");
const { projectMetaTx } = require("./helpers/transaction-pipeline");
const { projectRoot, runtime, createIndexer, loadManifest } = require("./helpers/indexer");
const { decorateExtrinsics } = runtime("@polkadot/types/metadata/decorate/extrinsics");
const { createKeyMulti } = runtime("@polkadot/util-crypto");
const { u8aToHex } = runtime("@polkadot/util");
const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };

const AUTHOR = "0xacf034780e03ea72c3b01f538cd3607f3ee180b56bb91debf2e8fac353acb684";
const OTHER = "0xe1c509629f947f58c63fd3d9d48c6ba155736418d6cff94e1d8b806951c9fe39";
const RELAYER = "0x93f0f0d2eb3054219b7695e188dfddc714103046dbd113b28acbec580b29529c";
const MULTI = "0x9ed98e7b4dee915b7017956c574ad5899432623331241e8db3ae49370874e61e";
const HASH = "0x5c82a16ae12509c4f8f9709d71cb333a0ee683959ff22c30aaa59d591c5bc60e";
const CALL = "0x2a000077d761510f992c4dd3161141d5456f351d32fc8b7256924f04c30ec7b6d330b9000a030093f0f0d2eb3054219b7695e188dfddc714103046dbd113b28acbec580b29529c02f0b31a";
const HEIGHT = 17613388;
const TIME = 1789915488;
const sorted = rows => rows.sort((a, b) => a.id.localeCompare(b.id));
const accounts = (account = MULTI, threshold = 1) => sorted([
  ...[AUTHOR, OTHER].map(id => ({ id, accountId: id, isMultisig: false, threshold: 0 })),
  { id: account, accountId: account, isMultisig: true, threshold },
]);
const links = (account = MULTI) => sorted([AUTHOR, OTHER].map(id => ({ id: `${id}-${account}`, signatoryId: id, multisigId: account })));
const native = { chain: fixture.source.chain, metadata: fixture.metadata,
  runtimeVersion: { specName: fixture.source.specName, specVersion: fixture.source.specVersion } };

test("Westend 17613388-2: raw transaction and events persist the exact threshold-one operation and memberships in the VM", async () => {
  const registry = createRegistry(native, loadChainTypes(projectRoot, "westendAssetHubChaintypes", true), deps);
  const indexer = createIndexer(registry, { chain: "westend", specVersion: fixture.source.specVersion });
  const records = fixture.events.map(hex => registry.createType("EventRecord", hex));
  assert.deepEqual(records.map(record => record.toHex()), fixture.events);
  const result = await indexer.dispatchRecords(fixture.extrinsic, records, { height: HEIGHT, timestamp: TIME, extrinsicIndex: 2 });
  assert.equal(result.source.extrinsic.toHex(), fixture.extrinsic);
  assert.equal(result.source.extrinsic.hash.toHex(), fixture.extrinsicHash);
  assert.deepEqual(result.invoked, ["handleNestedCalls", "handleMultisigExecutedEvent"]);
  const id = `${HASH}-${MULTI}-${HEIGHT}-2`;
  assert.deepEqual(indexer.snapshot(), { Account: accounts(), AccountMultisig: links(),
    MultisigOperation: [{ id, chainId: loadManifest("westend").network.chainId, accountId: MULTI, callHash: HASH,
      callData: CALL, section: "proxy", method: "proxy", depositor: AUTHOR, status: "executed",
      blockCreated: HEIGHT, indexCreated: 2, timestamp: TIME }],
    MultisigEvent: [{ id: `${id}-${AUTHOR}-approve`, accountId: AUTHOR, status: "approve", multisigId: id,
      blockCreated: HEIGHT, indexCreated: 2, timestamp: TIME }], PureProxy: [], Proxied: [] });
});

test("a Signed variant from an unknown authorization extension is rejected in the VM", async () => {
  const metadata = new deps.Metadata(new deps.TypeRegistry(), native.metadata).asLatest.toJSON();
  const verification = metadata.lookup.types.find(entry =>
    entry.type.path.join("::") === "pallet_verify_signature::extension::VerifySignature");
  assert.ok(verification);
  // Model a different authorization scheme with the same SCALE shape and variant name.
  verification.type.path = ["unknown_authorization", "SignedExtension"];
  const snapshot = { ...native, metadata: new deps.Metadata(new deps.TypeRegistry(),
    { magicNumber: 0x6174656d, metadata: { v16: metadata } }).toHex() };
  const registry = createRegistry(snapshot, loadChainTypes(projectRoot, "westendAssetHubChaintypes", true), deps);
  const extension = registry.createType("Extrinsic", fixture.extrinsic).method.args[0].get("extension");
  assert.equal(extension[0].type, "Signed");
  assert.equal(extension[0].value.get("account").toHex(), AUTHOR);
  const indexer = createIndexer(registry, { chain: "westend", specVersion: fixture.source.specVersion });
  await assert.rejects(indexer.dispatchRecords(fixture.extrinsic, fixture.events.map(hex => registry.createType("EventRecord", hex)),
    { height: HEIGHT, timestamp: TIME, extrinsicIndex: 2 }), /Unsupported metaTx authorization/);
  assert.equal(indexer.writes, 0);
});

for (const context of assetHubCases(deps)) {
  const projected = context.chain !== "westend";
  const snapshot = projected ? { ...context.native, metadata: projectMetaTx(context.native.metadata, fixture.metadata, deps) } : native;
  const registry = createRegistry(snapshot, loadChainTypes(projectRoot, context.bundle, true), deps);
  const tx = decorateExtrinsics(registry, registry.metadata, 16);
  const create = () => createIndexer(registry, { chain: context.chain, specVersion: snapshot.runtimeVersion.specVersion });
  const check = (name, run) => test(`${context.chain} (${projected ? "modeled MetaTx upgrade" : "real MetaTx metadata"}): ${name}`, run);
  const inner = tx.system.remark("0x01020304");
  const multi = tx.multisig.asMultiThreshold1([OTHER], inner);
  const weight = { refTime: 1000000000, proofSize: 10000 };
  const when = { height: HEIGHT, index: 0 };
  const two = u8aToHex(createKeyMulti([AUTHOR, OTHER], 2));
  const id = `${inner.hash.toHex()}-${MULTI}-${HEIGHT}-0`;

  function encoded(call, signed = true, signer = RELAYER) {
    const Legacy = registry.createClassUnsafe("GenericExtrinsic");
    const ex = new Legacy(registry, { method: call }, { version: 4 });
    if (signed) ex.addSignature(signer, registry.createType("MultiSignature", { Ed25519: SIGNATURE }).toHex(),
      { era: "0x00", nonce: 0, tip: 0, assetId: null, mode: 0 });
    return ex.toHex();
  }

  function meta(call, account = AUTHOR, enabled = true) {
    const value = { call, extensionVersion: 0, extension: [
      enabled ? { Signed: { signature: { Ed25519: SIGNATURE }, account } } : "Disabled",
      null, null, null, null, null, "0x00", 0, { mode: "Disabled" },
    ] };
    const len = tx.metaTx.dispatch(value, 0).args[0].encodedLength;
    return tx.metaTx.dispatch(value, len);
  }

  function completed(indexer, ok = true) {
    const post = { actualWeight: null, paysFee: "Yes" };
    return indexer.event("metaTx", "Dispatched", [ok ? { Ok: post } : { Err: { postInfo: post, error: "BadOrigin" } }]);
  }

  function executed(indexer, account = MULTI, signer = AUTHOR, call = inner, timepoint = when) {
    return indexer.event("multisig", "MultisigExecuted", [signer, timepoint, account, call.hash.toHex(), { Ok: null }]);
  }

  function operation(account = MULTI, status = "executed") {
    return { id: `${inner.hash.toHex()}-${account}-${HEIGHT}-0`, chainId: context.chainId, accountId: account,
      callHash: inner.hash.toHex(), callData: inner.toHex(), section: "system", method: "remark", depositor: AUTHOR,
      status, blockCreated: HEIGHT, indexCreated: 0, timestamp: TIME };
  }

  if (projected) check("modeled pallet preserves native calls, events, extensions and existing type IDs", () => {
    const read = hex => new deps.Metadata(new deps.TypeRegistry(), hex).asLatest.toJSON();
    const original = read(context.native.metadata);
    const modeled = read(snapshot.metadata);
    assert.deepEqual(modeled.extrinsic, original.extrinsic);
    assert.deepEqual(modeled.pallets.slice(0, original.pallets.length), original.pallets);
    for (const type of original.lookup.types) {
      const actual = structuredClone(modeled.lookup.types.find(entry => entry.id === type.id));
      if (Object.values(original.outerEnums).includes(type.id)) {
        assert.equal(actual.type.def.variant.variants.pop().name, "MetaTx");
      }
      assert.deepEqual(actual, type);
    }
  });

  for (const signed of [true, false]) check(`threshold one uses the authorized signer with ${signed ? "signed" : "unsigned"} outer envelope`, async () => {
    const indexer = create();
    await indexer.dispatch(encoded(meta(multi), signed), [executed(indexer), completed(indexer)], { height: HEIGHT, timestamp: TIME });
    assert.deepEqual(indexer.rows("Account"), accounts());
    assert.deepEqual(indexer.rows("AccountMultisig"), links());
    assert.deepEqual(indexer.rows("MultisigOperation"), [operation()]);
    assert.deepEqual(indexer.rows("MultisigEvent"), [{ id: `${id}-${AUTHOR}-approve`, accountId: AUTHOR,
      status: "approve", multisigId: id, blockCreated: HEIGHT, indexCreated: 0, timestamp: TIME }]);
  });

  check("outer failure, inner failure and invalid authorization create no entities", async () => {
    for (const success of [true, false]) {
      const indexer = create();
      await indexer.dispatch(encoded(meta(multi)), success ? [completed(indexer, false)] : [], { success });
      assert.equal(indexer.writes, 0);
    }
    const indexer = create();
    await assert.rejects(indexer.dispatch(encoded(meta(multi, AUTHOR, false)), [completed(indexer)]), /Unsupported metaTx authorization/);
    assert.equal(indexer.writes, 0);
  });

  check("execution handler preserves missing-event and unsupported-authorization errors", async () => {
    for (const enabled of [true, false]) {
      const indexer = createIndexer(registry, { chain: context.chain, specVersion: snapshot.runtimeVersion.specVersion,
        onlyHandlers: ["handleMultisigExecutedEvent"] });
      const events = [executed(indexer), ...(enabled ? [] : [completed(indexer)])];
      await assert.rejects(indexer.dispatch(encoded(meta(multi, AUTHOR, enabled)), events, { height: HEIGHT, timestamp: TIME }),
        enabled ? /Successful metaTx.dispatch has no Dispatched event/ : /Unsupported metaTx authorization/);
      assert.equal(indexer.writes, 0);
    }
  });

  check("nested meta transactions take the innermost authorized signer", async () => {
    const indexer = create();
    await indexer.dispatch(encoded(meta(meta(multi), RELAYER)), [executed(indexer), completed(indexer), completed(indexer)],
      { height: HEIGHT, timestamp: TIME });
    assert.deepEqual(indexer.rows("Account"), accounts());
    assert.deepEqual(indexer.rows("MultisigOperation"), [operation()]);
  });

  check("batch event boundaries keep a failed meta transaction separate from a successful one", async () => {
    const indexer = create();
    const batch = tx.utility.forceBatch([meta(tx.utility.forceBatch([multi])), meta(multi, RELAYER)]);
    await indexer.dispatch(encoded(batch), [executed(indexer), indexer.event("utility", "ItemCompleted"),
      indexer.event("utility", "BatchCompleted"), completed(indexer), indexer.event("utility", "ItemCompleted"),
      completed(indexer, false), indexer.event("utility", "ItemCompleted"), indexer.event("utility", "BatchCompleted")],
    { height: HEIGHT, timestamp: TIME });
    assert.deepEqual(indexer.rows("Account"), accounts());
    assert.deepEqual(indexer.rows("AccountMultisig"), links());
    assert.deepEqual(indexer.rows("MultisigOperation"), [operation()]);
  });

  check("mixed thresholds with identical call hashes retain the original threshold-two operation", async () => {
    const indexer = create();
    const createTwo = tx.multisig.asMulti(2, [OTHER], null, inner, weight);
    await indexer.dispatch(encoded(meta(createTwo)), [indexer.event("multisig", "NewMultisig", [AUTHOR, two, inner.hash.toHex()]), completed(indexer)],
      { height: HEIGHT, timestamp: TIME });
    const finishTwo = tx.multisig.asMulti(2, [AUTHOR], when, inner, weight);
    await indexer.dispatch(encoded(tx.utility.forceBatch([meta(multi), meta(finishTwo, OTHER)])), [
      executed(indexer, MULTI, AUTHOR, inner, { height: HEIGHT + 1, index: 0 }), completed(indexer), indexer.event("utility", "ItemCompleted"),
      executed(indexer, two, OTHER), completed(indexer), indexer.event("utility", "ItemCompleted"), indexer.event("utility", "BatchCompleted"),
    ], { height: HEIGHT + 1, timestamp: TIME + 1 });
    assert.deepEqual(indexer.rows("MultisigOperation"), sorted([operation(two), { ...operation(),
      id: `${inner.hash.toHex()}-${MULTI}-${HEIGHT + 1}-0`, blockCreated: HEIGHT + 1, timestamp: TIME + 1 }]));
    assert.equal(indexer.rows("MultisigEvent").length, 3);
    assert.deepEqual(indexer.rows("AccountMultisig"), sorted([...links(), ...links(two)]));
  });

  check("hash-only operations do not borrow a sibling account's calldata, with identical or different hashes", async () => {
    for (const call of [inner, tx.system.remark("0x05060708")]) {
      const indexer = create();
      const hash = call.hash.toHex();
      const approval = tx.multisig.approveAsMulti(2, [OTHER], null, hash, weight);
      await indexer.dispatch(encoded(tx.utility.forceBatch([meta(multi), meta(approval)])), [
        executed(indexer), completed(indexer), indexer.event("utility", "ItemCompleted"),
        indexer.event("multisig", "NewMultisig", [AUTHOR, two, hash]), completed(indexer),
        indexer.event("utility", "ItemCompleted"), indexer.event("utility", "BatchCompleted"),
      ], { height: HEIGHT, timestamp: TIME });
      assert.deepEqual(indexer.rows("MultisigOperation"), sorted([operation(), {
        id: `${hash}-${two}-${HEIGHT}-0`, chainId: context.chainId, accountId: two, callHash: hash,
        depositor: AUTHOR, status: "pending", blockCreated: HEIGHT, indexCreated: 0, timestamp: TIME,
      }]));
      assert.deepEqual(indexer.rows("Account"), sorted([...accounts(), { id: two, accountId: two, isMultisig: true, threshold: 2 }]));
      assert.deepEqual(indexer.rows("AccountMultisig"), sorted([...links(), ...links(two)]));
    }
  });

  if (!projected) check("threshold-one classification and calldata survive batches above 100 items", async () => {
    const indexer = create();
    const batch = tx.utility.forceBatch([...Array(100).fill(inner), meta(multi)]);
    await indexer.dispatch(encoded(batch), [
      ...Array.from({ length: 100 }, () => indexer.event("utility", "ItemCompleted")),
      executed(indexer), completed(indexer), indexer.event("utility", "ItemCompleted"), indexer.event("utility", "BatchCompleted"),
    ], { height: HEIGHT, timestamp: TIME });
    assert.deepEqual(indexer.rows("MultisigOperation"), [operation()]);
    assert.deepEqual(indexer.rows("AccountMultisig"), links());
  });

  check("missing threshold-two history still fails instead of fabricating an operation", async () => {
    const indexer = create();
    await assert.rejects(indexer.dispatch(encoded(meta(tx.multisig.asMulti(2, [OTHER], when, inner, weight))),
      [executed(indexer, two), completed(indexer)]), /Operation not found/);
    assert.deepEqual(indexer.rows("MultisigOperation"), []);
  });

  check("legacy direct threshold-one calls keep their account and operation fields", async () => {
    const indexer = create();
    await indexer.dispatch(encoded(multi, true, AUTHOR), [executed(indexer)], { height: HEIGHT, timestamp: TIME });
    assert.deepEqual(indexer.rows("Account"), accounts());
    assert.deepEqual(indexer.rows("MultisigOperation"), [operation()]);
  });
}
