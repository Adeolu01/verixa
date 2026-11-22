# Preview environments

Issue 488, Phase 19 — CI/CD & DevOps Automation.

## Why ephemeral infrastructure needs an explicit teardown

A preview environment is temporary by definition, but that does not make it
disposable. The entire point of a preview is that a fork PR can reach it and a
contributor can push six times, each push rebuilding the same environment with
fresh runner minutes. If teardown only runs when the CI event fires, that
cost is unbounded: force-deleted branches, cancelled workflows in other
accounts, runners that exceeded their timeout, and merged-but-not-deployed
PRs all leave environments behind that keep consuming runner minutes, live in
DNS, and remain reachable from the internet.

Trigger-based cleanup alone silently fails when the triggering event itself
does not fire. A workflow that runs on `pull_request: closed` cannot clean up a
branch someone force-deleted, or a workflow that timed out and was still
"running" at load balancer level. Once the triggering event does not fire, the
only thing that _will_ clean up the environment is a job that finds stale
environments by reference rather than by event.

That is why this phase has two, deliberately redundant, cleanup paths: a
trigger-based teardown and a scheduled sweep. The two are the failure modes
for each other.

## Lifecycle

```
open  PR  ->  provision job  ->  preview environment  -
                                                                v
closed PR / merge -> teardown job (preview-env) <-  sweep (every 6h) ----
```

1. **Provision.** On `pull_request.open`, `provision` builds and deploys a
   disposable preview, selects the `preview` environment, and records the
   environment reference. Because `provision` re-runs whenever the head ref
   changes, pushing to an open PR rebuilds the same environment rather than
   queuing builds.
2. **Wait.** A reviewer opens the PR's checks: the preview endpoint is healthy,
   and a `preview` status is reported.
3. **Old env grows.** While the PR sits open, `preview-sweep.yml` runs every six
   hours and finds any environment that has survived more than the TTL without
   being torn down by `provision`'s cleanup.
4. **Close.** On `pull_request.closed`, `teardown` holds `preview` environment
   secrets just long enough to reach every resource `provision` left behind,
   deletes them all, and rotates the preview signing secret so a leaked value
   expires on close.
5. **Sweep backstop.** `preview-sweep.yml` periodically runs the same teardown
   CLI, idempotently, against any environment that survived. It alerts on
   repeated failure so a teardown that keeps failing is visible instead of
   silently exiting 0.

## What teardown removes

Teardown is not "delete the compute". It removes every resource the preview
environment owns, in one process with a single contract, so no orphan survives:

| Resource                   | How it is removed                                  |
| -------------------------- | -------------------------------------------------- |
| Preview API image          | `docker rmi sha256:...`                            |
| Preview API containers     | `docker rm -f verixa-api-preview-<pr>`             |
| Preview database volumes   | `docker volume rm verixa-preview-<pr>-data`        |
| Preview Postgres container | `docker stop` + `docker rm verixa-preview-db-<pr>` |
| Redis namespace            | `docker rm -f verixa-preview-redis-<pr>`           |

`infra/ci/preview-teardown.mjs` performs exactly this, and it is the single
reference the deploy and the sweep both invoke so that the contract is one CLI
rather than two copies of the same shell.

## Teardown API

```
node infra/ci/preview-teardown.mjs --pr-number <number>
```

Idempotent. If nothing the workflow provisioned is still present it exits 0 and
prints `Preview PR <n> is already torn down.` It fails (exit 1) on a real
failure, and exits 2 on malformed input, so a sweep script can distinguish
"nothing to do", "could not clean up", and "the caller passed bad arguments".

## Alternatives rejected

- **Delete the resource group wholesale.** A deleted resource group cannot be
  updated; deleting a whole group is not idempotent, and a sweep that did this
  would fail every rerun and alert on forever. Narrow resource deletion is the
  only shape that can be made idempotent, which is the definition of a
  backstop that must not be gated on one-off events.
- **Teardown only, no sweep.** The two are not interchangeable. A teardown job
  that stops firing leaves resources orphaned forever; a sweep that does not
  tear down is a list, not a cleanup.
- **Alerts only on teardown failure.** A sweep that fails but never alerts is a
  backstop that cannot report its own failure. The sweep alerts on repeated
  failure, so a broken teardown is visible in the same channel that would
  surface a real credential leak, not in a perfectly quiet log.
