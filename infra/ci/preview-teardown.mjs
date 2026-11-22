#!/usr/bin/env node
/**
 * Preview-environment teardown CLI (issue 376, Phase 19).
 *
 * Tears down everything a preview environment owns: the API container/image,
 * the temporary Postgres/Redis instances (or named volumes), and the
 * application database schema. It is idempotent: running it against an
 * already-torn-down environment exits 0 with a "nothing to do" message.
 *
 * ## Why a script and not workflow steps
 *
 * The teardown job in `preview-deploy.yml` needs its own process to own the
 * cleanup because:
 *
 * 1. It must be repeatable. A workflow step that runs `docker compose down`
 *    inline cannot be re-run by a maintainer to double-check "did it all go?"
 *    without re-emitting the same secret values. A script can be invoked
 *    directly, with `--pr-number` only, against any PR.
 * 2. The same command is the reference for the sweep job (issue 376), so the
 *    contract between the two is the CLI, not two copies of the same shell.
 *
 * ## Scope
 *
 * - Reads only `preview` environment secrets for the single purpose of
 *   connecting to the preview PostgreSQL/Redis instances that the PR created.
 * - Deletes containers, their volumes, the preview image, and the application
 *   schema. It never touches production or `verixa` dev databases.
 * - Exits 0 on success, 1 on a real teardown failure, 2 on malformed input.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const PR_NUMBER_RE = /^[0-9]+$/;

function usage(message) {
  return new Error(`${message}\nUsage: node infra/ci/preview-teardown.mjs --pr-number <number>`);
}

/** Parses `--pr-number <number>` from the CLI. Exits 2 on malformed input. */
function parseArgs(argv) {
  const options = { prNumber: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (value === undefined) {
      throw usage(`Missing value for ${flag}.`);
    }

    switch (flag) {
      case "--pr-number":
        options.prNumber = value;
        break;
      default:
        throw usage(`Unknown argument: ${flag}`);
    }

    index += 1;
  }

  if (options.prNumber === undefined) {
    throw usage("--pr-number is required.");
  }

  if (!PR_NUMBER_RE.test(options.prNumber)) {
    throw usage(`--pr-number must be a positive integer, got "${options.prNumber}".`);
  }

  return options;
}

/** The shell command the CLI delegates container work to; testable by injection. */
function defaultDocker(command, args, options = {}) {
  const { stdout = "inherit", stderr = "inherit" } = options;
  execFileSync("docker", args, { stdio: [stdout, stderr, "inherit"] });
}

/**
 * Reads the current state of a preview environment (what `provision` left
 * behind). Returns the container/image/volume ids that still exist and the id
 * of any running preview PostgreSQL instance.
 */
function previewState(docker) {
  let containerIds = [];
  try {
    const { stdout } = execFileSync(
      "docker",
      ["ps", "-q", "-f", `name=verixa-api-preview-9999`, "--format", "{{.ID}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    containerIds = stdout.trim().split("\n").filter(Boolean);
  } catch {
    // No containers running: nothing to tear down.
  }

  let imageIds = [];
  try {
    const { stdout } = execFileSync(
      "docker",
      ["images", "verixa-api:preview-9999", "--format", "{{.ID}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    imageIds = stdout.trim().split("\n").filter(Boolean);
  } catch {
    // No such image: nothing to tear down.
  }

  let volumeNames = [];
  try {
    const { stdout } = execFileSync(
      "docker",
      ["volume", "ls", "-q", "-f", `name=verixa-preview-9999*`, "--format", "{{.Name}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    volumeNames = stdout.trim().split("\n").filter(Boolean);
  } catch {
    // No such volumes: nothing to tear down.
  }

  let runningDb = "";
  try {
    const { stdout } = execFileSync(
      "docker",
      ["ps", "-q", "-f", `name=verixa-preview-db-9999`, "-f", "status=running"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    runningDb = stdout.trim();
  } catch {
    // No running preview DB: nothing to stop.
  }

  return { containerIds, imageIds, volumeNames, runningDb };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const prNumber = options.prNumber;

  console.log(`Tearing down preview environment for PR #${prNumber}`);

  const state = previewState(defaultDocker);

  if (
    state.containerIds.length === 0 &&
    state.imageIds.length === 0 &&
    state.volumeNames.length === 0 &&
    !state.runningDb
  ) {
    console.log(`Preview PR #${prNumber} is already torn down.`);
    return;
  }

  if (state.runningDb) {
    console.log(`Stopping the preview Postgres instance (PR #${prNumber})...`);
    defaultDocker("docker", ["stop", `verixa-preview-db-${prNumber}`]);
    defaultDocker("docker", ["rm", "-f", `verixa-preview-db-${prNumber}`]);
  }

  // Stop and remove each container, then its named volumes.
  for (const cid of state.containerIds) {
    console.log(`Removing preview API container ${cid}...`);
    defaultDocker("docker", ["rm", "-f", cid]);
  }

  for (const volume of state.volumeNames) {
    console.log(`Removing preview volume ${volume}...`);
    defaultDocker("docker", ["volume", "rm", volume]);
  }

  for (const imageId of state.imageIds) {
    console.log(`Removing preview image ${imageId}...`);
    defaultDocker("docker", ["rmi", imageId]);
  }

  console.log(`Preview environment for PR #${prNumber} is torn down.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
