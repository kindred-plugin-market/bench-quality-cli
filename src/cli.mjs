// Command line entry point.
//
// Every mode follows the same shape: validate arguments → assert the target is
// a plain git checkout root → build a read-only plan → print it → (unless
// --dry-run) take the repository lock and apply it. Nothing in this file writes
// files directly; that is apply.mjs' job, which is also what makes --dry-run a
// faithful preview instead of an approximation.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { applyPlan } from "./apply.mjs";
import { assertGitRepo, gitCommonDir, gitTopLevel, readHooksPath } from "./git.mjs";
import { readManifest } from "./manifest.mjs";
import { buildPlan, generatorInfo, summarizePlan } from "./plan.mjs";
import { features as registry } from "./features/index.mjs";
import { inspectRecovery, recoverFromJournal } from "./recover.mjs";
import { detectDrift, summarizeDrift } from "./manifest.mjs";
import { acquireRepoLock, backupDirFor, classifyLock, clearLock, readJournal, readLock, resolveStateDir } from "./state.mjs";
import { promptFeatures } from "./prompt.mjs";
import { statOrNull } from "./fsx.mjs";

const FLAGS = {
  init: ["target", "features", "yes", "dry-run", "accept-drift", "state-dir", "backup-dir", "json"],
  update: ["target", "features", "yes", "dry-run", "accept-drift", "state-dir", "backup-dir", "json"],
  remove: ["target", "features", "yes", "dry-run", "accept-drift", "state-dir", "backup-dir", "json"],
  doctor: ["target", "json", "recover", "clear-stale-lock", "state-dir", "backup-dir"],
  list: ["json"],
  help: [],
};

const BOOLEAN_FLAGS = new Set(["yes", "y", "dry-run", "accept-drift", "json", "recover", "clear-stale-lock"]);

export async function run(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        return printHelp();
      case "-v":
      case "--version": {
        const generator = await generatorInfo();
        console.log(generator.version);
        return;
      }
      case "list":
        return listFeatures(parseArgs("list", rest));
      case "init":
        return writeMode("init", parseArgs("init", rest));
      case "update":
        return writeMode("update", parseArgs("update", rest));
      case "remove":
        return writeMode("remove", parseArgs("remove", rest));
      case "doctor":
        return doctor(parseArgs("doctor", rest));
      default:
        throw new CliError(CODES.UNKNOWN_COMMAND, `unknown command: ${command}`, {
          hint: "Known commands: init, update, remove, doctor, list, help.",
        });
    }
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  }
}

function reportError(error) {
  if (error instanceof CliError) {
    console.error(error.message);
    if (error.hint) console.error(`hint: ${error.hint}`);
    if (error.details && process.env.BENCH_QUALITY_DEBUG) {
      console.error(JSON.stringify(error.details, null, 2));
    }
  } else {
    console.error(error?.stack ?? String(error));
  }
}

/** Strict argument parsing: unknown flags and missing values fail closed. */
function parseArgs(command, argv) {
  const allowed = new Set(FLAGS[command] ?? []);
  const args = { positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      if (token === "-y") {
        args.yes = true;
        continue;
      }
      args.positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    if (!allowed.has(name)) {
      throw new CliError(CODES.UNKNOWN_FLAG, `--${name} is not a valid flag for "${command}"`, {
        hint: `Accepted flags: ${[...allowed].map((flag) => `--${flag}`).join(", ") || "(none)"}.`,
      });
    }
    if (BOOLEAN_FLAGS.has(name)) {
      args[name] = eq === -1 ? true : parseBoolean(token, name, token.slice(eq + 1));
      continue;
    }
    const value = eq === -1 ? argv[++index] : token.slice(eq + 1);
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new CliError(CODES.MISSING_FLAG_VALUE, `--${name} requires a value`, {
        hint: `Example: --${name} <value>`,
      });
    }
    args[name] = value;
  }
  if (args.positionals.length > 0) {
    throw new CliError(CODES.UNKNOWN_FLAG, `unexpected argument(s): ${args.positionals.join(" ")}`, {
      hint: "Everything is configured through flags; see --help.",
    });
  }
  return args;
}

function parseBoolean(token, name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError(CODES.MISSING_FLAG_VALUE, `${token} must be --${name}=true or --${name}=false`);
}

