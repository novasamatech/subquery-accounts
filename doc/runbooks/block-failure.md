# Triage and Replay a Failing Block

[Documentation](../README.md) | [Agent Entry Point](../../AGENTS.md)

## Locate the Failure

1. Record chain, block height/hash, parent runtime spec, failing extrinsic index and the deployed image
   digest. Preserve the first error, not only retry/shutdown messages.
2. Separate infrastructure failures (RPC/dictionary HTTP errors) from deterministic SCALE decoding
   failures. A dictionary outage can coexist with an unrelated decoder error.
3. For fetch/decode failures use the [raw single-block diagnostic](../development/diagnostics.md#single-block-decode).
   Compare stock/project with the same bytes, then test a candidate dependency if appropriate.
4. If decoding passes and a handler fails, inspect event fields and earlier state using the
   [handler runbook](handlers.md) and [Kusama history](kusama-multisig.md).
5. Reproduce in the actual SubQuery runtime before accepting the fix. A standalone ApiPromise or a
   build-container test does not exercise the chainTypes/mapping VM boundary.

Known cases: [v5 Mortal era](asset-hub-v5.md), [runtime/fee asset compatibility](runtime-compatibility.md).

## Full Indexer Replay

Use this when a registry-only probe is insufficient: filters, signed origins, handlers, storage,
worker behavior or the deployed image may be involved.

~~~bash
make podman-build
timeout --signal=TERM 45s bash scripts/podman/block-test.sh project-polkadot-asset-hub.yaml 20494727 \
  --workers=1
~~~

The default uses `/work` from the build volume, not host `dist` or `node_modules`.
Pass a repository manifest basename (`project-<chain>.yaml`), not a path to another manifest.
It creates disposable PostgreSQL and a private network, generates a temporary YAML outside the
repository, rewrites each data source's start block using `js-yaml`, and mounts that file beside
the built project's bundles. Relative mapping paths remain valid. Cleanup runs on exit/signals.
There is no broad orphan cleanup at startup, so simultaneous replays do not kill one another.

SubQuery 6.4.6 has no `--stop-block` option. The examples use a 45-second wall-clock limit;
`timeout` returns 124 when that limit is reached, not a decoder verdict. Verify indexed height in
the logs. Without `timeout`, the node continues until interrupted. Use `--workers=1` for
deterministic troubleshooting. The database is empty: an operation approved at the chosen block
may require a lower start block to include its creation. Do not confuse missing fixture history
with a production regression.

## Image Parity

~~~bash
USE_IMAGE_PROJECT=1 USE_IMAGE_SPEC=1 IMAGE_PROJECT_ROOT=/project \
SUBQL_NODE_IMAGE='ghcr.io/novasamatech/subquery-accounts:<tag>@sha256:<digest>' \
timeout --signal=TERM 45s bash scripts/podman/block-test.sh project-polkadot-asset-hub.yaml 20494727 \
  --workers=1
~~~

- `USE_IMAGE_PROJECT=1`: uses bundles/dependencies inside the selected image; no workspace mount.
- `USE_IMAGE_SPEC=1`: also reads the manifest from that image; requires image-project mode.
- Without image-spec mode the source manifest comes from the current repository.
- `IMAGE_PROJECT_ROOT`: bundled project directory, default `/project`.
- `SUBQL_NODE_IMAGE`: runtime/image under test. This script still accepts the old `NODE_IMAGE`
  alias, but new commands should use the unambiguous name.
- `PG_IMAGE`: optional PostgreSQL image; otherwise builds the standard test image.
- `DB_PORT`: optional host forwarding, bound only to 127.0.0.1; not exposed by default.
- `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_SCHEMA`: disposable database settings, not production credentials.

## RPC A/B Comparison

Keep the image, start height and observation window identical; vary only the RPC.

~~~bash
ENV_FILE=/tmp/subql-rpc.env \
timeout --signal=TERM 45s bash scripts/podman/block-test.sh project-polkadot-asset-hub.yaml 20494727 \
  --workers=1
~~~

The env-file must be outside the repository, mode 0600, with `RPC_ENDPOINT_OVERRIDE`.
The temporary YAML is mode 0600, owned by the image's user via Podman's `:U` mount option, and
removed on exit. No endpoint is echoed by the wrapper, but
the indexer itself may log RPC details; treat captured runtime logs as potentially sensitive.
Direct `RPC_ENDPOINT_OVERRIDE` environment forwarding is retained for existing workflows.

## Finish an Incident

Preserve the smallest useful raw fixture, add a regression test, document the observed versions and
the exact replay command, and remove superseded temporary probes. A deterministic decoder failure
usually needs a corrected image and checkpoint resume, not a block skip or database wipe.
Only use the [database wipe procedure](database-wipe.md) for an independently justified and explicitly
approved reindexing operation.
