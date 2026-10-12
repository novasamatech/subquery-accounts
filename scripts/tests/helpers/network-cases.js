const path = require("node:path");
const { fixture: assetHub } = require("./asset-hub");
const { projectPipeline } = require("./transaction-pipeline");
const { loadManifest } = require("./indexer");

const people = require("../fixtures/polkadot-people-general-extrinsic.json");
const metadata = name => require(`../fixtures/${name}-metadata.json`);
// Keyed by manifest slug. Real reduced metadata for every network whose RPC was reachable
// (see doc/runbooks/asset-hub-v5.md). A network without native pipeline 1 models one from its
// family's real runtime: the reference authorizers prepended to the network's own pipeline 0.
// `evm`: 20-byte accounts, so the VerifyMultiSignature (AccountId32) model stays unsigned there.
const NETWORKS = {
  "polkadot-asset-hub": { family: "asset-hub", fixture: assetHub, reference: assetHub },
  "kusama-asset-hub": { family: "asset-hub", fixture: require("../fixtures/kusama-ah-metadata.json"), reference: assetHub },
  "westend-asset-hub": { family: "asset-hub", fixture: require("../fixtures/westend-ah-metadata.json"), reference: assetHub },
  "polkadot-people-chain": { family: "people", fixture: people, reference: people },
  "kusama-people-chain": { family: "people", fixture: metadata("kusama-people"), reference: people },
  polkadot: { family: "relay", fixture: metadata("polkadot-relay"), reference: assetHub },
  kusama: { family: "relay", fixture: metadata("kusama-relay"), reference: assetHub },
  westend: { family: "relay", fixture: metadata("westend-relay"), reference: assetHub },
  "polkadot-coretime": { family: "system", fixture: metadata("polkadot-coretime"), reference: assetHub },
  "kusama-coretime": { family: "system", fixture: metadata("kusama-coretime"), reference: assetHub },
  "polkadot-collectives": { family: "system", fixture: metadata("polkadot-collectives"), reference: assetHub },
  bittensor: { family: "parachain", fixture: metadata("bittensor"), reference: assetHub },
  hydradx: { family: "parachain", fixture: metadata("hydradx"), reference: assetHub },
  moonbeam: { family: "parachain", fixture: metadata("moonbeam"), reference: assetHub, evm: true },
  moonriver: { family: "parachain", fixture: metadata("moonriver"), reference: assetHub, evm: true },
};

function networkCases(deps, family) {
  return Object.entries(NETWORKS).filter(([, network]) => !family || network.family === family)
    .map(([chain, { family, fixture, reference, evm = false }]) => {
      const manifest = loadManifest(chain);
      const projected = fixture !== reference;
      const native = { chain: fixture.source.chain,
        runtimeVersion: { specName: fixture.source.specName || "statemint", specVersion: fixture.source.specVersion },
        metadata: fixture.metadata };
      return { chain, family, fixture, reference, evm, native, projected, chainId: manifest.network.chainId,
        bundle: path.parse(manifest.network.chaintypes.file).name,
        label: `${chain} (${projected ? "projected" : "real"} pipeline 1)`,
        snapshot: { ...native, metadata: projected ? projectPipeline(native.metadata, reference.metadata, 1, deps) : native.metadata } };
    });
}

const SIGNATURE = "0x" + "11".repeat(64);
// Extensions absent from a pipeline are ignored by the encoder; other authorizers
// (AsPerson, AsPgas, ...) stay None, as in a plain signed transaction.
function extensionValues(account, signed = true) {
  return {
    VerifyMultiSignature: signed ? { Signed: { account, signature: { Sr25519: SIGNATURE } } } : "Disabled",
    CheckMortality: "0x4607", CheckNonce: 334,
    ChargeAssetTxPayment: { tip: 0, assetId: null }, ChargeTransactionPayment: 0, CheckMetadataHash: { mode: "Disabled" },
  };
}

module.exports = { NETWORKS, networkCases, extensionValues, SIGNATURE };