async function resolveTarget(args) {
  const target = resolve(args.target ?? process.cwd());
  const info = await statOrNull(target);
  if (!info) {
    throw new CliError(CODES.INVALID_TARGET, `${target} does not exist`, { hint: "Pass an existing directory." });
  }
  if (!info.isDirectory()) {
    throw new CliError(CODES.TARGET_NOT_DIRECTORY, `${target} is not a directory`);
  }
  // Canonicalise: on macOS /var is a symlink to /private/var, and lock state,
  // journal ownership and planned paths must all agree on one spelling.
  return { target: await realpath(target), args };
}

/** Write modes require the repository root — hooks wired from a subdirectory never run. */
async function assertRepoRoot(target) {
  const top = await assertGitRepo(target);
  if (resolve(top) !== resolve(target)) {
    throw new CliError(CODES.INVALID_TARGET, `${target} is not the repository root (${top})`, {
      hint: `Run with --target ${top}; generated hooks and lock state are repository-scoped.`,
    });
  }
  return top;
}

function resolveFeatureIds(args) {
  if (args.features) {
    return args.features
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }
  if (args.yes) return registry.map((feature) => feature.id);
  return null;
}

async function resolveState(args, target) {
  const commonDir = await gitCommonDir(target);
  return {
    stateDir: resolveStateDir({ gitCommonDir: commonDir, stateDir: args["state-dir"] }),
    gitCommonDir: commonDir,
  };
}

