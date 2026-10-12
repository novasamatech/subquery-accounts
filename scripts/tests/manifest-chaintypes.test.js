const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createRegistry, loadChainTypes } = require("../lib/decoder");
const { manifestSlugs } = require("../lib/manifests");
const { projectRoot, runtime, loadManifest } = require("./helpers/indexer");
const { NETWORKS } = require("./helpers/network-cases");

const deps = { ...runtime("@polkadot/types"), ...runtime("@polkadot/types-known") };
// Real pipeline-1 transactions: any runtime may advertise such a pipeline in a later upgrade.
const incidents = ["polkadot-ah-general-extrinsic", "polkadot-people-general-extrinsic"].map(name => {
  const fixture = require(`./fixtures/${name}.json`);
  return { name, fixture, snapshot: { chain: fixture.source.chain, metadata: fixture.metadata,
    runtimeVersion: { specName: fixture.source.specName || "statemint", specVersion: fixture.source.specVersion } } };
});
const slugs = manifestSlugs(projectRoot);

test("the repository has manifests and every network with captured metadata is one of them", () => {
  assert.ok(slugs.length >= 20);
  for (const chain of Object.keys(NETWORKS)) assert.ok(slugs.includes(chain), chain);
});

for (const slug of slugs) {
  test(`project-${slug}.yaml: chain types decode real General-v5 pipeline-1 transactions in the VM`, () => {
    const file = loadManifest(slug).network.chaintypes?.file;
    assert.ok(file, "Every manifest must register chain types built with withMetadataExtrinsic");
    const types = loadChainTypes(projectRoot, path.parse(file).name, true);
    for (const { name, fixture, snapshot } of incidents) {
      const registry = createRegistry(snapshot, types, deps);
      const ex = registry.createType("Extrinsic", fixture.extrinsic);
      assert.equal(ex.isSigned, true, name);
      assert.equal(ex.toHex(), fixture.extrinsic, name);
      assert.equal(ex.hash.toHex(), fixture.extrinsicHash, name);
    }
  });
}
