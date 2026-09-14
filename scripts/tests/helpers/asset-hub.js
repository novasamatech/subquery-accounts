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
  const original = registry.createType("Extrinsic", fixture.extrinsic);
  return encodeGeneral(registry, version, { ...Object.fromEntries(original.unwrap()), ...changes }, call || original.method);
}

module.exports = { fixture, snapshot, envelope, generalBytes };
