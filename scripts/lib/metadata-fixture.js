// Retain SCALE IDs and discriminants while dropping unrelated pallets and documentation.
function reduceMetadata(hex, selection, { TypeRegistry, Metadata }) {
  const original = new Metadata(new TypeRegistry(), hex);
  if (original.version !== 16) throw new Error("Fixture reduction currently supports metadata v16 only");
  const metadata = original.asLatest.toJSON();
  const types = new Map(metadata.lookup.types.map(entry => [entry.id, entry]));
  metadata.pallets = metadata.pallets.filter(pallet => Object.hasOwn(selection, pallet.name));
  for (const name of Object.keys(selection)) {
    if (!metadata.pallets.some(pallet => pallet.name === name)) throw new Error(`Missing fixture pallet: ${name}`);
  }
  for (const pallet of metadata.pallets) {
    pallet.storage = null;
    pallet.constants = [];
    pallet.associatedTypes = [];
    pallet.viewFunctions = [];
    for (const kind of ["calls", "events"]) {
      const names = selection[pallet.name][kind];
      if (!names) continue;
      const variants = types.get(pallet[kind].type).type.def.variant;
      for (const name of names) {
        if (!variants.variants.some(variant => variant.name === name)) throw new Error(`Missing fixture ${pallet.name}.${name}`);
      }
      variants.variants = variants.variants.filter(variant => names.includes(variant.name));
    }
  }
  for (const id of Object.values(metadata.outerEnums)) {
    const variants = types.get(id).type.def.variant;
    variants.variants = variants.variants.filter(variant => Object.hasOwn(selection, variant.name));
  }
  metadata.apis = [];
  metadata.custom = { map: {} };
  const keep = new Set();
  function visit(id) {
    if (id === null || id === undefined || keep.has(id)) return;
    const entry = types.get(id);
    if (!entry) throw new Error(`Missing SCALE type ${id}`);
    keep.add(id);
    entry.type.params.forEach(param => visit(param.type));
    const def = entry.type.def;
    for (const field of def.composite?.fields || []) visit(field.type);
    for (const variant of def.variant?.variants || []) {
      for (const field of variant.fields) visit(field.type);
    }
    for (const id of def.tuple || []) visit(id);
    for (const kind of ["array", "sequence", "compact"]) visit(def[kind]?.type);
    visit(def.bitSequence?.bitStoreType);
    visit(def.bitSequence?.bitOrderType);
  }
  Object.values(metadata.outerEnums).forEach(visit);
  // PortableRegistry uses these generic wrappers to discover Call/Event aliases.
  for (const entry of metadata.lookup.types) {
    if (["UncheckedExtrinsic", "EventRecord"].includes(entry.type.path.at(-1))) visit(entry.id);
  }
  for (const key of ["addressType", "callType", "signatureType"]) visit(metadata.extrinsic[key]);
  for (const extension of metadata.extrinsic.transactionExtensions) {
    visit(extension.type);
    visit(extension.implicit);
  }
  for (const pallet of metadata.pallets) {
    for (const kind of ["calls", "events", "errors"]) visit(pallet[kind]?.type);
  }
  metadata.lookup.types = metadata.lookup.types.filter(entry => keep.has(entry.id));
  const stripped = JSON.parse(JSON.stringify(metadata, (key, value) => key === "docs" ? [] : value));
  return new Metadata(new TypeRegistry(), { magicNumber: 0x6174656d, metadata: { v16: stripped } }).toHex();
}

const INDEXER_SELECTION = {
  System: { calls: ["remark", "remark_with_event"], events: ["ExtrinsicSuccess", "ExtrinsicFailed", "Remarked"] },
  Utility: { calls: ["batch", "batch_all", "force_batch"] },
  Multisig: {},
  Proxy: {},
  Staking: { calls: ["payout_stakers"], events: [] },
};

function createIndexerFixture(snapshot, index, deps) {
  const extrinsic = snapshot.raw.block.extrinsics[index];
  if (extrinsic === undefined) throw new Error(`Extrinsic index ${index} is outside this block`);
  return {
    source: { chain: snapshot.chain, block: Number(snapshot.raw.block.header.number), hash: snapshot.hash,
      specVersion: snapshot.runtimeVersion.specVersion, extrinsicIndex: index,
      note: "Metadata reduced to indexer calls/events and transaction extensions; SCALE type IDs and variant indices preserved. Regenerate with debug-asset-hub-block.js --fixture." },
    extrinsic,
    extrinsicHash: new deps.TypeRegistry().hash(Buffer.from(extrinsic.slice(2), "hex")).toHex(),
    metadata: reduceMetadata(snapshot.metadata, INDEXER_SELECTION, deps),
  };
}

module.exports = { reduceMetadata, createIndexerFixture };
