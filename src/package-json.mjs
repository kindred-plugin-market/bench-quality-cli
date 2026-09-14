// package.json edits. The consumer's file is the source of truth: we only add
// what the chosen profile/features need, we never reorder or reformat unrelated
// keys, and we never overwrite a value a human already chose (dependency range
// or script command).
import { basename, join } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { parseJson, readTextIfExists } from "./fsx.mjs";

export const BASE_DEV_DEPS = { lefthook: "^2.1.14" };

export function devDepsFor(features) {
  const deps = { ...BASE_DEV_DEPS };
  for (const feature of features) Object.assign(deps, feature.deps?.dev ?? {});
  return deps;
}

export function scriptsFor({ profile, features }) {
  const scripts = { ...(profile?.scripts ?? {}) };
  for (const feature of features) Object.assign(scripts, feature.scripts ?? {});
  return scripts;
}

export function stubPackageJson(target) {
  return { name: basename(target), version: "0.0.0", private: true };
}

/** Read the managed maps from a previous manifest (flat map = pre-0.2 shape). */
export function readManagedState(previousManaged = {}) {
  const devDependencies = previousManaged.devDependencies ?? previousManaged ?? {};
  const scripts = previousManaged.scripts ?? {};
  return { devDependencies, scripts };
}

/**
 * Plan the package.json content.
 *
 * Policies:
 *   - add what the requested set needs, never reformat or reorder other keys;
 *   - a value that is present but differs from ours is preserved and reported
 *     (a pin or a script chosen by a human is never silently replaced);
 *   - a value we wrote earlier and no longer need is removed, but only while it
 *     still equals what we wrote — a human's change is never undone.
 */
export async function planPackageJson({
  target,
  requestedDeps = {},
  requestedScripts = {},
  previousManaged = {},
  previousManagedScripts = {},
  addPrepare = true,
}) {
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

  const managedDeps = {};
  const currentDeps = { ...(pkg.devDependencies ?? {}) };
  // Retire entries we own that the requested set no longer needs.
  for (const [name, range] of Object.entries(previousManaged)) {
    if (requestedDeps[name] !== undefined) continue;
    if (currentDeps[name] === undefined) continue;
    if (currentDeps[name] === range) {
      delete currentDeps[name];
      notes.push({ level: "info", message: `removed generated devDependency ${name}@${range}` });
    } else {
      notes.push({
        level: "warn",
        message: `kept devDependency ${name}@${currentDeps[name]}: it was changed since the last generated run`,
      });
    }
  }
  for (const [name, range] of Object.entries(requestedDeps)) {
    const existing = currentDeps[name];
    if (existing === undefined) {
      currentDeps[name] = range;
      managedDeps[name] = range;
      continue;
    }
    if (existing === range) {
      managedDeps[name] = range;
      continue;
    }
    const wasOurs = previousManaged[name] !== undefined;
    notes.push({
      level: "warn",
      message: `kept existing devDependency ${name}@${existing} (generated default is ${range}; ${
        wasOurs ? "changed since the last run" : "pre-existing declaration"
      })`,
    });
    if (wasOurs) managedDeps[name] = previousManaged[name];
  }

  const managedScripts = {};
  const wanted = { ...requestedScripts };
  if (addPrepare && wanted["hooks:install"]) {
    // Manage `prepare` only when it is absent (a fresh repository) or when it is
    // still the value we wrote — never when a human owns it.
    const current = pkg.scripts?.prepare;
    if (current === undefined || current === previousManagedScripts.prepare) {
      wanted.prepare = wanted["hooks:install"];
    }
  }
  const currentScripts = { ...(pkg.scripts ?? {}) };
  for (const [name, command] of Object.entries(previousManagedScripts)) {
    if (wanted[name] !== undefined) continue;
    if (currentScripts[name] === undefined) continue;
    if (currentScripts[name] === command) {
      delete currentScripts[name];
      notes.push({ level: "info", message: `removed generated script "${name}"` });
    } else {
      notes.push({ level: "warn", message: `kept script "${name}": it was changed since the last generated run` });
    }
  }
  for (const [name, command] of Object.entries(wanted)) {
    const existing = currentScripts[name];
    if (existing === undefined) {
      currentScripts[name] = command;
      managedScripts[name] = command;
      continue;
    }
    if (existing === command) {
      managedScripts[name] = command;
      continue;
    }
    const wasOurs = previousManagedScripts[name] !== undefined;
    notes.push({
      level: wasOurs ? "warn" : "info",
      message: `kept existing script "${name}" (${wasOurs ? "changed since the last run" : "owned by the repository"})`,
    });
    if (wasOurs) managedScripts[name] = previousManagedScripts[name];
  }

  const next = { ...pkg };
  if (Object.keys(currentDeps).length > 0) next.devDependencies = currentDeps;
  else delete next.devDependencies;
  if (Object.keys(currentScripts).length > 0) next.scripts = currentScripts;
  const content = `${JSON.stringify(next, null, 2)}\n`;

  return {
    content,
    changed: content !== raw,
    created,
    managed: { devDependencies: managedDeps, scripts: managedScripts },
    preserved: notes.filter((note) => note.level === "warn").map((note) => note.message),
    notes,
    devDependencies: currentDeps,
    scripts: currentScripts,
  };
}
