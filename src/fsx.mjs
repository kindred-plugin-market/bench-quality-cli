// Filesystem helpers with explicit failure semantics.
//
// Two rules drive everything here:
//   1. "missing" and "present but broken" are different outcomes — a missing
//      optional file may be created, a file that exists but cannot be parsed
//      must abort the batch untouched (never rebuilt from an empty default).
//   2. Nothing user-visible is written in place. Content lands in a sibling
//      temporary file that is then renamed onto the target path.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CODES, CliError } from "./errors.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function pathExists(pathname) {
  try {
    await access(pathname, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** `lstat` that returns null for ENOENT and rethrows anything else. */
export async function statOrNull(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Read a UTF-8 file. Returns null only when the file does not exist; I/O and
 * encoding failures propagate (ENOENT must never be conflated with EACCES,
 * EISDIR or a decode error).
 */
export async function readTextIfExists(pathname) {
  try {
    return await readFile(pathname, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function parseJson(raw, pathname) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliError(CODES.INVALID_JSON, `${pathname} is not valid JSON (${error.message})`, {
      hint: "Fix the file by hand and re-run; the generator never rewrites a broken file.",
    });
  }
}

/** JSON file → value; null when missing; CliError when present but broken. */
export async function readJsonIfExists(pathname) {
  const raw = await readTextIfExists(pathname);
  return raw === null ? null : parseJson(raw, pathname);
}

export async function ensureDir(pathname) {
  await mkdir(pathname, { recursive: true });
}

/**
 * Atomic-ish write: temp file in the destination directory, then rename. A
 * crash therefore leaves either the previous content or the new content, never
 * a half-written file.
 */
export async function writeFileAtomic(pathname, content, { mode } = {}) {
  await ensureDir(dirname(pathname));
  const tmp = join(dirname(pathname), `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await open(tmp, "wx", mode ?? 0o644);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, pathname);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Quarantine a file: move it into `destDir` (used by rollback for files this
 * batch created — the project convention is "move to trash", never `rm`).
 * Returns the destination path, or null when the source is already gone.
 */
export async function quarantineFile(pathname, destDir, relName) {
  if ((await statOrNull(pathname)) === null) return null;
  const dest = join(destDir, relName);
  await ensureDir(dirname(dest));
  try {
    await rename(pathname, dest);
    return dest;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await copyFile(pathname, dest);
    await unlink(pathname);
    return dest;
  }
}

export async function removeFile(pathname) {
  await rm(pathname, { force: true });
}
