# Deployment Guide

This guide documents Verixa's production deployment architecture, environment
configuration matrix, per-environment configuration templates, and container
runtime guarantees.

Verixa follows the **Twelve-Factor App** methodology: strict separation of config
from code, declarative configuration via environment variables, stateless disposable
processes with fast startup and graceful shutdown, and parity between development,
testing, staging, and production environments.

---

## Environment Configuration Matrix

The matrix below is the single source of truth for all environment variables consumed
by `@verixa/config` (defined in `packages/config/schema.ts`), as well as supplementary
runtime keys (such as `TOKEN_SIGNING_KEYS`).

Every configuration variable falls into one of two operational tiers:

1. **Plain Configuration**: Non-sensitive settings (ports, hostnames, log levels,
   timeouts, pool sizes, CORS origins). These may be stored in plain text, version-controlled
   deployment manifests, Helm values, or platform environment variables.
2. **Secrets**: Cryptographic key material, access tokens, database credentials,
   and encryption keys. **Secrets must never be stored in plain text or committed
   to source control.** In staging and production, secrets must be injected at runtime
   from a dedicated secrets manager (AWS Secrets Manager, HashiCorp Vault, Doppler,
   GCP Secret Manager, or sealed Kubernetes Secrets).

To prevent documentation drift, this matrix is continuously validated in CI by
`infra/ci/check-env-matrix.ts`. Any addition to `packages/config/schema.ts` that is
not documented in this matrix will fail the CI build.

### Configuration Matrix Table

