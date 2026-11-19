import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the process-level E2E suite (Issues 414 and 517).
 *
 * The suite boots disposable Postgres and Redis containers and a compiled API
 * process, so its timeouts are sized for container startup. Failing tests are
 * retried up to twice to separate transient infrastructure blips from genuine
 * deterministic failures.
 */
export default defineConfig({
  test: {
    name: "@verixa/e2e-tests",
    include: ["e2e/**/*.{spec,test}.ts"],
    retry: 2,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
