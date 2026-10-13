const path = require("node:path");
const { createRequire } = require("node:module");

// Resolve the indexer's packages separately from project/candidate decoder dependencies.
function createRuntimeRequire(root = process.env.SUBQL_ROOT || "/") {
  return createRequire(path.resolve(root, "package.json"));
}

function loadRuntime(root) {
  const runtime = createRuntimeRequire(root);
  runtime("@subql/node-core/dist/logger").initLogger(undefined, "json", "error");
  return runtime;
}

module.exports = { createRuntimeRequire, loadRuntime };