| Variable                          | Type / Constraints                                     | Secret? | Development                                      | Test                                                  | Staging                           | Production                     | Description & Reference                                                                               |
| :-------------------------------- | :----------------------------------------------------- | :-----: | :----------------------------------------------- | :---------------------------------------------------- | :-------------------------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | `enum(development, test, production)`                  |   No    | `development`                                    | `test`                                                | `production`                      | `production`                   | Node execution environment. Governs logging verbosity, HSTS header emission, and error serialization. |
| `PORT`                            | `integer (1-65535)`                                    |   No    | `3000`                                           | `3000` (ephemeral in tests)                           | `3000`                            | `3000`                         | TCP port the Fastify HTTP server binds and listens on.                                                |
| `HOST`                            | `string`                                               |   No    | `0.0.0.0`                                        | `127.0.0.1`                                           | `0.0.0.0`                         | `0.0.0.0`                      | Network interface to bind. `0.0.0.0` inside containers; `127.0.0.1` for restricted local execution.   |
| `LOG_LEVEL`                       | `enum(trace, debug, info, warn, error, fatal, silent)` |   No    | `info` (or `debug`)                              | `silent`                                              | `info`                            | `info` (or `warn`)             | Minimum log level for Pino structured logger. `silent` in unit test runs.                             |
| `DATABASE_URL`                    | `url`                                                  |   Yes   | `postgres://verixa:verixa@localhost:5432/verixa` | `postgres://verixa:verixa@localhost:5432/verixa_test` | Injected from Secrets Manager     | Injected from Secrets Manager  | Postgres connection string. Must target unprivileged `verixa_app` role in production.                 |
| `DATABASE_POOL_SIZE`              | `integer (1-100)`                                      |   No    | `10`                                             | `5`                                                   | `10`                              | `20` (sized to replica count)  | Maximum pool connections per instance. Sized by `(peak concurrent DB requests) / (app instances)`.    |
| `DATABASE_POOL_TIMEOUT_SECONDS`   | `integer (1-300)`                                      |   No    | `10`                                             | `5`                                                   | `10`                              | `10`                           | Maximum seconds to wait for an available pool connection before shedding load with an error.          |
| `REDIS_URL`                       | `url`                                                  |   Yes   | `redis://localhost:6379`                         | `redis://localhost:6379`                              | Injected from Secrets Manager     | Injected from Secrets Manager  | Redis connection string used for session revocation deny-list (`RedisRevocationList`).                |
| `SESSION_ACCESS_TOKEN_SECRET`     | `string (min 32 chars)`                                |   Yes   | Generated locally (`openssl rand -base64 48`)    | Test dummy (`a`.repeat(32))                           | Injected from Secrets Manager     | Injected from Secrets Manager  | HMAC secret key used by `@verixa/sessions` for signing access tokens. No default in code.             |
| `SESSION_MAX_CONCURRENT_SESSIONS` | `integer (min 0)`                                      |   No    | `0` (disabled)                                   | `0` (disabled)                                        | `5`                               | `5`                            | Concurrency ceiling for simultaneous sessions per user. `0` disables session eviction.                |
| `HSTS_MAX_AGE_SECONDS`            | `integer (0-63072000)`                                 |   No    | `31536000` (inert in non-prod)                   | `31536000` (inert)                                    | `31536000` (1 year)               | `31536000` (1 year)            | `Strict-Transport-Security` max-age. Only sent when `NODE_ENV=production`. Capped at 2 years.         |
| `HSTS_INCLUDE_SUBDOMAINS`         | `boolean (true, false, 1, 0)`                          |   No    | `true`                                           | `true`                                                | `true`                            | `true`                         | Appends `includeSubDomains` to HSTS header. Requires all subdomains to serve valid TLS.               |
| `HSTS_PRELOAD`                    | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `false`                           | `false` (until submitted)      | Appends `preload` to HSTS directive. Permanent commitment to HTTPS across all domains.                |
| `ENFORCE_HTTPS`                   | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `false` (handled by LB)           | `false` (or `true` if exposed) | Issues 308 redirect for plaintext HTTP. Typically handled by edge reverse proxy / load balancer.      |
| `TRUST_PROXY`                     | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `true`                            | `true`                         | Instructs Fastify to trust `X-Forwarded-Proto` and `X-Forwarded-For` from upstream ingress/proxy.     |
| `CORS_ALLOWED_ORIGINS`            | `comma-separated urls or *`                            |   No    | `""` (empty denies all)                          | `""`                                                  | `https://staging-app.example.com` | `https://app.example.com`      | Allowlist of origins permitted for cross-origin browser requests. `*` forbidden with credentials.     |
| `CORS_ALLOW_CREDENTIALS`          | `boolean (true, false, 1, 0)`                          |   No    | `false`                                          | `false`                                               | `false`                           | `false`                        | Emits `Access-Control-Allow-Credentials: true`. Refused when `CORS_ALLOWED_ORIGINS` is `*`.           |
| `MFA_ENFORCEMENT_LEVEL`           | `enum(required, optional, disabled)`                   |   No    | `optional`                                       | `optional`                                            | `optional`                        | `required`                     | Global baseline MFA enforcement. Tenant and user overrides take precedence at runtime.                |
| `MFA_ALLOWED_METHODS`             | `comma-separated methods`                              |   No    | `totp,webauthn,backup-codes`                     | `totp,webauthn,backup-codes`                          | `totp,webauthn,backup-codes`      | `totp,webauthn,backup-codes`   | Permitted MFA factors globally. Restrict e.g. to `webauthn` for phishing-resistant factor mandates.   |

---

## Environment-Specific Configuration Templates

Verixa provides explicit, environment-specific configuration templates to eliminate
first-run setup friction and prevent cross-environment misconfigurations:

- **`.env.example`** (Local Development):
  Configured for developer ergonomics out of the box with `docker compose up`. Points
  to local Postgres and Redis instances. All secrets use clear placeholder values with
  instructions for generating local development keys with `openssl`.
- **`.env.test.example`** (Local & CI Testing):
  Configured for automated test runs. Points to isolated databases (`verixa_test`) so
  running tests never mutates development state. Log level is set to `silent` to avoid
  cluttering test runner output.
- **`.env.staging.example`** (Pre-Production Staging):
  Mirrors production security settings (`NODE_ENV=production`, strict TLS, `TRUST_PROXY=true`,
  explicit CORS allowlists). References secret-manager paths for credentials rather than
  embedding real secrets.
