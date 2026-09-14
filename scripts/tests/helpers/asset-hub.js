const fixture = require("../fixtures/polkadot-ah-general-extrinsic.json");

const snapshot = {
  chain: fixture.source.chain,
  runtimeVersion: { specName: "statemint", specVersion: fixture.source.specVersion },
  metadata: fixture.metadata,
};

function envelope(registry, data) {
  return Buffer.concat([registry.createType("Compact<u32>", data.length).toU8a(), data]);
}

// Synthetic envelopes retain the incident's real extension layout. They are not
// cryptographically signed transactions and must never be submitted to a chain.
function generalBytes(registry, version, changes = {}, call) {
  const original = registry.createType("Extrinsic", fixture.extrinsic);
  const metadata = registry.metadata.extrinsic;
  const [, indices] = [...metadata.transactionExtensionsByVersion].find(([v]) => v.eq(version));
  const parts = [Buffer.from([0x45, version])];
  for (const index of indices) {
    const extension = metadata.transactionExtensions[index.toNumber()];
    const name = extension.identifier.toString();
    const value = Object.hasOwn(changes, name)
      ? registry.createTypeUnsafe(registry.createLookupType(extension.type), [changes[name]])
      : original.unwrap().get(name);
    parts.push(value.toU8a());
  }
  parts.push((call || original.method).toU8a());
  return envelope(registry, Buffer.concat(parts));
}

module.exports = { fixture, snapshot, envelope, generalBytes };
