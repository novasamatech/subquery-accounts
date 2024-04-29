# SubQuery - Indexer Project for Nova Spektr

[SubQuery](https://subquery.network) is a fast, flexible, and reliable open-source data indexer that provides you with custom APIs for your web3 project across all of our supported networks. To learn about how to get started with SubQuery, [visit our docs](https://academy.subquery.network).

## Start

First, install SubQuery CLI globally on your terminal by using NPM `npm install -g @subql/cli`

Install dependencies with `yarn install`, or `npm install`!

## Cleanup the project

To make sure you start from a clean plate, make sure you have no previous docker running or older db

```bash
# delete any docker
docker rm -f $(docker-compose ps -a -q);

# delete the local DB files and build
sudo rm -rf .data/;
sudo rm -rf dist/;
```

## Run this project

Copy one of the chain files into `project.yaml`: e.g for polkadot `cp polkadot.yaml project.yaml`

Then the simplest way to run your project is by running `yarn dev` or `npm run dev`. This does all of the following:

1.  `yarn codegen` - Generates types from the GraphQL schema definition and contract ABIs and saves them in the `/src/types` directory. This must be done after each change to the `schema.graphql` file or the contract ABIs
2.  `yarn build` - Builds and packages the SubQuery project into the `/dist` directory
3.  `docker-compose pull && docker-compose up` - Runs a Docker container with an indexer, PostgeSQL DB, and a query service. This requires [Docker to be installed](https://docs.docker.com/engine/install) and running locally. The configuration for this container is set from your `docker-compose.yml`

You can observe the three services start, and once all are running (it may take a few minutes on your first start), please open your browser and head to [http://localhost:3000](http://localhost:3000) - you should see a GraphQL playground showing with the schemas ready to query. [Read the docs for more information](https://academy.subquery.network/run_publish/run.html) or [explore the possible service configuration for running SubQuery](https://academy.subquery.network/run_publish/references.html).

## Helper script

You can also use `local-runner.sh` that will perform the above steps for you. Make sure it's executable with `chmod u+u ./local-runner.sh`.

## Query your project

For this project, you can try to query with the following GraphQL code to get a taste of how it works.

```graphql
{
  query {
    pureProxies(first: 5) {
      nodes {
        blockNumber
        id
        extrinsicIndex
      }
    }
  }
}
```

You can explore the different possible queries and entities to help you with GraphQL using the documentation draw on the right.
