#!/usr/bin/env node
/**
 * Manifest dependency-range validation (issue 374, lockfile-integrity gate).
 *
 * package.json dependency ranges are the only unconstrained part of the graph:
 * `^1.3.0`, `*`, `latest` and friends all resolve to different versions on
 * different resolutions, which is exactly why pnpm-lock.yaml exists. A
 * lockfile records the resolved graph, but it cannot record a range that
 * nothing pinned in the first place.
 *
 * ## Why a separate script and not a workflow step
 *
 * The check has to run as plain `node` *before* `pnpm install`, so it cannot
 * rely on the workspace being installed. Its sibling `check-lockfile-integrity.mjs`
 * contains the same `isFloatingSpecifier` grammar, which is why this script
 * imports it rather than re-declaring an overlapping shape.
 *
 * ## Scope
 *
 * Only `dependencies`, `devDependencies` and `optionalDependencies` in each
 * workspace package. `peerDependencies` are deliberately excluded: the
 * pnpm overrides in pnpm-workspace.yaml and the peer-resolution tooling in
 * `apps/api` deliberately widen the peer graph, and flagging a peer range
 * here would produce a false positive for a dependency that is resolved by
 * the host, not declared by the package.
 *
 * The check is advisory in CI (a warning, not a block): a floating range is a
 * correctness hazard in a lockfile that this gate already seals, and a
 * per-package warning keeps the contributor on the hook for the packages they
 * touched rather than blocking every walkover.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isFloatingSpecifier } from "./check-lockfile-integrity.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

function readManifest(repoRoot, relativePath) {
  const file = join(repoRoot, relativePath);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.warn(`lockfile-check: ${relativePath}: cannot parse (${error.message})`);
    return null;
  }
}

function checkManifest(manifestPath, manifest) {
  if (manifest === null) {
    return [];
  }

  const problems = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const sectionMap = manifest[section];
    if (sectionMap === undefined || typeof sectionMap !== "object") {
      continue;
    }

    for (const [name, specifier] of Object.entries(sectionMap)) {
      if (typeof specifier !== "string") {
        continue;
      }
      if (isFloatingSpecifier(specifier)) {
        problems.push(
          `${manifestPath}: ${section}["${name}"] is "${specifier}" — a floating ` +
            `range resolves to whatever the registry serves at install time, ` +
            `so the lockfile stops being a record of what was tested.`,
        );
      }
    }
  }

  return problems;
}

function main() {
  const manifests = [
    {
      dir: ".",
      manifestPath: "package.json",
      manifest: readManifest(repoRoot, "package.json"),
    },
  ];

  const workspaceFile = join(repoRoot, "pnpm-workspace.yaml");
  let workspacePatterns = [];
  let inPackages = false;
  for (const rawLine of readFileSync(workspaceFile, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (rawLine.length === rawLine.trimStart().length) {
      inPackages = line === "packages:";
      if (line.startsWith("packages:") && line !== "packages:") {
        throw new Error(`${workspaceFile}: unexpected packages line "${line}"`);
      }
      continue;
    }
    if (!inPackages) {
      continue;
    }
    if (!line.startsWith("- ")) {
      throw new Error(`${workspaceFile}: expected a packages list item, found "${line}"`);
    }
    workspacePatterns.push(line.slice(2).trim());
  }

  for (const pattern of workspacePatterns) {
    if (!pattern.endsWith("/*")) {
      continue;
    }
    const parent = pattern.slice(0, -2);
    const parentPath = join(repoRoot, parent);
    if (!existsSync(parentPath)) {
      continue;
    }
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = join(parentPath, entry.name, "package.json");
        if (existsSync(candidate)) {
          manifests.push({
            dir: `${parent}/${entry.name}`,
            manifestPath: `${parent}/${entry.name}/package.json`,
            manifest: readManifest(repoRoot, `${parent}/${entry.name}/package.json`),
          });
        }
      }
    }
  }

  const problems = [];
  for (const { manifestPath, manifest } of manifests) {
    problems.push(...checkManifest(manifestPath, manifest));
  }

  if (problems.length === 0) {
    console.log(
      `lockfile-check: manifest dependency ranges ok — ${manifests.length} workspace package(s)`,
    );
    return;
  }

  for (const problem of problems) {
    console.warn(`lockfile-check: ${problem}`);
  }
  console.error(
    `lockfile-check: ${problems.length} floating-range(s) across ${manifests.length} workspace package(s). Run pnpm install and commit the resulting pnpm-lock.yaml to pin them.`,
  );
  process.exitCode = 1;
}

main();
