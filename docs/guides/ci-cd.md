# CI/CD

## Continuous Integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: install → build → lint → format check → typecheck → test.

It intentionally runs the _exact same commands_ a contributor runs locally
(`pnpm lint`, `pnpm typecheck`, `pnpm test`, ...) rather than reimplementing
equivalent logic as inline CI script. This matters for two reasons:

1. **"Works on my machine, fails in CI" becomes structurally impossible** for
   these checks — if `pnpm lint` passes locally, it passes in CI, because
   it's the same command against the same config, not a CI-specific
   variant that could drift out of sync.
2. **The local pre-commit hook (Issue 009) and CI are the same gate at two
   different points in time** — the hook is a fast local preview, CI is the
   actual, unbypassable enforcement (see `CONTRIBUTING.md`'s "Local git
   hooks" section for that distinction).

### Build-first ordering

`pnpm build` runs before every other check, even lint. TypeScript's module
resolution happens to fall back to a dependency's raw `.ts` source and still
typecheck successfully when that dependency hasn't been built yet (see
`docs/guides/typescript-conventions.md`) — but that fallback only applies to
a package's `main`/`types` field, which supports the classic Node
directory-index fallback. It does **not** apply to `package.json` `exports`
subpaths: `apps/api` exposes `buildApp` via `"./app": "./dist/app.d.ts"`
(Issue 015, so `tests/` can boot the app in-process without triggering
`server.ts`'s side effects), and `exports` resolution is exact — if
`dist/app.d.ts` doesn't exist, resolution fails outright instead of falling
back to source. The first time that happened, it didn't surface as a clean
"module not found" either: ESLint's type-aware rules silently treated the
unresolved import as `any`, which cascaded into nine unrelated-looking
`no-unsafe-*` errors on the very next line that touched it. `pnpm test` has
no fallback either way — Vitest doesn't transform `node_modules` packages, so
a test importing `@verixa/config` needs its real, built `dist/index.js`, or
it fails with `ERR_MODULE_NOT_FOUND`. Building first, unconditionally, before
_anything_ else runs, keeps CI correct regardless of which check happens to
tolerate a missing build and which doesn't — and regardless of whether a
future check's failure mode on a missing build is an obvious error or a
confusing cascade of unrelated ones.

### `pnpm` caching

`actions/setup-node`'s `cache: pnpm` step caches the pnpm store keyed on
`pnpm-lock.yaml`, so `pnpm install --frozen-lockfile` is fast on unchanged
dependencies instead of re-downloading the whole dependency tree on every
run.

## Continuous Delivery

Verixa's deployment and release pipeline extends Continuous Integration into an automated delivery pipeline:

1. **Conventional Commits & Semantic Versioning:** Commit titles enforce the Conventional Commits specification. On merge to `master`, `semantic-release` automatically calculates the next semantic version, produces formatted `CHANGELOG.md` updates, tags the repository, and creates GitHub Releases.
2. **Container Image Publishing:** Hardened multi-stage Docker builds produce production images tagged by commit SHA (`sha-<short>`), release version (`vX.Y.Z`), and `latest`. Multi-architecture builds (`linux/amd64` and `linux/arm64`) are compiled via Buildx Bake and published to the GitHub Container Registry (`ghcr.io`).
3. **Automated Dependency Updates & Auto-Merge:** Renovate proposes grouped dependency upgrades. Non-breaking patch and minor updates that pass all CI suites and do not touch sensitive security/crypto packages are merged automatically, keeping dependencies current while preserving human review for sensitive updates.
4. **Ephemeral Preview Environments:** Pull requests deploy isolated ephemeral instances of `apps/api` with dedicated backing services. Environments use scoped credentials from the `preview` GitHub Environment and are automatically torn down when the PR is closed or merged.

For a full, end-to-end educational walkthrough of how a commit traverses every stage of the pipeline, see [Building an End-to-End CI/CD Pipeline](tutorials/building-a-cicd-pipeline.md).
