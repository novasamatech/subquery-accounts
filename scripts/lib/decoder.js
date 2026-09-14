const path = require("node:path");
const { createRequire } = require("node:module");

function dependencies(root, knownTypesRoot) {
  const from = root ? createRequire(path.resolve(root, "package.json")) : require;
  const knownFrom = knownTypesRoot ? createRequire(path.resolve(knownTypesRoot, "package.json")) : from;
  return { ...from("@polkadot/types"), ...knownFrom("@polkadot/types-known"), from, knownFrom };
}

function loadChainTypes(projectRoot, bundle, sandbox) {
  const file = path.resolve(projectRoot, "dist", `${bundle}.js`);
  if (!sandbox) return require(file).default;
  const runtime = createRequire(path.resolve(process.env.SUBQL_ROOT || "/", "package.json"));
  runtime("@subql/node-core/dist/logger").initLogger(undefined, "json", "error");
  return runtime("./dist/utils/project").loadChainTypesFromJs(file, projectRoot);
}

function createRegistry(snapshot, chainTypes = {}, deps = dependencies()) {
  const { TypeRegistry, Metadata, getSpecTypes, getSpecAlias, getSpecExtensions } = deps;
  const { specName, specVersion } = snapshot.runtimeVersion;
  const registry = new TypeRegistry();
  registry.setKnownTypes(chainTypes);
  registry.register(getSpecTypes(registry, snapshot.chain, specName, specVersion));
  registry.register(chainTypes.types || {});
  registry.knownTypes.typesAlias = getSpecAlias(registry, snapshot.chain, specName);
  registry.setMetadata(new Metadata(registry, snapshot.metadata), undefined, {
    ...getSpecExtensions(registry, snapshot.chain, specName),
    ...chainTypes.signedExtensions,
  }, true);
  return registry;
}

module.exports = { dependencies, createRegistry, loadChainTypes };
