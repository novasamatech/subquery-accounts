const fs = require("node:fs");
const { load, dump } = require("js-yaml");

function prepareBlockSpec(source, startBlock, endpoint) {
  if (!/^[0-9]+$/.test(String(startBlock)) || !Number.isSafeInteger(Number(startBlock))) {
    throw new Error("start-block must be a non-negative safe integer");
  }
  let data;
  try {
    data = load(source);
  } catch {
    throw new Error("Invalid project YAML");
  }
  if (!Array.isArray(data?.dataSources) || data.dataSources.length === 0) {
    throw new Error("Project must have at least one data source");
  }
  for (let index = 0; index < data.dataSources.length; index++) {
    if (!data.dataSources[index] || typeof data.dataSources[index] !== "object") {
      throw new Error("Invalid data source");
    }
    data.dataSources[index].startBlock = Number(startBlock);
  }
  if (endpoint) {
    if (!data.network) throw new Error("Project must define network");
    data.network.endpoint = endpoint;
  }
  return dump(data, { noRefs: true, lineWidth: 120 });
}

if (require.main === module) {
  try {
    const [file, block] = process.argv.slice(2);
    process.stdout.write(prepareBlockSpec(fs.readFileSync(file, "utf8"), block, process.env.RPC_ENDPOINT_OVERRIDE));
  } catch (error) {
    console.error(error.code ? "Unable to read project spec" : error.message);
    process.exitCode = 2;
  }
}

module.exports = { prepareBlockSpec };
