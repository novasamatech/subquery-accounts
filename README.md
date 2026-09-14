# SubQuery Accounts

Indexer for Nova Spektr: multisig accounts, proxy/pure-proxy relationships and multisig operations
across Polkadot/Substrate networks, stored in PostgreSQL and exposed through GraphQL.

Start with [AGENTS.md](AGENTS.md) for repository rules and task-oriented navigation, or browse
[the documentation](doc/README.md).

## Development

On Linux, use rootless Podman; do not install or run Node tooling on the host.

~~~bash
make podman-all
make podman-test CHAIN=polkadot-asset-hub
make help
~~~

Build artifacts stay in a named container volume. See [build and test workflows](doc/development/podman.md)
and the [diagnostic catalog](doc/development/diagnostics.md). Production deployment is separate from
these disposable development/test workflows.

## Query your project

For this project, you can try to query with the following GraphQL code to get a taste of how it works.

```graphql
{
  query {
    accounts(first: 5) {
      nodes {
        id
        address
        threshold
        isMultisig
        signatories {
          nodes {
            signatory {
              id
              address
            }
          }
        }
      }
    }
  }
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
