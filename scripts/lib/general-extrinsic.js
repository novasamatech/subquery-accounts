// Encode/verify General-v5 transactions directly from metadata, independently of the decoder
// under test. Encoded values are SCALE test vectors, not cryptographically authorized transactions.
// Keep the wire preamble here: importing it from chainTypes would couple the encoder to the decoder.
const GENERAL_PREAMBLE = 0x45;

function envelope(registry, data) {
  return Buffer.concat([registry.createType("Compact<u32>", data.length).toU8a(), data]);
}

function pipelines(registry) {
  const metadata = registry.metadata.extrinsic;
  return [...(metadata.transactionExtensionsByVersion || [])].map(([version, indices]) => ({
    version: version.toNumber(),
    extensions: indices.map(index => metadata.transactionExtensions[index.toNumber()].identifier.toString()),
  }));
}

function encodeGeneral(registry, version, values, call) {
  const metadata = registry.metadata.extrinsic;
  const pipeline = [...metadata.transactionExtensionsByVersion].find(([v]) => v.eq(version));
  if (!pipeline) throw new Error(`Unknown test pipeline ${version}`);
  const parts = [Buffer.from([GENERAL_PREAMBLE, version])];
  for (const index of pipeline[1]) {
    const extension = metadata.transactionExtensions[index.toNumber()];
    const name = extension.identifier.toString();
    const args = Object.hasOwn(values, name) ? [values[name]] : [];
    parts.push(registry.createTypeUnsafe(registry.createLookupType(extension.type), args).toU8a());
  }
  parts.push(call.toU8a());
  return envelope(registry, Buffer.concat(parts));
}

// The indexer needs an exact round trip: the extrinsic hash and every later field depend on it.
function verifyExtrinsic(registry, value) {
  const bytes = registry.createType("Raw", value).toU8a();
  try {
    const ex = registry.createType("Extrinsic", bytes);
    if (ex.toHex() !== registry.createType("Raw", bytes).toHex()) {
      throw new Error("Decoded extrinsic does not round-trip to the original bytes");
    }
    if (!ex.hash.eq(registry.hash(bytes))) throw new Error("Decoded extrinsic hash differs from the original bytes");
    return { ok: true, ex, method: `${ex.method.section}.${ex.method.method}`, isSigned: ex.isSigned,
      signer: ex.isSigned ? ex.signer.toString() : null, hash: ex.hash.toHex() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { GENERAL_PREAMBLE, envelope, pipelines, encodeGeneral, verifyExtrinsic };
