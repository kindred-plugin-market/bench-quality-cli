// package.json edits. The consumer's file is the source of truth: we only add
// devDependencies we need, we never reorder or reformat unrelated keys, and we
// never overwrite a version range a human already chose.
import { basename, join } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { parseJson, readTextIfExists } from "./fsx.mjs";

export const BASE_DEV_DEPS = { lefthook: "^2" };

export function devDepsFor(features) {
  const deps = { ...BASE_DEV_DEPS };
  for (const feature of features) Object.assign(deps, feature.deps?.dev ?? {});
  return deps;
}

export function stubPackageJson(target) {
  return { name: basename(target), version: "0.0.0", private: true };
}

/**
 * Plan the package.json content for the chosen features.
 *
 * `previousManaged` holds the dependency ranges recorded as ours by the last
 * run. A range that is present but differs from that record, and a range that
 * was never ours, are both preserved and reported — a version pin chosen by a
 * human is never silently replaced (that is a QG-03/policy decision, not a
 * side effect of adding hooks).
 */
export async function planPackageJson({ target, features, previousManaged = {} }) {
  const path = join(target, "package.json");
  const raw = await readTextIfExists(path);
  const notes = [];
  let pkg;
  let created = false;

  if (raw === null) {
    pkg = stubPackageJson(target);
    created = true;
    notes.push({ level: "info", message: "package.json did not exist; a minimal private one will be created" });
  } else {
    pkg = parseJson(raw, "package.json");
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
      throw new CliError(CODES.INVALID_JSON, "package.json must contain a JSON object", {
        hint: "Fix the file by hand; nothing was written.",
      });
    }
  }

  const requested = devDepsFor(features);
  const current = { ...(pkg.devDependencies ?? {}) };
  const managed = {};
  const preserved = [];

  for (const [name, range] of Object.entries(requested)) {
    const existing = current[name];
    if (existing === undefined) {
      current[name] = range;
      managed[name] = range;
      continue;
    }
    if (existing === range) {
      managed[name] = range;
      continue;
    }
    const wasOurs = previousManaged[name] !== undefined;
    preserved.push({
      name,
      existing,
      requested: range,
      reason: wasOurs ? "changed locally since the last generated run" : "already declared by the project",
    });
    notes.push({
      level: "warn",
      message: `kept existing devDependency ${name}@${existing} (generated default is ${range}; ${
        wasOurs ? "changed since the last run" : "pre-existing declaration"
      })`,
    });
    const previous = previousManaged[name];
    if (previous !== undefined) managed[name] = previous; // still ours to remove on `remove`
  }

  const next = { ...pkg };
  if (Object.keys(current).length > 0) next.devDependencies = current;
  else delete next.devDependencies;
  const content = `${JSON.stringify(next, null, 2)}\n`;

  return {
    content,
    changed: content !== raw,
    created,
    managed,
    preserved,
    notes,
    devDependencies: current,
  };
}
