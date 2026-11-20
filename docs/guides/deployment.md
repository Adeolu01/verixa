# Deployment

## Container image tags

The API image is published to
`ghcr.io/kyvera-labs/verixa` for merges to `main` and semantic version tags
(`vX.Y.Z`). Each build has a `sha-<short-sha>` reference, which is the
deployment and rollback identifier: it points to the exact source commit and
is never intentionally overwritten. `latest` follows `main` and release
tags; a release also receives its `vX.Y.Z` tag.

Use the commit tag in automated deployments. `latest` is convenient for
discovery, but moves as new code is published, so a deployment recorded only
as `latest` cannot be reproduced or rolled back reliably. Images are built for
`linux/amd64` and `linux/arm64` from the same source commit.

## Rolling back an application image

Before rolling back, select the last known-good `sha-<short-sha>` tag and
confirm the currently deployed schema remains compatible with that image.
Rollback does not run migrations in reverse. A migration that drops or
renames a column, changes data representation, or tightens a constraint can
make an older application unable to use the new schema. Follow the
expand-and-contract checklist below before deploying migrations; if backward compatibility is not established, restore
the database from a verified backup or deploy a forward fix instead of
restarting old code against an incompatible schema.

For a single Docker host, set the database URL and session secret in the
operator's environment, then run:

```bash
SESSION_ACCESS_TOKEN_SECRET='...' \
DATABASE_URL='postgres://verixa_app:...@database:5432/verixa' \
REDIS_URL='redis://redis:6379' \
API_IMAGE='ghcr.io/kyvera-labs/verixa' \
./infra/docker/scripts/rollback.sh sha-0123456
```

The script pulls the requested image, replaces the API container, and waits
for `/health`. It reports `/version` so the operator can confirm which build
is serving. It does not alter database state. Adapt the container replacement
step to the deployment platform when running Kubernetes or another scheduler;
the invariant is to point the API deployment at the selected immutable tag,
then verify health and version before declaring the rollback complete.

CI exercises this procedure with version A and B images: it starts B, selects
A with the same rollback script, and asserts that both the health response and
version response match A.

## Migration compatibility checklist

This is the rollback safety gate for schema changes (roadmap issue 394):

- Add new columns, tables, or indexes in a way old application versions ignore.
- Deploy code that can read both old and new representations before backfilling.
- Backfill in bounded, restartable batches while both code versions remain
  compatible.
- Switch reads and writes to the new representation only after the backfill
  is verified.
- Remove old columns or constraints in a later release, after no supported
  application image depends on them.
- Before a rollback, check the exact migration history and confirm the old
  image can still read and write the live schema. A destructive migration
  fails this check; do a forward fix or a separately planned data restore.

Expand-and-contract takes more than one deployment, but it preserves the
ability to roll back the application between steps. A one-shot schema rewrite
looks simpler, yet couples a code release to an irreversible database state.
