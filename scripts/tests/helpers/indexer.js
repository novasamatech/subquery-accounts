const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const projectRoot = process.env.PROJECT_ROOT || path.resolve(__dirname, "../../..");
const runtime = createRequire(path.resolve(process.env.SUBQL_ROOT || "/", "package.json"));
runtime("@subql/node-core/dist/logger").initLogger(undefined, "json", "error");
const { IndexerSandbox } = runtime("@subql/node-core/dist/indexer/sandbox");
const { decorateEvents } = runtime("@polkadot/types/metadata/decorate/events");
const { wrapExtrinsics, wrapEvents, filterExtrinsic, filterEvent } = runtime("./dist/utils/substrate");
const manifest = runtime("js-yaml").load(fs.readFileSync(path.join(projectRoot, "project-polkadot-asset-hub.yaml"), "utf8"));
const handlers = manifest.dataSources.flatMap(source => source.mapping.handlers);
const chainId = manifest.network.chainId;
const entityNames = ["Account", "AccountMultisig", "MultisigOperation", "MultisigEvent", "PureProxy", "Proxied"];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function createIndexer(registry) {
  const tables = Object.fromEntries(entityNames.map(name => [name, new Map()]));
  let writes = 0;
  function table(name) {
    assert.ok(Object.hasOwn(tables, name), `Unexpected entity ${name}`);
    return tables[name];
  }
  // Only the persistence boundary is replaced. Generated models, mappings,
  // visitor, crypto canary, manifest filters and runtime codecs are real.
  const store = {
    async get(name, id) { return clone(table(name).get(id)); },
    async set(name, id, value) {
      assert.equal(value.id, id);
      writes++;
      table(name).set(id, clone(value));
    },
    async remove(name, id) { writes++; table(name).delete(id); },
    async getByFields(name, filters, { limit = 100, offset = 0 } = {}) {
      for (const [, operator] of filters) assert.equal(operator, "=", "Unsupported test-store operator");
      return clone([...table(name).values()].filter(row => filters.every(([field, , value]) => row[field] === value))
        .slice(offset, offset + limit));
    },
  };
  const sandbox = new IndexerSandbox({ root: projectRoot, entry: "./dist/index.js", chainId, store },
    { subquery: projectRoot, timeout: 10, unsafe: false });
  sandbox.setGlobal("api", { registry, events: decorateEvents(registry, registry.metadata, 16) });

  function event(section, method, values = []) {
    const pallet = registry.metadata.pallets.find(p => p.name.toString().toLowerCase() === section.toLowerCase());
    assert.ok(pallet?.events.isSome, `Missing pallet events: ${section}`);
    const variant = registry.lookup.getSiType(pallet.events.unwrap().type).def.asVariant.variants.find(v => v.name.eq(method));
    assert.ok(variant, `Missing event: ${section}.${method}`);
    assert.equal(values.length, variant.fields.length, `${section}.${method} field count`);
    const fields = variant.fields.map((field, i) => registry.createTypeUnsafe(registry.createLookupType(field.type), [values[i]]).toU8a());
    return registry.createType("Event", Buffer.concat([Buffer.from([pallet.index.toNumber(), variant.index.toNumber()]), ...fields]));
  }

  async function dispatch(hex, events, { height = 20494728, timestamp = 1800000000, success = true } = {}) {
    const extrinsic = registry.createType("Extrinsic", hex);
    const terminal = success ? event("system", "ExtrinsicSuccess", [{}]) : event("system", "ExtrinsicFailed", ["BadOrigin", {}]);
    const records = [...events, terminal].map(e => registry.createType("EventRecord", {
      phase: { ApplyExtrinsic: 0 }, event: e.toU8a(), topics: [],
    }));
    const block = { block: { header: { number: registry.createType("BlockNumber", height) }, extrinsics: [extrinsic] },
      timestamp: new Date(timestamp * 1000), specVersion: 2005000 };
    const sources = wrapExtrinsics(block, records);
    const wrappedEvents = wrapEvents(sources, records, block);
    const invoked = [];
    for (const handler of handlers.filter(h => h.kind === "substrate/CallHandler")) {
      if (filterExtrinsic(sources[0], handler.filter)) {
        await sandbox.securedExec(handler.handler, [sources[0]]);
        invoked.push(handler.handler);
      }
    }
    for (const record of wrappedEvents) {
      for (const handler of handlers.filter(h => h.kind === "substrate/EventHandler")) {
        if (filterEvent(record, handler.filter)) {
          await sandbox.securedExec(handler.handler, [record]);
          invoked.push(handler.handler);
        }
      }
    }
    return { source: sources[0], invoked };
  }

  return { event, dispatch, store, get writes() { return writes; },
    rows(name) { return clone([...table(name).values()].sort((a, b) => a.id.localeCompare(b.id))); },
    snapshot() { return Object.fromEntries(entityNames.map(name => [name, this.rows(name)])); } };
}

module.exports = { projectRoot, runtime, chainId, entityNames, createIndexer };
