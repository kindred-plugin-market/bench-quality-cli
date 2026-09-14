// Per-repository generator state: mutual exclusion, write-ahead journal and
// batch backups.
//
// Everything lives in the repository's shared git directory by default
// (`<git-common-dir>/bench-quality-cli/`), so:
//   - it can never be committed by accident (tracked files stay generator-free),
//   - two linked worktrees of the same clone share one lock,
//   - `--state-dir` can still point it at an external location when the caller
//     wants the durability to live outside the checkout.
import { copyFile, open, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { ensureDir, readJsonIfExists, statOrNull } from "./fsx.mjs";

export const STATE_DIRNAME = "bench-quality-cli";
export const LOCK_FILE = "lock.json";
export const JOURNAL_FILE = "journal.json";
export const BACKUP_DIRNAME = "backups";

export function resolveStateDir({ gitCommonDir, stateDir }) {
  if (stateDir) return resolve(stateDir);
  if (!gitCommonDir) {
    throw new CliError(CODES.GIT_REPO_REQUIRED, "no state directory could be derived", {
      hint: "Pass --state-dir explicitly when the target is not a git repository.",
    });
  }
  return join(gitCommonDir, STATE_DIRNAME);
}

export function backupDirFor(stateDir, batchId) {
  return join(stateDir, BACKUP_DIRNAME, batchId);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function readLock(stateDir) {
  return readJsonIfExists(join(stateDir, LOCK_FILE));
}

/** Classify an existing lock: none / self / alive / stale / foreign host. */
export function classifyLock(lock, { pid = process.pid, host = hostname() } = {}) {
  if (!lock) return { state: "none" };
  if (lock.pid === pid && lock.host === host) return { state: "self", lock };
  if (lock.host !== host) return { state: "foreign", lock };
  return isAlive(lock.pid) ? { state: "alive", lock } : { state: "stale", lock };
}

/**
 * Take the repository lock. Never steals: an existing lock is reported with its
 * owning process, and a stale lock must be cleared explicitly (see clearLock)
 * so recovery can first prove the interrupted batch is rollback-safe.
 */
export async function acquireRepoLock(stateDir, { target, command, batchId }) {
  await ensureDir(stateDir);
  const path = join(stateDir, LOCK_FILE);
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    command,
    target,
    batchId,
  };
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readLock(stateDir);
    const status = classifyLock(existing);
    const holder = existing
      ? `pid ${existing.pid} on ${existing.host} since ${existing.startedAt} (${existing.command ?? "unknown command"})`
      : "an unreadable lock record";
    throw new CliError(CODES.REPO_LOCKED, `${target} is locked by ${holder}`, {
      hint:
        status.state === "stale"
          ? "The owning process is gone: run `bench-quality doctor --clear-stale-lock` after confirming it is not running."
          : "Wait for the other process to finish; concurrent init/update in one repository is not supported.",
      details: { lockPath: path, status: status.state },
    });
  }
  await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
  await handle.close();

  let released = false;
  return {
    path,
    owner,
    async release() {
      if (released) return;
      released = true;
      const current = await readLock(stateDir);
      if (
        current &&
        current.pid === owner.pid &&
        current.host === owner.host &&
        current.startedAt === owner.startedAt
      ) {
        await unlink(path).catch(() => {});
      }
    },
  };
}

/** Explicitly drop a lock, refusing to touch one held by a live process. */
export async function clearLock(stateDir, { force = false } = {}) {
  const lock = await readLock(stateDir);
  const status = classifyLock(lock);
  if (status.state === "none") return { cleared: false, reason: "no-lock" };
  if (status.state === "alive" && !force) {
    throw new CliError(CODES.REPO_LOCKED, `lock is held by a live process (pid ${lock.pid})`, {
      hint: "Stop that process first; do not clear an active lock.",
    });
  }
  await unlink(join(stateDir, LOCK_FILE)).catch(() => {});
  return { cleared: true, previous: lock };
}

export async function writeJournal(stateDir, journal) {
  await ensureDir(stateDir);
  const path = join(stateDir, JOURNAL_FILE);
  await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`);
  return path;
}

export async function readJournal(stateDir) {
  return readJsonIfExists(join(stateDir, JOURNAL_FILE));
}

export async function clearJournal(stateDir) {
  await unlink(join(stateDir, JOURNAL_FILE)).catch(() => {});
}

/**
 * Copy a target file into the batch backup directory before it is modified.
 * Returns `{ backupPath, hash }` or null when the file does not exist yet.
 */
export async function backupFile({ target, backupDir, relPath, hashContent }) {
  const source = join(target, relPath);
  if ((await statOrNull(source)) === null) return null;
  const dest = join(backupDir, relPath);
  await ensureDir(dirname(dest));
  await copyFile(source, dest);
  return { backupPath: dest, hash: await hashContent(source) };
}
