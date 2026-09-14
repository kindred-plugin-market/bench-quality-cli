// Recovery entry point for an interrupted batch.
//
// A leftover journal means a previous run stopped between the first write and
// the completion marker. Recovery is only allowed when
//   - the journal belongs to this target,
//   - no live process holds the repository lock,
// and it never overwrites content that a third party changed meanwhile
// (rollbackBatch classifies each file first).
import { resolve } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { rollbackBatch } from "./apply.mjs";
import { backupDirFor, classifyLock, clearJournal, clearLock, readJournal, readLock } from "./state.mjs";

export async function inspectRecovery({ target, stateDir }) {
  const journal = await readJournal(stateDir);
  const lock = await readLock(stateDir);
  const lockStatus = classifyLock(lock);
  if (!journal) return { journal: null, lock, lockStatus, recoverable: false, reason: "no-journal" };
  if (resolve(journal.target) !== resolve(target)) {
    return {
      journal,
      lock,
      lockStatus,
      recoverable: false,
      reason: `journal belongs to ${journal.target}`,
    };
  }
  if (lockStatus.state === "alive") {
    return { journal, lock, lockStatus, recoverable: false, reason: "another process is still running" };
  }
  return { journal, lock, lockStatus, recoverable: true, reason: "interrupted batch" };
}

/**
 * Restore the pre-batch state described by the journal.
 * `backupDir` defaults to the batch's own backup directory under the state dir.
 */
export async function recoverFromJournal({ target, stateDir, backupDir, clearStaleLock = false }) {
  const inspection = await inspectRecovery({ target, stateDir });
  if (!inspection.journal) {
    throw new CliError(CODES.NOTHING_TO_RECOVER, `no journal found in ${stateDir}`, {
      hint: "Nothing to restore; run `bench-quality doctor` to inspect the current state.",
    });
  }
  if (!inspection.recoverable) {
    throw new CliError(CODES.RECOVERY_REQUIRED, `cannot recover automatically: ${inspection.reason}`, {
      hint:
        inspection.lockStatus.state === "alive"
          ? "Wait for the running process to finish, then re-run recovery."
          : "Run recovery from the repository the journal belongs to.",
    });
  }

  const dir = backupDir ?? backupDirFor(stateDir, inspection.journal.batchId);
  const result = await rollbackBatch(inspection.journal, { backupDir: dir });
  if (!result.ok) {
    throw new CliError(CODES.RECOVERY_CONFLICT, "some files changed after the interrupted batch", {
      hint: "Review the listed files and restore them by hand from the batch backup directory; the journal is kept.",
      details: { conflicts: result.conflicts, backupDir: dir },
    });
  }

  await clearJournal(stateDir);
  if (clearStaleLock && inspection.lockStatus.state !== "alive") {
    await clearLock(stateDir, { force: false }).catch(() => {});
  }
  return { ...result, batchId: inspection.journal.batchId, backupDir: dir };
}
