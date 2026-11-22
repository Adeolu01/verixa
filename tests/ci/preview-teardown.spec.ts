/**
 * Preview-environment teardown gate (issue 376, Phase 19).
 *
 * The deliverable is the CLI a workflow invokes, so every case spawns it and
 * asserts on the exit code *and* the message. The real `docker` is replaced
 * on `PATH` with a recording fake, so the teardown can be exercised and
 * asserted against without a Docker daemon present.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "verixa-preview-teardown-"));
const dockerBin = join(scratch, "bin");
mkdirSync(dockerBin, { recursive: true });

// A tiny recording fake `docker` that logs every invocation to $DOCKER_LOG and
// exits 0. The teardown script shells out with execFileSync("docker", ...), so
// the fake only needs to read the env vars it was given.
writeFileSync(
  join(dockerBin, "docker"),
  "#!/bin/sh\n" + 'printf \'%s\\n\' "$*" >> "$DOCKER_LOG"\n' + "exit 0\n",
);

const DOCKER_LOG = join(scratch, "docker.log");
writeFileSync(DOCKER_LOG, "", "utf8");

// Repo root is three directories above this spec file under tests/ci.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CLI_PATH = join(REPO_ROOT, "infra", "ci", "preview-teardown.mjs");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Spawns the teardown CLI with the given extra args. Resolves the CLI from
 * the repo root so it does not depend on a module specifier.
 */
function runCli(extraArgs: readonly string[] = []) {
  return spawnSync(process.execPath, [CLI_PATH, "--pr-number", "9999", ...extraArgs], {
    encoding: "utf8",
  });
}

describe("preview-teardown", () => {
  it("exits 0 and runs no docker commands when nothing to tear down", () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readLog()).toContain("already torn down");
    expect(dockerCalls()).toEqual([]);
  });

  it("invokes docker stop/rm/rmi for the resources it owns", () => {
    writeFileSync(DOCKER_LOG, "", "utf8");
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(dockerCalls()).toEqual([
      ["stop", "verixa-preview-db-9999"],
      ["rm", "-f", "verixa-preview-db-9999"],
      ["rm", "-f", "verixa-api-preview-9999"],
      ["volume", "rm", "verixa-preview-9999-data"],
      ["rmi", "sha256:abc123"],
    ]);
  });

  it("fails on a malformed PR number", () => {
    const result = runCli(["--pr-number", "abc"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must be a positive integer");
    // Input validation happens before any docker call.
    expect(dockerCalls()).toEqual([]);
  });

  it("fails on a missing PR number", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--pr-number is required");
    expect(dockerCalls()).toEqual([]);
  });
});

/** Reads the fake docker log. */
function readLog() {
  try {
    return readFileSync(DOCKER_LOG, "utf8");
  } catch {
    return "";
  }
}

/** Returns the list of (command, arg*) invocations recorded by the fake docker. */
function dockerCalls() {
  const log = readLog();
  if (log === "") {
    return [];
  }
  return log
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
}
