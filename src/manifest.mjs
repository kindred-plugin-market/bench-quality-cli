// `.bench-quality.json` — the generated-state record committed next to the
// generated artifacts.
//
// It answers three questions that a bare file copy cannot:
//   - which generator version produced this tree, and with which features,
//   - what we last wrote (per-file hash / per-key value), so drift is provable,
//   - what `remove` is allowed to delete (only what we wrote).
// It deliberately contains no absolute paths, no backup locations and no host
// names: the same manifest must be valid on every clone.
import { join } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { parseJson, readTextIfExists, sha256 } from "./fsx.mjs";

export const MANIFEST_FILE = ".bench-quality.json";
export const SCHEMA_VERSION = 1;

export function manifestPath(target) {
  return join(target, MANIFEST_FILE);
}

/** Read the manifest; null when absent; CliError when present but broken. */
export async function readManifest(target) {
  const raw = await readTextIfExists(manifestPath(target));
  if (raw === null) return null;
  const value = parseJson(raw, MANIFEST_FILE);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(CODES.INVALID_MANIFEST, `${MANIFEST_FILE} must contain a JSON object`, {
      hint: "Delete it only if you accept that the next run treats the tree as a fresh installation.",
    });
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new CliError(
      CODES.INVALID_MANIFEST,
      `${MANIFEST_FILE} declares schemaVersion ${value.schemaVersion}, this CLI writes ${SCHEMA_VERSION}`,
      { hint: "Use the generator version that matches the manifest, or remove the manifest explicitly." },
    );
  }
  return value;
}

export function buildManifest({
  generator,
  features,
  profile = null,
  profiles,
  files,
  packageJson,
  workspace,
  lefthook,
  git,
  batch,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator,
    profile,
    features,
    profiles,
    files,
    packageJson,
    workspace,
    lefthook,
    git,
    batch,
  };
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Hash of the content we are about to write, keyed by repository-relative path. */
export function hashFileMap(entries) {
  const out = {};
  for (const [relPath, content] of Object.entries(entries)) out[relPath] = sha256(content);
  return out;
}

/**
 * Compare recorded hashes with what is on disk right now.
 * Returns per-path verdicts used by the plan builder and by `doctor`.
 */
export async function detectDrift(target, recorded = {}) {
  const drifted = [];
  const unchanged = [];
  const missing = [];
  for (const [relPath, recordedHash] of Object.entries(recorded)) {
    const raw = await readTextIfExists(join(target, relPath));
    if (raw === null) {
      missing.push(relPath);
    } else if (sha256(raw) === recordedHash) {
      unchanged.push(relPath);
    } else {
      drifted.push(relPath);
    }
  }
  return { drifted, unchanged, missing };
}

/** Human-readable summary used by `doctor` and by plan notes. */
export function summarizeDrift({ drifted, unchanged, missing }) {
  return {
    drifted: drifted.length,
    unchanged: unchanged.length,
    missing: missing.length,
    detail: { drifted, missing },
  };
}
