const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const { loadRuntime } = require("../lib/runtime");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const { fixture, snapshot, envelope, generalBytes } = require("./helpers/asset-hub");

const projectRoot = process.env.PROJECT_ROOT || path.resolve(__dirname, "../..");
const runtime = loadRuntime();
const project = createRequire(path.resolve(projectRoot, "package.json"));
const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };
const account = "0x4c2545283514c51c1b5aeac53e68694cbd5913c14044657db192a3e014d8df66";

test("stock decoder reproduces the production Mortal era error", () => {
  const registry = createRegistry(snapshot, {}, deps);
  assert.throws(() => registry.createType("Extrinsic", fixture.extrinsic), /Invalid data passed to Mortal era/);
});

for (const sandbox of [false, true]) {
  const mode = sandbox ? "SubQuery VM" : "direct";
  const types = loadChainTypes(projectRoot, "polkadotAssetHubChaintypes", sandbox);
  const registry = createRegistry(snapshot, types, deps);

  test(`${mode}: real v5 forceBatch preserves origin, nested call, bytes and hash`, () => {
    const ex = registry.createType("Extrinsic", fixture.extrinsic);
    assert.equal(ex.isGeneral(), true);
    assert.equal(ex.type, 5);
    assert.equal(ex.version, 0x45);
    assert.equal(ex.isSigned, true);
    assert.equal(ex.signer.toString(), registry.createType("AccountId", account).toString());
    assert.equal(ex.signature.toHex(), "0xe89a5ce385d8186d9649b75f8007ac4be2a27e01cd3451be557d00e653ccab55b6053c58faedd4e04b4fb85d59cba2139ad5426875785fdeb592349bd053aa83");
    assert.equal(ex.method.section, "utility");
    assert.equal(ex.method.method, "forceBatch");
    const innerCall = ex.method.args[0][0];
    assert.equal(innerCall.section, "staking");
    assert.equal(innerCall.method, "payoutStakers");
    assert.equal(innerCall.args[1].toNumber(), 2288);
    assert.equal(ex.nonce.toNumber(), 334);
    assert.equal(ex.era.asMortalEra.period.toNumber(), 128);
    assert.equal(ex.era.asMortalEra.phase.toNumber(), 116);
    assert.equal(ex.tip.toNumber(), 0);
    assert.equal(ex.assetId.isNone, true);
    assert.equal(ex.mode.toNumber(), 0);
    assert.equal(ex.toHex(), fixture.extrinsic);
    assert.equal(ex.hash.toHex(), fixture.extrinsicHash);
    assert.equal(registry.createType("Extrinsic", ex).toHex(), fixture.extrinsic);
    assert.equal(ex.toHuman().isSigned, true);
  });

  test(`${mode}: actual SubQuery signed filter and visitor retain the authenticated origin`, async () => {
    const { filterExtrinsic } = runtime('./dist/utils/substrate');
    const extrinsic = registry.createType('Extrinsic', fixture.extrinsic);
    const source = { extrinsic, success: true, block: { specVersion: fixture.source.specVersion },
      events: ['ItemCompleted', 'BatchCompleted'].map(method => ({ event: { section: 'utility', method } })) };
    assert.equal(filterExtrinsic(source, { module: 'utility', method: 'forceBatch', isSigned: true }), true);
    assert.equal(filterExtrinsic(source, { isSigned: false }), false);
    const previousApi = global.api;
    global.api = { events: { utility: Object.fromEntries(['ItemCompleted', 'BatchCompleted'].map(method =>
      [method, { is: event => event.section === 'utility' && event.method === method }])) } };
    const visited = [];
    try {
      const { CreateCallWalk, CreateCallVisitorBuilder } = project('subquery-call-visitor');
      await CreateCallWalk().walk(source, CreateCallVisitorBuilder()
        .on('staking', 'payoutStakers', call => { visited.push({ origin: call.origin, success: call.success }); })
        .ignoreFailedCalls(true).build());
      assert.deepEqual(visited, [{ origin: extrinsic.signer.toString(), success: true }]);
      const unsigned = registry.createType('Extrinsic', generalBytes(registry, 1, { VerifyMultiSignature: 'Disabled' }));
      assert.equal(filterExtrinsic({ ...source, extrinsic: unsigned }, { isSigned: true }), false);
    } finally {
      if (previousApi === undefined) delete global.api;
      else global.api = previousApi;
    }
  });

  test(`${mode}: general pipeline 0 stays unsigned and uses only its own fields`, () => {
    const bytes = generalBytes(registry, 0);
    const ex = registry.createType("Extrinsic", bytes);
    assert.equal(ex.isGeneral(), true);
    assert.equal(ex.isSigned, false);
    assert.equal(ex.nonce.toNumber(), 334);
    assert.equal(ex.method.method, "forceBatch");
    assert.deepEqual(Buffer.from(ex.toU8a()), bytes);
    assert.equal(ex.hash.toHex(), registry.hash(bytes).toHex());
  });

  test(`${mode}: disabled VerifyMultiSignature does not invent a signed origin`, () => {
    const bytes = generalBytes(registry, 1, { VerifyMultiSignature: "Disabled" });
    const ex = registry.createType("Extrinsic", bytes);
    assert.equal(ex.isSigned, false);
    assert.equal(ex.method.method, "forceBatch");
    assert.deepEqual(Buffer.from(ex.toU8a()), bytes);
  });

  for (const [kind, size] of [["Ed25519", 64], ["Ecdsa", 65]]) {
    test(`${mode}: ${kind} signatures use metadata-defined lengths`, () => {
      const signature = `0x${"11".repeat(size)}`;
      const bytes = generalBytes(registry, 1, { VerifyMultiSignature: { Signed: { account, signature: { [kind]: signature } } } });
      const ex = registry.createType("Extrinsic", bytes);
      assert.equal(ex.isSigned, true);
      assert.equal(ex.signature.toHex(), signature);
      assert.equal(ex.nonce.toNumber(), 334);
      assert.deepEqual(Buffer.from(ex.toU8a()), bytes);
    });
  }

  test(`${mode}: fee asset and metadata mode are decoded from their extensions`, () => {
    const bytes = generalBytes(registry, 1, {
      ChargeAssetTxPayment: { tip: 123, assetId: { parents: 0, interior: { X1: [{ GeneralIndex: 1984 }] } } },
      CheckMetadataHash: { mode: "Enabled" },
    });
    const ex = registry.createType("Extrinsic", bytes);
    assert.equal(ex.tip.toNumber(), 123);
    assert.equal(ex.assetId.unwrap().interior.asX1[0].asGeneralIndex.toNumber(), 1984);
    assert.equal(ex.mode.toNumber(), 1);
    assert.equal(ex.method.method, "forceBatch");
    assert.deepEqual(Buffer.from(ex.toU8a()), bytes);
  });

  test(`${mode}: signed v4 and bare v5 continue using the stock decoder`, () => {
    const original = registry.createType("Extrinsic", fixture.extrinsic);
    const Legacy = registry.createClassUnsafe("GenericExtrinsic");
    const legacy = new Legacy(registry, { method: original.method }, { version: 4 });
    const signature = original.unwrap().get("VerifyMultiSignature").value.get("signature");
    legacy.addSignature(account, signature.toHex(), { era: original.era, nonce: 334, tip: 0, assetId: null, mode: 0 });
    const decoded = registry.createType("Extrinsic", legacy.toHex());
    assert.equal(decoded.isGeneral(), false);
    assert.equal(decoded.isSigned, true);
    assert.equal(decoded.toHex(), legacy.toHex());
    assert.equal(decoded.hash.toHex(), legacy.hash.toHex());
    assert.equal(decoded.signer.toString(), original.signer.toString());
    const bare = envelope(registry, Buffer.concat([Buffer.from([5]), original.method.toU8a()]));
    const unsigned = registry.createType("Extrinsic", bare);
    assert.equal(unsigned.isGeneral(), false);
    assert.equal(unsigned.isSigned, false);
    assert.deepEqual(Buffer.from(unsigned.toU8a()), bare);
  });

  test(`${mode}: unknown versions, truncation and trailing data fail explicitly`, () => {
    const bytes = Buffer.from(fixture.extrinsic.slice(2), "hex");
    const offset = registry.createType("Compact<u32>", bytes).encodedLength;
    const unknown = Buffer.from(bytes);
    unknown[offset + 1] = 99;
    assert.throws(() => registry.createType("Extrinsic", unknown), /Unknown Asset Hub transaction extension version: 99/);
    assert.throws(() => registry.createType("Extrinsic", bytes.subarray(0, -1)), /length less than remainder|Invalid Asset Hub general extrinsic envelope/);
    const trailing = envelope(registry, Buffer.concat([bytes.subarray(offset), Buffer.from([0])]));
    assert.throws(() => registry.createType("Extrinsic", trailing), /length does not match its metadata/);
  });
}
