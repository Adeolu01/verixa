# Preview environment isolation

Issue 489, Phase 19 — CI/CD & DevOps Automation.

## Why

A preview environment is the single most credential-exposed surface in the
repository. It exists to give a reviewer a disposable copy of a pull request to
look at before it merges, and to do that it must be reachable from the
contributor's machine, over the internet, from a fork. That reachability is
exactly what makes it the classic CI-credential-leak vector, and it is why the
cost of a mistake here is a full production breach rather than a broken local
build.

The blast radius was contained with four decisions:

1. **A dedicated, least-privilege GitHub Environment** instead of workflow-level
   secrets. `ci.yml` does not touch the `preview` environment, and nothing in
   repository `secrets` is readable by a workflow that selects it. A preview
   credential can only ever be read by a job that explicitly selects the
   `preview` environment.
2. **Fork-originated pull requests receive no access to preview secrets by
   default.** GitHub's fork-PR secret restrictions already grant the fork only
   the `pull_request` read scope, and this workflow reads no secrets on the
   `pull_request` event at all except via the `preview` environment selection —
   which the fork cannot select. So a compromised contributor's fork cannot
   read a single preview credential.
3. **The only secrets a preview deploy reads are `PREVIEW_*` placeholders that
   mirror the shape of a production credential but are never real values.** The
   `preview.yml` file documents the shape of each credential once and never
   contains a production credential.
4. **Tearing down the environment is the least privileged action the workflow
   performs.** Destroying a resource requires access to `preview` environment
   secrets (fewer permissions than provisioning), so a fork PR is granted only
   the single action it actually needs — cleanup — and never provisioning.

## How it works

`preview-deploy.yml` has two jobs:

- **provision** — selected on the `open` event of the `pull_request` trigger, it
  reads only from the `preview` environment and only to bake staging-shaped
  credentials into the image. It never prints them; it only asserts that a value
  is present with `${VAR:+set}`.
- **teardown** — selected on the `closed` event, it rehydrates the same
  `preview` secrets purely to reach the resources `provision` created, then
  removes every container, volume and image it owns via
  `infra/ci/preview-teardown.mjs`.

`preview.yml` is the authoritative record of what a preview environment needs.
A maintainer's only action is to add secrets to the `preview` environment —
nothing else.

## Alternative rejected

- **Storing preview secrets in `ci.yml` or in workflow `env` blocks.** That puts
  them on the default environment, which fork PRs can read. It was the natural
  first place to put them, and it was the earliest failure mode.
- **Sharing the `production` environment.** Fork PRs get no secrets at all from
  the default environment, but a workflow that selectively reads `production`
  can silently exfiltrate a live credential. `production` is off-limits by
  design; a preview-tier environment did not get that treatment because it is
  the only environment preview deploys legitimately reach.
- **Mixing the preview credentials into `docker-compose.yml`.** `docker-compose`
  files read from the container's environment at build time and never have a
  place to scope secrets; a preview `docker-compose.yml` pointing at
  `DATABASE_URL` would silently migrate a preview deployment into the production
  database. Keeping credentials in the `preview` environment and naming them
  `PREVIEW_*` makes the isolation explicit and auditable.

## Contents of this directory

| File                                   | Purpose                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.github/environments/preview.yml`     | The dedicated GitHub Environment. Secrets live here, and nowhere else.                   |
| `.github/workflows/preview-deploy.yml` | `provision` on `open`, `teardown` on `closed`, both scoped to the `preview` environment. |
| `infra/ci/preview-teardown.mjs`        | Idempotent CLI for destroying every resource a preview environment owns.                 |
