// Template access. Read-only on purpose: writing into the consumer repo is the
// job of the plan/apply pair, which knows about backups, drift and journals.
// The templates directory ships inside the package (`files` in package.json),
// so a consumer never depends on the generator repository being present.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CODES, CliError } from "./errors.mjs";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATES_DIR = join(PACKAGE_ROOT, "templates");

/** All file entries declared by the chosen features, in registry order. */
export function filesForFeatures(features) {
  const files = [];
  for (const feature of features) {
    for (const file of feature.files ?? []) files.push({ ...file, feature: feature.id });
  }
  return files;
}

/** Raw template content (text). Throws instead of silently creating an empty file. */
export async function readTemplate(relFrom) {
  const path = join(TEMPLATES_DIR, relFrom);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new CliError("TEMPLATE_MISSING", `template ${relFrom} could not be read (${error.code ?? error.message})`, {
      hint: "The installation is incomplete; reinstall bench-quality-cli from a verified tarball.",
    });
  }
}
