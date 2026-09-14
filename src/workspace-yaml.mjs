// pnpm-workspace.yaml managed keys.
//
// pnpm 12 fails an install with ERR_PNPM_IGNORED_BUILDS as soon as a dependency
// declares a build script that was not approved, and lefthook's postinstall
// would install its own hooks over `.husky`. Consumers therefore need
// `allowBuilds.lefthook: false` — a small, reviewable key that the generator
// owns and keeps, while every other key stays exactly as the human wrote it.
import { join } from "node:path";
import { CORE_SCHEMA, dump, load, mergeTag } from "js-yaml";

import { CODES, CliError } from "./errors.mjs";
import { readTextIfExists } from "./fsx.mjs";

export const WORKSPACE_FILE = "pnpm-workspace.yaml";
const HEADER = "# Managed keys below are owned by bench-quality-cli (init/update).\n";

function parseWorkspace(raw, pathname) {
  if (raw.trim() === "") throw new CliError(CODES.EMPTY_EXISTING_LEFTHOOK_CONFIG, `${pathname} exists but is empty`);
  let doc;
  try {
    doc = load(raw, { schema: CORE_SCHEMA.withTags(mergeTag) });
  } catch (error) {
    throw new CliError(CODES.INVALID_YAML, `${pathname} is not valid YAML (${String(error.message).split("\n")[0]})`, {
      hint: "Fix the file by hand and re-run; nothing was written.",
    });
  }
  if (doc === null || doc === undefined) {
    throw new CliError(CODES.EMPTY_EXISTING_LEFTHOOK_CONFIG, `${pathname} contains no YAML document`);
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new CliError(CODES.INVALID_YAML, `${pathname} must contain a YAML mapping`);
  }
  return doc;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Add the profile's keys without ever overwriting a human's value.
 * `previousManaged` are the key paths we wrote last time (dotted notation).
 */
export async function planWorkspaceYaml({ target, workspaceKeys, previousManaged = {} }) {
  const pathname = join(target, WORKSPACE_FILE);
  const raw = await readTextIfExists(pathname);
  const notes = [];
  const managed = { ...previousManaged };
  const doc = raw === null ? {} : parseWorkspace(raw, WORKSPACE_FILE);
  let changed = raw === null;

  // Retire keys we own that the requested set no longer needs, but only while
  // their value is still exactly what we wrote.
  for (const [key, recorded] of Object.entries(previousManaged)) {
    if (workspaceKeys && key in workspaceKeys) continue;
    if (doc[key] === undefined) continue;
    if (JSON.stringify(doc[key]) === JSON.stringify(recorded)) {
      delete doc[key];
      delete managed[key];
      changed = true;
      notes.push({ level: "info", message: `removed generated ${WORKSPACE_FILE} key "${key}"` });
    } else {
      notes.push({
        level: "warn",
        message: `kept ${WORKSPACE_FILE} key "${key}": it was changed since the last generated run`,
      });
      managed[key] = recorded;
    }
  }

  for (const [key, value] of Object.entries(workspaceKeys ?? {})) {
    const current = doc[key];
    if (current === undefined) {
      doc[key] = isPlainObject(value) ? { ...value } : value;
      managed[key] = doc[key];
      changed = true;
      continue;
    }
    if (JSON.stringify(current) === JSON.stringify(value)) {
      managed[key] = value;
      continue;
    }
    notes.push({
      level: "warn",
      message: `kept existing ${WORKSPACE_FILE} key "${key}" (generated default differs${
        previousManaged[key] ? "; it was changed since the last run" : ""
      })`,
    });
    if (previousManaged[key] !== undefined) managed[key] = previousManaged[key];
  }

  const content = raw === null || changed ? `${HEADER}${dump(doc, { lineWidth: -1, noRefs: true, quoteStyle: "double" })}` : raw;
  return { content, changed: content !== raw, managed, notes, existed: raw !== null };
}