async function writeMode(mode, args) {
  const { target } = await resolveTarget(args);
  await assertRepoRoot(target);
  const generator = await generatorInfo();

  let featureIds = resolveFeatureIds(args);
  if (featureIds === null && mode === "update") {
    // `update` without --features keeps exactly what is already enabled
    // (additive semantics; `remove` is the only way to drop a feature).
    featureIds = [];
  }
  if (featureIds === null) {
    if (!process.stdin.isTTY) {
      throw new CliError("FEATURES_REQUIRED", "no features specified and stdin is not a terminal", {
        hint: "Pass --features <a,b,c> or --yes (all features).",
      });
    }
    featureIds = await promptFeatures();
  }
  const unknown = featureIds.filter((id) => !registry.some((feature) => feature.id === id));
  if (unknown.length > 0) {
    throw new CliError(CODES.UNKNOWN_FEATURE, `unknown feature(s): ${unknown.join(", ")}`, {
      hint: `Available: ${registry.map((feature) => feature.id).join(", ")}.`,
    });
  }
  if (mode === "remove" && featureIds.length === 0) {
    throw new CliError(CODES.UNKNOWN_FEATURE, "remove needs at least one feature id", {
      hint: "Example: --features markdown",
    });
  }

  const { stateDir } = await resolveState(args, target);
  const hooksPath = await readHooksPath(target);
  const plan = await buildPlan({
    target,
    mode,
    registry,
    featureIds,
    acceptDrift: Boolean(args["accept-drift"]),
    hooksPath,
  });

  if (args.json) {
    printPlan(plan, { json: true });
  } else {
    printPlan(plan);
  }

  if (plan.conflicts.length > 0) {
    throw new CliError(CODES.FILE_DRIFT, `${plan.conflicts.length} managed file(s) changed locally`, {
      hint: "Review them, then re-run with --accept-drift (originals are backed up) or restore them from git.",
      details: { conflicts: plan.conflicts },
    });
  }

  if (args["dry-run"]) {
    if (!args.json) console.log("dry run: nothing was written.");
    return { plan, dryRun: true };
  }

  const inspection = await inspectRecovery({ target, stateDir });
  if (inspection.lockStatus.state === "alive" || inspection.lockStatus.state === "foreign") {
    const lock = inspection.lock;
    throw new CliError(CODES.REPO_LOCKED, `${target} is locked by pid ${lock.pid} on ${lock.host}`, {
      hint: "Another generator process is running for this repository; wait for it to finish.",
    });
  }
  if (inspection.journal) {
    throw new CliError(CODES.RECOVERY_REQUIRED, `a previous batch (${inspection.journal.batchId}) was interrupted`, {
      hint: "Run `bench-quality doctor --recover` to restore the pre-batch state, then re-run this command.",
    });
  }

  const lock = await acquireRepoLock(stateDir, { target, command: mode, batchId: plan.batchId });
  try {
    const backupDir = args["backup-dir"] ? resolve(args["backup-dir"]) : backupDirFor(stateDir, plan.batchId);
    const result = await applyPlan(plan, { stateDir, backupDir, generator });
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            command: mode,
            batchId: plan.batchId,
            features: plan.features,
            backupDir: result.backupDir,
            files: plan.writes.map((write) => ({ path: write.relPath, action: write.action })),
            hooksPath: plan.git.hooksPath,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\nbatch ${plan.batchId} applied; backups in ${result.backupDir}`);
      if (plan.git.changed) console.log(`git core.hooksPath -> ${plan.git.hooksPath ?? "(unset)"}`);
    }
    return { plan, result };
  } finally {
    await lock.release();
  }
}

function printPlan(plan, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(summarizePlan(plan), null, 2));
    return;
  }
  console.log(`bench-quality-cli — ${plan.mode} in ${plan.target}`);
  console.log(`features: ${plan.features.length ? plan.features.join(", ") : "(none)"}`);
  for (const write of plan.writes) {
    const marker = { create: "+", update: "~", unchanged: "=", conflict: "!" }[write.action] ?? "?";
    console.log(`  ${marker} ${write.action.padEnd(9)} ${write.relPath}`);
  }
  for (const note of plan.notes) {
    console.log(`  ${note.level === "warn" ? "!" : "-"} ${note.message}`);
  }
  for (const conflict of plan.conflicts) {
    console.log(`  ! conflict  ${conflict.relPath} (${conflict.reason})`);
  }
  const summary = summarizePlan(plan);
  console.log(
    `plan: ${summary.create.length} create, ${summary.update.length} update, ${summary.unchanged.length} unchanged, ${summary.conflicts.length} conflict`,
  );
}

async function listFeatures(args) {
  if (args.json) {
    console.log(JSON.stringify(registry.map(({ id, description, deps }) => ({ id, description, deps })), null, 2));
    return;
  }
  console.log("Available features:\n");
  for (const feature of registry) {
    console.log(`  ${feature.id.padEnd(16)} ${feature.description}`);
  }
}

/**
 * Read-only inspection. Reports the generated state, drift against the
 * manifest, leftover lock/journal, and the hook wiring. `--recover` is the only
 * flag that writes, and only restores an interrupted batch.
 */
async function doctor(args) {
  const { target } = await resolveTarget(args);
  const generator = await generatorInfo();
  const findings = [];
  const top = await gitTopLevel(target).catch(() => null);
  let stateDir = null;
  try {
    stateDir = (await resolveState(args, target)).stateDir;
  } catch {
    stateDir = null; // no git repository and no --state-dir: report instead of failing
  }

  const lock = stateDir ? await readLock(stateDir) : null;
  const lockStatus = classifyLock(lock);
  const journal = stateDir ? await readJournal(stateDir) : null;
  let manifest = null;
  try {
    manifest = await readManifest(target);
  } catch (error) {
    findings.push({ level: "error", code: error.code ?? "INVALID_MANIFEST", message: error.message });
  }
  const hooksPath = top ? await readHooksPath(target) : null;

  const drift = manifest ? await detectDrift(target, manifest.files ?? {}) : { drifted: [], unchanged: [], missing: [] };
  if (drift.drifted.length > 0) findings.push({ level: "warn", code: "FILE_DRIFT", paths: drift.drifted });
  if (drift.missing.length > 0) findings.push({ level: "warn", code: "FILE_MISSING", paths: drift.missing });
  if (lockStatus.state === "stale") findings.push({ level: "warn", code: CODES.STALE_LOCK, pid: lock?.pid });
  if (lockStatus.state === "alive") findings.push({ level: "warn", code: CODES.REPO_LOCKED, pid: lock?.pid });
  if (journal) findings.push({ level: "error", code: CODES.RECOVERY_REQUIRED, batchId: journal.batchId });
  if (manifest && hooksPath !== manifest.git?.hooksPath) {
    findings.push({ level: "warn", code: "HOOKS_PATH_CHANGED", expected: manifest.git?.hooksPath, actual: hooksPath });
  }
  if (!top) findings.push({ level: "error", code: CODES.GIT_REPO_REQUIRED, path: target });

  const report = {
    generator,
    target,
    gitRoot: top,
    hooksPath,
    stateDir,
    manifest: manifest
      ? {
          schemaVersion: manifest.schemaVersion,
          generator: manifest.generator,
          features: manifest.features,
          profiles: manifest.profiles,
          batch: manifest.batch,
        }
      : null,
    managedFiles: manifest ? Object.keys(manifest.files ?? {}).length : 0,
    drift: summarizeDrift(drift),
    lock: lockStatus.state === "none" ? null : { state: lockStatus.state, ...lock },
    journal: journal ? { batchId: journal.batchId, startedAt: journal.startedAt, files: journal.files.length } : null,
    findings,
  };

  if ((args.recover || args["clear-stale-lock"]) && !stateDir) {
    throw new CliError(CODES.GIT_REPO_REQUIRED, "recovery needs the repository state directory", {
      hint: "Run doctor inside the git repository, or pass --state-dir explicitly.",
    });
  }

  if (args.recover) {
    const recovery = await recoverFromJournal({
      target,
      stateDir,
      backupDir: args["backup-dir"] ? resolve(args["backup-dir"]) : undefined,
      clearStaleLock: Boolean(args["clear-stale-lock"]),
    });
    report.recovery = recovery;
    console.log(
      `recovered batch ${recovery.batchId}: ${recovery.restored.length} restored, ${recovery.quarantined.length} quarantined`,
    );
  }

  if (args["clear-stale-lock"]) {
    const cleared = await clearLock(stateDir);
    report.lockCleared = cleared;
    if (cleared.cleared) console.log(`cleared stale lock from pid ${cleared.previous?.pid ?? "unknown"}`);
  }

  // Findings that a successful recovery just resolved must not keep the exit
  // code non-zero: `doctor --recover` is expected to leave a healthy repo.
  if (report.recovery || report.lockCleared?.cleared) {
    report.findings = findings.filter(
      (finding) => finding.code !== CODES.RECOVERY_REQUIRED && finding.code !== CODES.STALE_LOCK,
    );
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDoctor(report);
  }
  if (report.findings.some((finding) => finding.level === "error")) process.exitCode = 1;
  return report;
}

function printDoctor(report) {
  console.log(`bench-quality-cli ${report.generator.version} — doctor`);
  console.log(`target:      ${report.target}`);
  console.log(`git root:    ${report.gitRoot ?? "(not a git repository)"}`);
  console.log(`hooksPath:   ${report.hooksPath ?? "(unset)"}`);
  console.log(`state dir:   ${report.stateDir}`);
  console.log(
    `generated:   ${report.manifest ? `v${report.manifest.schemaVersion} by ${report.manifest.generator?.version} — ${report.manifest.features.join(", ") || "no features"}` : "(no .bench-quality.json)"}`,
  );
  console.log(
    `files:       ${report.managedFiles} managed, ${report.drift.unchanged} unchanged, ${report.drift.drifted} drifted, ${report.drift.missing} missing`,
  );
  console.log(`lock:        ${report.lock ? `${report.lock.state} (pid ${report.lock.pid})` : "none"}`);
  console.log(`journal:     ${report.journal ? `${report.journal.batchId} (${report.journal.files} files)` : "none"}`);
  if (report.findings.length === 0) {
    console.log("\nno findings.");
  } else {
    console.log("\nfindings:");
    for (const finding of report.findings) {
      console.log(`  ${finding.level === "error" ? "x" : "!"} ${finding.code} ${JSON.stringify(finding)}`);
    }
  }
}

function printHelp() {
  console.log(`bench-quality-cli — vendor opt-in Bench quality gates into any repo

Usage:
  bench-quality init    [--features a,b,c] [--target <dir>] [--yes] [--dry-run]
  bench-quality update  [--features a,b,c] [--accept-drift] [--dry-run]
  bench-quality remove  --features a,b,c [--dry-run]
  bench-quality doctor  [--recover] [--clear-stale-lock] [--json]
  bench-quality list    [--json]

Generated artifacts (scripts/, lefthook.yml, .husky/, devDependencies and
.bench-quality.json) live in the consumer repo and are committed there. This
generator repo can be deleted without breaking already-initialized projects.

Options:
  --target <dir>     target repository root (default: cwd, must be the git root)
  --features <ids>   comma-separated feature ids
  --yes, -y          non-interactive; selects every feature
  --dry-run          print the change plan and write nothing
  --accept-drift     adopt managed files that were edited locally (backed up first)
  --state-dir <dir>  lock/journal/backup location (default: <git-common-dir>/bench-quality-cli)
  --backup-dir <dir> explicit backup directory for this batch
  --json             machine-readable output (plan/doctor report)

Every write mode takes an exclusive per-repository lock; an interrupted batch
must be recovered with \`doctor --recover\` before the next write.`);
}

export { features } from "./features/index.mjs";
