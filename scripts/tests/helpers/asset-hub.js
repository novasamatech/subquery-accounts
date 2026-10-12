const fixture = require("../fixtures/polkadot-ah-general-extrinsic.json");
const { envelope, encodeGeneral } = require("./transaction-pipeline");

const snapshot = {
  chain: fixture.source.chain,
  runtimeVersion: { specName: "statemint", specVersion: fixture.source.specVersion },
  metadata: fixture.metadata,
};

// Synthetic envelopes retain the incident's real extension layout. They are not
// cryptographically signed transactions and must never be submitted to a chain.
function generalBytes(registry, version, changes = {}, call) {
  // Native codecs flatten standard extension fields (nonce, era, ...); the metadata
  // adapter retains extension names. Keep the incident values independent of either layout.
  const values = {
    VerifyMultiSignature: { Signed: {
      account: "0x4c2545283514c51c1b5aeac53e68694cbd5913c14044657db192a3e014d8df66",
      signature: { Sr25519: "0xe89a5ce385d8186d9649b75f8007ac4be2a27e01cd3451be557d00e653ccab55b6053c58faedd4e04b4fb85d59cba2139ad5426875785fdeb592349bd053aa83" },
    } },
    RestrictOrigins: true, CheckMortality: "0x4607", CheckNonce: 334,
    ChargeAssetTxPayment: { tip: 0, assetId: null }, CheckMetadataHash: { mode: "Disabled" },
  };
  return encodeGeneral(registry, version, { ...values, ...changes },
    call || registry.createType("Extrinsic", fixture.extrinsic).method);
}

module.exports = { fixture, snapshot, envelope, generalBytes };
