const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const { projectRoot, runtime, entityNames, createIndexer } = require("./helpers/indexer");
const fixture = require("./fixtures/polkadot-people-general-extrinsic.json");

const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };
const native = { chain: fixture.source.chain, metadata: fixture.metadata,
  runtimeVersion: { specName: fixture.source.specName, specVersion: fixture.source.specVersion } };
const { block: height, extrinsicIndex } = fixture.source;
const SIGNATURE = "0x50f4c4e6bf7918aed3814a2613bc240fe9f2a9debd904197533901b506b36032ffbfc811509acd47aafc95c2171ca670eb65797db2a26a34486e6e7626b8c082";

test("Polkadot People 10709657-2: stock decoder reproduces the production Mortal era error", () => {
  const registry = createRegistry(native, {}, deps);
  assert.throws(() => registry.createType("Extrinsic", fixture.extrinsic), /Invalid data passed to Mortal era/);
});

for (const sandbox of [false, true]) {
  const mode = sandbox ? "SubQuery VM" : "direct";
  const registry = createRegistry(native, loadChainTypes(projectRoot, "metadataExtrinsicChaintypes", sandbox), deps);
  const records = fixture.events.map(hex => registry.createType("EventRecord", hex));
  // The runtime records the payer independently of the transaction bytes.
  const loaded = records.find(record => record.event.section === "coinage" && record.event.method === "RecyclerLoadedWithExternalAsset");

  test(`${mode}: real pipeline-1 coinage transaction keeps bytes, hash, extensions and on-chain signer`, () => {
    const ex = registry.createType("Extrinsic", fixture.extrinsic);
    assert.equal(ex.isGeneral(), true);
    assert.equal(ex.type, 5);
    assert.equal(ex.version, 0x45);
    const extensions = ex.unwrap();
    assert.equal(extensions.get("transactionExtensionVersion").toNumber(), 1);
    assert.equal(extensions.get("AsCoinage").unwrap().type, "InfallibleUnpaidSigned");
    for (const name of ["AsPerson", "PeopleLiteAuth", "AsMember", "AsResources"]) assert.equal(extensions.get(name).isNone, true, name);
    assert.equal(extensions.get("RestrictOrigins").isTrue, true);
    assert.equal(ex.isSigned, true);
    assert.equal(ex.signer.toString(), loaded.event.data[1].toString());
    assert.equal(ex.signature.toHex(), SIGNATURE);
    assert.equal(`${ex.method.section}.${ex.method.method}`, "coinage.loadRecyclerWithExternalAssetUnpaid");
    assert.equal(ex.method.args[2].toNumber(), 11);
    assert.equal(ex.nonce.toNumber(), 0);
    assert.equal(ex.era.asMortalEra.period.toNumber(), 128);
    assert.equal(ex.era.asMortalEra.phase.toNumber(), 7);
    assert.equal(ex.tip.toNumber(), 0);
    assert.equal(ex.assetId.isNone, true);
    assert.equal(ex.mode.toNumber(), 0);
    assert.equal(ex.toHex(), fixture.extrinsic);
    assert.equal(ex.hash.toHex(), fixture.extrinsicHash);
    assert.equal(registry.createType("Extrinsic", ex).toHex(), fixture.extrinsic);
    assert.equal(ex.toHuman().isSigned, true);
  });

  if (sandbox) test(`${mode}: real transaction and events pass SubQuery filters but write no entity`, async () => {
    const { filterExtrinsic } = runtime("./dist/utils/substrate");
    const indexer = createIndexer(registry, { chain: "polkadot-people-chain", specVersion: fixture.source.specVersion });
    assert.deepEqual(records.map(record => record.toHex()), fixture.events);
    const result = await indexer.dispatchRecords(fixture.extrinsic, records, { height, timestamp: 1791449784, extrinsicIndex });
    assert.equal(result.source.extrinsic.hash.toHex(), fixture.extrinsicHash);
    assert.equal(result.source.success, true);
    assert.equal(filterExtrinsic(result.source, { module: "coinage", method: "loadRecyclerWithExternalAssetUnpaid", isSigned: true }), true);
    assert.deepEqual(result.invoked, []);
    assert.equal(indexer.writes, 0);
    assert.deepEqual(indexer.snapshot(), Object.fromEntries(entityNames.map(name => [name, []])));
  });
}
