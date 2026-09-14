const path = require("node:path");
const { createRequire } = require("node:module");

// Resolve the indexer's packages separately from project/candidate decoder dependencies.
function loadRuntime(root = process.env.SUBQL_ROOT || "/") {
  const runtime = createRequire(path.resolve(root, "package.json"));
  runtime("@subql/node-core/dist/logger").initLogger(undefined, "json", "error");
  return runtime;
}

module.exports = { loadRuntime };
