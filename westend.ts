import {
  SubstrateDatasourceKind,
  SubstrateHandlerKind,
  SubstrateProject,
} from "@subql/types";

// Can expand the Datasource processor types via the genreic param
const project: SubstrateProject = {
  specVersion: "1.0.0",
  version: "0.0.1",
  name: "polkadot-starter",
  description:
    "This project can be used as a starting point for developing your SubQuery project",
  runner: {
    node: {
      name: "@subql/node",
      version: ">=3.0.1",
    },
    query: {
      name: "@subql/query",
      version: "*",
    },
  },
  schema: {
    file: "./schema.graphql",
  },
  network: {
    chainId:
      "0xe143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e",
    endpoint: ["wss://westend.api.onfinality.io/public-ws"],
    dictionary: "https://api.subquery.network/sq/subquery/westend-dictionary",
  },
  dataSources: [
    {
      kind: SubstrateDatasourceKind.Runtime,
      startBlock: 1,
      mapping: {
        file: "./dist/index.js",
        handlers: [
          {
            kind: SubstrateHandlerKind.Event,
            handler: "handleEvent",
            filter: {
              module: "proxy",
              method: "PureCreated",
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: "handleEvent",
            filter: {
              module: "proxy",
              method: "AnonymousCreated",
            },
          },
        ],
      },
    },
  ],
};

// Must set default to the project instance
export default project;
