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
      "0xfe58ea77779b7abda7da4ec526d14db9b1e9cd40a217c34892af80a9b332b76d",
    chaintypes: {
      file: "./dist/moonbeamChaintypes.js",
    },
    endpoint: ["wss://moonbeam.api.onfinality.io/public-ws"],
    dictionary: "https://api.subquery.network/sq/subquery/moonbeam-dictionary",
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
