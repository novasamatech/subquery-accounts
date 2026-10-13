const { envelope, encodeGeneral } = require("../../lib/general-extrinsic");

// Model a known pipeline upgrade using real portable types, without pretending
// the target chain already advertises it. All existing target calls/IDs stay intact.
// The model prepends the reference's authorization extensions (those absent from its pipeline 0)
// to the target's own pipeline 0. People's zero-byte AuthorizeCall moves past RestrictOrigins;
// this models SCALE decoding, not execution of the reference runtime's authorization logic.
// Only authorizers are imported: a reference-only standard extension such as a different fee
// payment would also change polkadot-js v4 decoding, which uses every advertised extension.
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
  const legacy = target.extrinsic.transactionExtensionsByVersion[0];
  if (!legacy) throw new Error("Target has no pipeline 0");
  const standard = new Set(reference.extrinsic.transactionExtensionsByVersion[0]);
  const importType = typeImporter(target, reference);
  const authorizers = pipeline.filter(index => !standard.has(index)).map(index => {
    const extension = reference.extrinsic.transactionExtensions[index];
    if (target.extrinsic.transactionExtensions.some(e => e.identifier === extension.identifier)) {
      throw new Error(`Target already has ${extension.identifier}`);
    }
    target.extrinsic.transactionExtensions.push({ ...extension,
      type: importType(extension.type), implicit: importType(extension.implicit) });
    return target.extrinsic.transactionExtensions.length - 1;
  });
  target.extrinsic.transactionExtensionsByVersion[version] = [...authorizers, ...legacy];
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

// Explicitly model a reference pallet (e.g. Westend MetaTx) on a chain whose captured metadata lacks it.
function projectPallet(targetHex, referenceHex, name, { Metadata, TypeRegistry }) {
  const read = hex => new Metadata(new TypeRegistry(), hex).asLatest.toJSON();
  const target = read(targetHex);
  const reference = read(referenceHex);
  const pallet = JSON.parse(JSON.stringify(reference.pallets.find(pallet => pallet.name === name)));
  if (target.pallets.some(existing => existing.name === name || existing.index === pallet.index)) {
    throw new Error(`Target already has ${name} or its pallet index`);
  }
  const importType = typeImporter(target, reference);
  for (const kind of ["calls", "events", "errors"]) {
    if (pallet[kind]) pallet[kind].type = importType(pallet[kind].type);
  }
  target.pallets.push(pallet);
  for (const key of Object.keys(target.outerEnums)) {
    const variants = metadata => metadata.lookup.types.find(type => type.id === metadata.outerEnums[key]).type.def.variant.variants;
    const variant = JSON.parse(JSON.stringify(variants(reference).find(variant => variant.name === name)));
    variant.fields.forEach(field => { field.type = importType(field.type); });
    variants(target).push(variant);
  }
  return new Metadata(new TypeRegistry(), { magicNumber: 0x6174656d, metadata: { v16: target } }).toHex();
}

module.exports = { projectPipeline, projectPallet, envelope, encodeGeneral };
