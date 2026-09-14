const path = require("node:path");
const { fixture: polkadot } = require("./asset-hub");
const { projectPipeline } = require("./transaction-pipeline");
const { loadManifest } = require("./indexer");

const fixtures = { polkadot,
  kusama: require("../fixtures/kusama-ah-metadata.json"),
  westend: require("../fixtures/westend-ah-metadata.json") };

function assetHubCases(deps) {
  return Object.entries(fixtures).map(([chain, fixture]) => {
    const manifest = loadManifest(chain);
    const projected = chain !== "polkadot";
    const native = { chain: fixture.source.chain,
      runtimeVersion: { specName: fixture.source.specName || "statemint", specVersion: fixture.source.specVersion },
      metadata: fixture.metadata };
    return { chain, fixture, native, projected, chainId: manifest.network.chainId,
      bundle: path.parse(manifest.network.chaintypes.file).name,
      label: `${chain} (${projected ? "projected" : "real"} pipeline 1)`,
      snapshot: { ...native, metadata: projected ? projectPipeline(native.metadata, polkadot.metadata, 1, deps) : native.metadata } };
  });
}

const SIGNATURE = "0x" + "11".repeat(64);
function extensionValues(account, signed = true) {
  return {
    VerifyMultiSignature: signed ? { Signed: { account, signature: { Sr25519: SIGNATURE } } } : "Disabled",
    CheckMortality: "0x4607", CheckNonce: 334,
    ChargeAssetTxPayment: { tip: 0, assetId: null }, CheckMetadataHash: { mode: "Disabled" },
  };
}

module.exports = { assetHubCases, extensionValues, SIGNATURE };
