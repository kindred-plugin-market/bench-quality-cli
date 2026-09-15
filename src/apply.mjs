// Apply a plan: backup → journal → atomic writes → manifest → wiring.
//
// The order matters. The journal is written (and fsynced by the OS on close)
// *before* the first mutation, and it records the pre-state of every file
// (existed / before-hash / backup path) plus the hash we intend to leave
// behind. Any interruption can therefore be classified file by file:
//   current == before-hash   → that file was not touched yet
//   current == planned-hash  → that file was written by this batch
//   anything else            → a third party moved it; recovery stops.
import { copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { ensureDir, quarantineFile, readTextIfExists, sha256, writeFileAtomic } from "./fsx.mjs";
import { setHooksPath, unsetHooksPath } from "./git.mjs";
import { buildManifest, serializeManifest } from "./manifest.mjs";
import { backupDirFor, writeJournal, clearJournal } from "./state.mjs";

export const MANIFEST_REL_PATH = ".bench-quality.json";

/** Hash the current content of a target file (null when it does not exist). */
export async function hashTargetFile(target, relPath) {
  const raw = await readTextIfExists(join(target, relPath));
  return raw === null ? null : sha256(raw);
}

function writableWrites(plan) {
  return plan.writes.filter(
    (write) => write.action === "create" || write.action === "update" || write.action === "delete",
  );
}

/**
 * Apply the plan. Returns the journal record so the caller can report exact
 * backups; throws (leaving both journal and backups in place) when a write
 * fails, after attempting an automatic rollback.
 */
export async function applyPlan(plan, { stateDir, backupDir, generator, logger = () => {} }) {
  const batchBackupDir = backupDir ?? backupDirFor(stateDir, plan.batchId);
  const writes = writableWrites(plan);
  const files = [];

  for (const write of writes) {
    const absolute = join(plan.target, write.relPath);
    const raw = await readTextIfExists(absolute);
    const entry = {
      relPath: write.relPath,
      kind: write.kind,
      existed: raw !== null,
      beforeHash: raw === null ? null : sha256(raw),
      plannedHash: write.plannedHash,
      backupPath: null,
      mode: write.mode,
      deleted: write.action === "delete",
    };
    if (raw !== null) {
      const dest = join(batchBackupDir, write.relPath);
      await ensureDir(dirname(dest));
      await copyFile(absolute, dest);
      entry.backupPath = dest;
    }
    files.push(entry);
  }

  const startedAt = new Date().toISOString();
  const journal = {
    batchId: plan.batchId,
    mode: plan.mode,
    target: resolve(plan.target),
    generator,
    startedAt,
    state: "writing",
    files,
    hooksPath: { before: plan.git.current ?? plan.git.previousHooksPath ?? null, after: plan.git.hooksPath ?? null },
    features: plan.features,
    profile: plan.profile,
    profiles: plan.profiles,
    lefthook: plan.lefthook,
    packageJson: plan.packageJson,
    workspace: plan.workspace,
  };
  const journalPath = await writeJournal(stateDir, journal);
  logger({ level: "debug", message: `journal written to ${journalPath}` });

  try {
    for (const write of writes) {
      if (write.kind === "manifest") continue; // written below, from the merged state
      if (write.action === "delete") {
        // "Move to trash" instead of unlinking: retired artifacts stay
        // recoverable next to the batch backups.
        await quarantineFile(join(plan.target, write.relPath), join(batchBackupDir, "removed"), write.relPath);
        continue;
      }
      await writeFileAtomic(join(plan.target, write.relPath), write.content, { mode: write.mode ?? 0o644 });
    }

    const manifest = buildManifest({
      generator,
      features: plan.features,
      profile: plan.profile,
      profiles: plan.profiles,
      files: plan.files,
      packageJson: { managed: plan.packageJson.managed },
      workspace: { managedKeys: plan.workspace?.managedKeys ?? {} },
      prettierIgnore: { managedLines: plan.prettierIgnore?.managedLines ?? [] },
      lefthook: { managedEntries: plan.lefthook.managedEntries },
      git: { hooksPath: plan.git.hooksPath, previousHooksPath: plan.git.previousHooksPath ?? null },
      batch: { id: plan.batchId, startedAt, finishedAt: new Date().toISOString() },
    });
    await writeFileAtomic(join(plan.target, MANIFEST_REL_PATH), serializeManifest(manifest));

    if (plan.git.changed) {
      if (plan.git.hooksPath) await setHooksPath(plan.target, plan.git.hooksPath);
      else await unsetHooksPath(plan.target);
    }

    await clearJournal(stateDir);
    return { journal, journalPath, backupDir: batchBackupDir, manifest };
  } catch (error) {
    const rollback = await rollbackBatch(journal, { backupDir: batchBackupDir }).catch((rollbackError) => ({
      ok: false,
      conflicts: [{ relPath: "<rollback>", reason: rollbackError.message }],
      restored: [],
      quarantined: [],
    }));
    if (rollback.ok) await clearJournal(stateDir);
    throw new CliError(
      "WRITE_FAILED",
      `${error.message}${rollback.ok ? " (the batch was rolled back)" : " (rollback reported conflicts; run `bench-quality doctor --recover`)"}`,
      {
        hint: "Re-run with --dry-run to inspect the plan; backups are kept under the batch backup directory.",
        details: { rollback },
      },
    );
  }
}

/**
 * Undo a batch, file by file. Refuses to touch a file whose current content is
 * neither the recorded pre-state nor this batch's output: that file was changed
 * by someone else and must be reconciled by hand.
 */
export async function rollbackBatch(journal, { backupDir }) {
  const restored = [];
  const quarantined = [];
  const untouched = [];
  const conflicts = [];

  for (const entry of [...journal.files].reverse()) {
    const absolute = join(journal.target, entry.relPath);
    const raw = await readTextIfExists(absolute);
    const current = raw === null ? null : sha256(raw);

    if (current === entry.beforeHash) {
      untouched.push(entry.relPath);
      continue;
    }
    if (entry.deleted) {
      // Retired file: it is gone when we removed it, and a third-party file at
      // the same path must not be overwritten by the restore.
      if (current === null) {
        await copyFile(entry.backupPath, absolute);
        restored.push(entry.relPath);
      } else {
        conflicts.push({ relPath: entry.relPath, reason: "path was recreated after the batch removed the file" });
      }
      continue;
    }
    if (entry.existed) {
      if (current === null) {
        conflicts.push({ relPath: entry.relPath, reason: "file was deleted after the batch wrote it" });
        continue;
      }
      if (current !== entry.plannedHash) {
        conflicts.push({ relPath: entry.relPath, reason: "file changed after the batch wrote it (external edit)" });
        continue;
      }
      await copyFile(entry.backupPath, absolute);
      restored.push(entry.relPath);
    } else {
      if (current === null) {
        untouched.push(entry.relPath);
        continue;
      }
      if (current !== entry.plannedHash) {
        conflicts.push({ relPath: entry.relPath, reason: "file changed after the batch created it (external edit)" });
        continue;
      }
      const moved = await quarantineFile(absolute, join(backupDir, "rolled-back"), entry.relPath);
      if (moved) quarantined.push(entry.relPath);
    }
  }

  let hooksPathRestored = false;
  if (conflicts.length === 0 && journal.hooksPath && journal.hooksPath.before !== journal.hooksPath.after) {
    if (journal.hooksPath.before) await setHooksPath(journal.target, journal.hooksPath.before);
    else await unsetHooksPath(journal.target);
    hooksPathRestored = true;
  }

  return { ok: conflicts.length === 0, restored, quarantined, untouched, conflicts, hooksPathRestored };
}
