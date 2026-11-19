# End-to-end suite

The unit and integration suites call application objects in the same process.
That is fast and useful, but it cannot catch failures in environment parsing,
process startup, listener binding, or the real HTTP boundary. `tests/e2e/`
starts the compiled API as a child process and sends requests over HTTP while
disposable Postgres and Redis containers provide the same services a
deployment expects.

Run the suite after building the workspace:

```bash
pnpm build
pnpm --filter @verixa/integration-tests run test:e2e
```

Docker must be available. The harness applies the checked-in database
migrations to its fresh PostgreSQL instance before starting the server, waits
for `/health`, and always stops the process and containers after the suite.
It does not reuse a developer's compose database: disposable state makes the
suite repeatable and prevents a test from damaging local data.

The first test is deliberately a small health and version round trip. It
proves that the server really started and that requests crossed the network;
it is the prerequisite check for adding broader flows. The test runner excludes
`tests/e2e` from ordinary `pnpm test`, because silently skipping this suite
without Docker would claim integration confidence it did not earn. CI runs it
in a dedicated Docker-enabled job instead.

The alternative — starting Fastify in-process as the integration suite does —
is quicker, but it skips the config and child-process boundary that makes this
suite useful. Keep the E2E set small and reserve business-rule coverage for
faster tests below it in the test pyramid.
