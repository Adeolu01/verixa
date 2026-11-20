# Deployment Guide

This guide details the two supported production deployment paths for Verixa:

1. **Single-Host Deployment (Docker Compose):** Self-hosted or virtual machine deployment via `docker-compose.prod.yml`.
2. **Platform-as-a-Service (PaaS / Fly.io):** Managed container deployment via `infra/docker/platform.toml`.

---

## 1. Single-Host Deployment (Docker Compose)

The single-host deployment path orchestrates the full production stack on a single Linux host using Docker and Docker Compose.

### Topology

```mermaid
flowchart TD
    Internet([Incoming Traffic]) -->|Ports 80/443| Proxy["proxy (Nginx Reverse Proxy)"]
    Proxy -->|Port 3000| API["api (apps/api Production Image)"]
    API -->|Port 5432 / RLS| Postgres[("postgres (PostgreSQL 16)")]
    API -->|Port 6379| Redis[("redis (Redis 7)")]
    Migration["migration (Prisma Deploy Runner)"] -->|DDL Migration| Postgres
    Migration -.->|Completed Successfully| API
```

### Components

- **`postgres`:** PostgreSQL 16 Alpine container with persistent volume storage (`verixa-prod-postgres-data`) and initial roles configured (`infra/postgres/02-init-app-role.sh`).
- **`redis`:** Redis 7 Alpine cache and rate-limiting store with AOF persistence enabled (`verixa-prod-redis-data`).
- **`migration`:** One-off ephemeral service running `pnpm --filter @verixa/database run db:migrate:deploy`. It uses Prisma to safely apply pending database schema migrations before API containers launch.
- **`api`:** Hardened, unprivileged (UID 10001) Node.js 22 runtime built via `apps/api/Dockerfile`. Only starts after `migration` completes successfully and healthchecks pass.
- **`proxy`:** Nginx reverse proxy terminating TLS, adding security headers, and forwarding requests to `api:3000`.

### Environment Configuration

Create a secure `.env.production` file on the deployment host:

```bash
# Database Superuser / Migration credentials (DDL owner)
POSTGRES_USER=verixa
POSTGRES_PASSWORD=super-secret-postgres-password
POSTGRES_DB=verixa
DATABASE_MIGRATION_URL=postgresql://verixa:super-secret-postgres-password@postgres:5432/verixa

# Application Database credentials (Least-privilege role with RLS enforcement)
DATABASE_URL=postgresql://verixa_app:verixa_app@postgres:5432/verixa

# Redis Configuration
REDIS_PASSWORD=super-secret-redis-password
REDIS_URL=redis://:super-secret-redis-password@redis:6379

# Application Secrets
# At least 32 characters; generate with `openssl rand -base64 48`
SESSION_ACCESS_TOKEN_SECRET=replace-with-output-of-openssl-rand-base64-48
LOG_LEVEL=info

# Edge Ports
PORT_HTTP=80
PORT_HTTPS=443
```

> [!IMPORTANT]
> The API container must connect as `verixa_app`, not the PostgreSQL superuser. PostgreSQL superusers bypass Row Level Security (RLS) entirely, which would compromise tenant isolation policies.

### Launching the Stack

To build and start the entire stack:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Monitor deployment logs:

```bash
# Verify migration completed successfully
docker compose -f docker-compose.prod.yml logs migration

# Follow API runtime logs
docker compose -f docker-compose.prod.yml logs -f api
```

### Backup and Restore

Database snapshots should be created regularly before major upgrades:

```bash
# Backup database to backups/
./scripts/db-backup.sh

# Restore database from snapshot
./scripts/db-restore.sh backups/verixa_backup_YYYYMMDD_HHMMSS.sql.gz
```

---

## 2. Platform-as-a-Service (PaaS / Fly.io)

For teams leveraging managed platforms (e.g., Fly.io, Railway, Render), Verixa provides an optimized PaaS configuration manifest in `infra/docker/platform.toml`.

### Architecture

In a PaaS deployment:

- Managed PostgreSQL (e.g., Fly Postgres, Supabase, AWS RDS) is attached externally.
- Managed Redis (e.g., Upstash, Fly Redis, AWS ElastiCache) is attached externally.
- Compute is horizontally scalable with zero-downtime rolling deploys.
- Database migrations execute during the **release phase** before any traffic routes to the new containers.

### Release-Phase Migrations

`infra/docker/platform.toml` declares an automated release command:

```toml
[deploy]
  release_command = "pnpm --filter @verixa/database run db:migrate:deploy"
  strategy = "rolling"
```

When a new version is deployed:

1. The platform builds the production container using `apps/api/Dockerfile`.
2. An ephemeral machine boots and executes `release_command`.
3. If migrations succeed, the platform initiates a rolling update of the API machines.
4. If migrations fail, the deployment immediately aborts, keeping existing production machines intact.

### Setting Secrets

Configure production secrets via your platform CLI:

```bash
fly secrets set \
  DATABASE_URL="postgresql://verixa_app:password@your-postgres-host:5432/verixa" \
  DATABASE_MIGRATION_URL="postgresql://verixa:password@your-postgres-host:5432/verixa" \
  REDIS_URL="redis://:password@your-redis-host:6379" \
  SESSION_ACCESS_TOKEN_SECRET="$(openssl rand -base64 48)" \
  LOG_LEVEL="info"
```

### Deploying to Fly.io

Deploy using the reference configuration:

```bash
fly deploy --config infra/docker/platform.toml
```

### Health Checks & Rolling Restarts

The platform continuously monitors API instances via the `/health` endpoint:

```toml
[[http_service.checks]]
  interval = "10s"
  timeout = "2s"
  grace_period = "5s"
  method = "GET"
  path = "/health"
```

If a container fails health checks, traffic is diverted to healthy instances automatically.

---

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
