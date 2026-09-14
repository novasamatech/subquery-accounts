const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const { assetHubCases, extensionValues, SIGNATURE } = require("./helpers/asset-hub-cases");
const { encodeGeneral, envelope, projectPipeline } = require("./helpers/transaction-pipeline");
const { projectRoot, runtime } = require("./helpers/indexer");
const { fixture: reference } = require("./helpers/asset-hub");
const { decorateExtrinsics } = runtime("@polkadot/types/metadata/decorate/extrinsics");
const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };
const account = "0xaa303ae720886af4b297843c52c04a3b1ac3f07bdf176ff7205cf317e4e5d343";
const read = hex => new deps.Metadata(new deps.TypeRegistry(), hex).asLatest.toJSON();

for (const context of assetHubCases(deps)) {
  const { chain, snapshot, native, projected } = context;
  const types = loadChainTypes(projectRoot, context.bundle, true);
  const registry = createRegistry(snapshot, types, deps);
  const tx = decorateExtrinsics(registry, registry.metadata, 16);
  const call = tx.utility.forceBatch([tx.multisig.approveAsMulti(2, ["0x" + "22".repeat(32)], null, "0x" + "33".repeat(32), {})]);
  const bytes = encodeGeneral(registry, 1, extensionValues(account), call);

  if (projected) test(`${chain}: projection preserves every target type, pallet and legacy pipeline`, () => {
    const original = read(native.metadata);
    const future = read(snapshot.metadata);
    assert.deepEqual(future.pallets, original.pallets);
    assert.deepEqual(future.outerEnums, original.outerEnums);
    assert.deepEqual(future.lookup.types.slice(0, original.lookup.types.length), original.lookup.types);
    assert.deepEqual(future.extrinsic.transactionExtensions.slice(0, original.extrinsic.transactionExtensions.length), original.extrinsic.transactionExtensions);
    assert.deepEqual(future.extrinsic.transactionExtensionsByVersion[0], original.extrinsic.transactionExtensionsByVersion[0]);
    assert.deepEqual(Object.keys(original.extrinsic.transactionExtensionsByVersion), ["0"]);
    const names = (meta, version) => meta.extrinsic.transactionExtensionsByVersion[version].map(i => meta.extrinsic.transactionExtensions[i].identifier);
    assert.deepEqual(names(future, 1), names(read(reference.metadata), 1));
    assert.throws(() => projectPipeline(snapshot.metadata, reference.metadata, 1, deps), /already has pipeline/);
    assert.throws(() => projectPipeline(native.metadata, reference.metadata, 99, deps), /Reference has no pipeline/);
  });

  test(`${context.label}: stock codec reproduces Mortal era, configured VM codec preserves origin and bytes`, () => {
    const stock = createRegistry(snapshot, {}, deps);
    assert.throws(() => stock.createType("Extrinsic", bytes), /Invalid data passed to Mortal era/);
    const ex = registry.createType("Extrinsic", bytes);
    assert.equal(ex.isSigned, true);
    assert.equal(ex.isGeneral(), true);
    assert.equal(ex.signer.toString(), registry.createType("AccountId", account).toString());
    assert.equal(ex.signature.toHex(), SIGNATURE);
    assert.equal(ex.method.toHex(), call.toHex());
    assert.equal(ex.method.args[0][0].method, "approveAsMulti");
    assert.equal(ex.nonce.toNumber(), 334);
    assert.equal(ex.tip.toNumber(), 0);
    assert.equal(ex.assetId.isNone, true);
    assert.equal(ex.mode.toNumber(), 0);
    assert.equal(ex.toHex(), "0x" + bytes.toString("hex"));
    assert.equal(ex.hash.toHex(), registry.hash(bytes).toHex());
  });

  test(`${chain}: real current pipeline 0 and signed v4/bare v5 retain native behavior`, () => {
    const current = createRegistry(native, types, deps);
    const stock = createRegistry(native, { ...types, types: {} }, deps);
    const method = decorateExtrinsics(current, current.metadata, 16).system.remark("0x01020304");
    const Legacy = current.createClassUnsafe("GenericExtrinsic");
    const v4 = new Legacy(current, { method }, { version: 4 });
    v4.addSignature(account, current.createType("MultiSignature", { Sr25519: SIGNATURE }).toHex(),
      { era: "0x4607", nonce: 334, tip: 0, assetId: null, mode: 0 });
    for (const value of [v4.toU8a(), envelope(current, Buffer.concat([Buffer.from([5]), method.toU8a()]))]) {
      const expected = stock.createType("Extrinsic", value);
      for (const reg of [current, registry]) {
        const ex = reg.createType("Extrinsic", value);
        assert.equal(ex.toHex(), expected.toHex());
        assert.equal(ex.hash.toHex(), expected.hash.toHex());
        assert.equal(ex.isSigned, expected.isSigned);
        assert.equal(ex.signer.toHex(), expected.signer.toHex());
      }
    }
    const value = encodeGeneral(current, 0, extensionValues(account, false), method);
    assert.notEqual(stock.createType("Extrinsic", value).toHex(), "0x" + value.toString("hex"),
      "Stock General-v5 corrupts the round trip even with the currently advertised pipeline 0");
    const unsigned = current.createType("Extrinsic", value);
    assert.equal(unsigned.isGeneral(), true);
    assert.equal(unsigned.isSigned, false);
    assert.equal(unsigned.method.toHex(), method.toHex());
    assert.equal(unsigned.toHex(), "0x" + value.toString("hex"));
    assert.equal(unsigned.hash.toHex(), current.hash(value).toHex());
  });

  test(`${context.label}: all signature variants, fee assets and unsigned origins`, () => {
    for (const [kind, length] of [["Ed25519", 64], ["Sr25519", 64], ["Ecdsa", 65]]) {
      const signature = "0x" + "ab".repeat(length);
      const value = encodeGeneral(registry, 1, { ...extensionValues(account),
        VerifyMultiSignature: { Signed: { account, signature: { [kind]: signature } } },
        ChargeAssetTxPayment: { tip: 123, assetId: { parents: 0, interior: { X1: [{ GeneralIndex: 1984 }] } } },
        CheckMetadataHash: { mode: "Enabled" },
      }, call);
      const ex = registry.createType("Extrinsic", value);
      assert.equal(ex.isSigned, true);
      assert.equal(ex.signer.toString(), registry.createType("AccountId", account).toString());
      assert.equal(ex.signature.toHex(), signature);
      assert.equal(ex.tip.toNumber(), 123);
      assert.equal(ex.assetId.unwrap().interior.asX1[0].asGeneralIndex.toNumber(), 1984);
      assert.equal(ex.mode.toNumber(), 1);
      assert.equal(ex.toHex(), "0x" + value.toString("hex"));
      assert.equal(ex.hash.toHex(), registry.hash(value).toHex());
    }
    const value = encodeGeneral(registry, 1, extensionValues(account, false), call);
    const unsigned = registry.createType("Extrinsic", value);
    assert.equal(unsigned.isSigned, false);
    assert.equal(unsigned.toHex(), "0x" + value.toString("hex"));
    const truncated = Buffer.from(bytes).subarray(0, -1);
    assert.throws(() => registry.createType("Extrinsic", truncated), /length less than remainder|Invalid Asset Hub/);
    const offset = registry.createType("Compact<u32>", bytes).encodedLength;
    const unknown = Buffer.from(bytes);
    unknown[offset + 1] = 99;
    assert.throws(() => registry.createType("Extrinsic", unknown), /Unknown Asset Hub transaction extension version: 99/);
    assert.throws(() => registry.createType("Extrinsic", envelope(registry, Buffer.concat([bytes.subarray(offset), Buffer.from([0])]))), /length does not match its metadata/);
  });
}
