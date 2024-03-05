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
    /* The genesis hash of the network (hash of block 0) */
    chainId:
      "0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe",
    /**
     * These endpoint(s) should be public non-pruned archive node
     * We recommend providing more than one endpoint for improved reliability, performance, and uptime
     * Public nodes may be rate limited, which can affect indexing speed
     * When developing your project we suggest getting a private API key
     * If you use a rate limited endpoint, adjust the --batch-size and --workers parameters
     * These settings can be found in your docker-compose.yaml, they will slow indexing but prevent your project being rate limited
     */

    endpoint: ["wss://kusama-rpc.dwellir.com"],
    dictionary: "https://api.subquery.network/sq/subquery/dictionary-kusama",
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