- **`.env.production.example`** (Production Deployments):
  Hardened production configuration template. High-entropy signing keys, strict CORS,
  mandatory MFA baselines, and secret-manager placeholder references.

### Placeholder Substitution Rules

Templates in source control use standardized placeholders for sensitive values:

- `SESSION_ACCESS_TOKEN_SECRET`: `change-this-to-a-secure-random-secret-at-least-32-chars`
- `DATABASE_URL`: `postgres://<db_user>:<db_password>@<db_host>:5432/<db_name>`
- `REDIS_URL`: `redis://:<redis_password>@<redis_host>:6379`
- `TOKEN_SIGNING_KEYS`: `[{"kid":"key-id","algorithm":"RS256","publicKey":"<SPKI PEM>","privateKey":"<PKCS#8 PEM>","current":true}]`

In automated deployment pipelines, CI checks (`tests/integration/env-templates.spec.ts`)
verify that every template parses successfully through the Zod schema when placeholder
values are loaded, guaranteeing templates never drift from schema definitions.

---

## Graceful Shutdown & Container Signal Handling

In modern cloud orchestration (Kubernetes, AWS ECS, Nomad, Docker Swarm), zero-downtime
deployments require application processes to shut down gracefully when a container
is stopped or replaced:

```
[Orchestrator] -- SIGTERM --> [apps/api (PID 1)]
                                  │
                                  ├─ 1. Stop accepting new connections
                                  ├─ 2. Complete active in-flight requests
                                  ├─ 3. Flush audit write queues
                                  ├─ 4. Disconnect Prisma & Redis pools
                                  └─ 5. Exit cleanly with code 0
```

### The PID 1 Problem in Containers

In Linux containers, the entrypoint process is assigned **PID 1**.
PID 1 has special kernel semantics:

1. **Signal Swallowing**: Unlike ordinary processes, PID 1 does not receive default
   signal handlers for `SIGTERM` or `SIGINT`. If a Node.js application running as PID 1
   does not explicitly register a signal listener (`process.on('SIGTERM', ...)`),
   the kernel discards the signal.
2. **The Shell Wrapper Pitfall**: If a Dockerfile specifies shell form:
   ```dockerfile
   # ANTI-PATTERN: Spawns /bin/sh -c
   CMD node dist/server.js
   ```
   `/bin/sh` runs as PID 1, and `node` runs as a child process. Standard shells do not
   forward signals to child processes. When the orchestrator sends `SIGTERM`, `/bin/sh`
   swallows it; Node never sees the signal, continues handling traffic unaware, and is
   eventually killed abruptly with `SIGKILL` after the stop timeout.

Verixa eliminates this problem by using exec-form `ENTRYPOINT` in `apps/api/Dockerfile`:

```dockerfile
ENTRYPOINT ["node", "dist/server.js"]
```

This guarantees `node` is PID 1 directly, with no shell process interposed.

### Bounded Grace Period & Connection Draining

When `SIGTERM` or `SIGINT` is received, `apps/api` executes a coordinated shutdown sequence
managed by `createShutdownHandler` in `apps/api/src/server.ts`:

1. **Re-entrancy Protection**: Duplicate signals received while shutdown is already in
   progress are ignored.
2. **Bounded Grace Period (`DEFAULT_SHUTDOWN_TIMEOUT_MS = 10,000`)**:
   A fail-safe timer (10 seconds, matching Docker's default stop timeout) is initialized.
   If in-flight requests or network teardowns hang, the timer triggers `process.exit(1)`
   to prevent zombie container hangs.
3. **HTTP Server Draining**: `app.close()` stops the Fastify HTTP server from accepting
   new TCP connections and allows in-flight requests to complete.
4. **Storage & Queue Draining**: `container.dispose()` flushes any pending entries in
   `BatchedAuditWriter` to prevent data loss and disconnects Prisma (`prisma.$disconnect()`).
5. **Clean Exit**: Once all teardown steps complete, the timer is cleared and the process
   exits with code 0.
