# Repository Tooling

See the [diagnostic catalog](../doc/development/diagnostics.md) for what to run, when and with which inputs.
See [build/test workflows](../doc/development/podman.md) for the execution environment.

| Directory | Responsibility | Entry point |
|---|---|---|
| `diagnostics/` | Reusable RPC / GraphQL commands | `make podman-run SCRIPT=<name>.js ARGS='...'` |
| `lib/` | Logic shared by tools and tests; no import-time CLI execution | Imported by commands/tests |
| `data/` | Reviewed shared chain/spec input data | Updated via the spec scanner and review |
| `tests/` | Offline regressions; raw fixtures in `fixtures/` | `make podman-test-offline` |
| `podman/` | Container lifecycle, isolated build and replay | Makefile; `bash scripts/podman/block-test.sh` |
| `ci/` | Docker adapters for disposable CI runners | GitHub workflows |
| `db/` | Database discovery, preview, explicit destructive operations | [Database runbook](../doc/runbooks/database-wipe.md) |

The old flat `scripts/<name>.js` and SQL paths have moved into these groups.
`scripts/run-tests.sh` is now `scripts/ci/run-tests.sh`;
`scripts/run-podman-block-test.sh` is now `scripts/podman/block-test.sh`.
Use the documented paths in external automation. There are no duplicate compatibility wrappers.

Keep Makefile declarative. Add a diagnostic or offline test without adding an incident-specific Make target.
Put runtime application code in `src/` or `chainTypes/`, not in the tooling library.
