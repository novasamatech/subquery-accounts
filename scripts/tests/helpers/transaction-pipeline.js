// Model a known pipeline upgrade using real portable types, without pretending
// the target chain already advertises it. All existing target calls/IDs stay intact.
function projectPipeline(targetHex, referenceHex, version, { Metadata, TypeRegistry }) {
  const read = hex => {
    const metadata = new Metadata(new TypeRegistry(), hex);
    if (metadata.version !== 16) throw new Error("Pipeline projection requires metadata v16");
    return metadata.asLatest.toJSON();
  };
  const target = read(targetHex);
  const reference = read(referenceHex);
  const pipeline = reference.extrinsic.transactionExtensionsByVersion[version];
  if (!pipeline) throw new Error(`Reference has no pipeline ${version}`);
  if (target.extrinsic.transactionExtensionsByVersion[version]) throw new Error(`Target already has pipeline ${version}`);
  const importType = typeImporter(target, reference);
  target.extrinsic.transactionExtensionsByVersion[version] = pipeline.map(index => {
    const extension = reference.extrinsic.transactionExtensions[index];
    const existing = target.extrinsic.transactionExtensions.findIndex(e => e.identifier === extension.identifier);
    if (existing !== -1) return existing;
    target.extrinsic.transactionExtensions.push({ ...extension,
      type: importType(extension.type), implicit: importType(extension.implicit) });
    return target.extrinsic.transactionExtensions.length - 1;
  });
  return new Metadata(new TypeRegistry(), { magicNumber: 0x6174656d, metadata: { v16: target } }).toHex();
}

function typeImporter(target, reference) {
  const types = new Map(reference.lookup.types.map(entry => [entry.id, entry]));
  const imported = new Map();
  for (const key of ["addressType", "callType", "signatureType"]) {
    imported.set(reference.extrinsic[key], target.extrinsic[key]);
  }
  let next = Math.max(...target.lookup.types.map(entry => entry.id)) + 1;
  function importType(id) {
    if (id == null) return id;
    if (imported.has(id)) return imported.get(id);
    if (!types.has(id)) throw new Error(`Missing reference type ${id}`);
    const entry = JSON.parse(JSON.stringify(types.get(id)));
    entry.id = next++;
    imported.set(id, entry.id);
    target.lookup.types.push(entry);
    entry.type.params.forEach(param => { param.type = importType(param.type); });
    const fields = values => values.forEach(field => { field.type = importType(field.type); });
    const def = entry.type.def;
    fields(def.composite?.fields || []);
    for (const variant of def.variant?.variants || []) fields(variant.fields);
    if (def.tuple) def.tuple = def.tuple.map(importType);
    for (const kind of ["array", "sequence", "compact"]) {
      if (def[kind]) def[kind].type = importType(def[kind].type);
    }
    if (def.bitSequence) {
      def.bitSequence.bitStoreType = importType(def.bitSequence.bitStoreType);
      def.bitSequence.bitOrderType = importType(def.bitSequence.bitOrderType);
    }
    return entry.id;
  }
  return importType;
}

// Explicitly model the Westend pallet on a chain whose captured metadata lacks it.
function projectMetaTx(targetHex, referenceHex, { Metadata, TypeRegistry }) {
  const read = hex => new Metadata(new TypeRegistry(), hex).asLatest.toJSON();
  const target = read(targetHex);
  const reference = read(referenceHex);
  const pallet = JSON.parse(JSON.stringify(reference.pallets.find(pallet => pallet.name === "MetaTx")));
  if (target.pallets.some(existing => existing.name === "MetaTx" || existing.index === pallet.index)) {
    throw new Error("Target already has MetaTx or its pallet index");
  }
  const importType = typeImporter(target, reference);
  for (const kind of ["calls", "events", "errors"]) pallet[kind].type = importType(pallet[kind].type);
  target.pallets.push(pallet);
  for (const key of Object.keys(target.outerEnums)) {
    const variants = metadata => metadata.lookup.types.find(type => type.id === metadata.outerEnums[key]).type.def.variant.variants;
    const variant = JSON.parse(JSON.stringify(variants(reference).find(variant => variant.name === "MetaTx")));
    variant.fields.forEach(field => { field.type = importType(field.type); });
    variants(target).push(variant);
  }
  return new Metadata(new TypeRegistry(), { magicNumber: 0x6174656d, metadata: { v16: target } }).toHex();
}

function envelope(registry, data) {
  return Buffer.concat([registry.createType("Compact<u32>", data.length).toU8a(), data]);
}

// Encode directly from metadata, independently of the decoder under test.
// These are SCALE test vectors, not cryptographically authorized transactions.
function encodeGeneral(registry, version, values, call) {
  const metadata = registry.metadata.extrinsic;
  const pipeline = [...metadata.transactionExtensionsByVersion].find(([v]) => v.eq(version));
  if (!pipeline) throw new Error(`Unknown test pipeline ${version}`);
  const parts = [Buffer.from([0x45, version])];
  for (const index of pipeline[1]) {
    const extension = metadata.transactionExtensions[index.toNumber()];
    const name = extension.identifier.toString();
    const args = Object.hasOwn(values, name) ? [values[name]] : [];
    parts.push(registry.createTypeUnsafe(registry.createLookupType(extension.type), args).toU8a());
  }
  parts.push(call.toU8a());
  return envelope(registry, Buffer.concat(parts));
}

module.exports = { projectPipeline, projectMetaTx, envelope, encodeGeneral };
