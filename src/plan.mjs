// The change plan: a complete, read-only description of everything a run would
// do. `init` / `update` / `remove` only ever write what a plan produced, and
// `--dry-run` prints the very same plan without touching the filesystem — so
// "what the reviewer saw" and "what ran" cannot diverge.
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { readJsonIfExists, readTextIfExists, sha256, statOrNull } from "./fsx.mjs";
import { BASE_WIRING, HOOK_SUPPORT_FILES, planHooks } from "./hooks.mjs";
import { planLefthook } from "./lefthook.mjs";
import { readManifest } from "./manifest.mjs";
import { devDepsFor, planPackageJson, readManagedState, scriptsFor } from "./package-json.mjs";
import { PRETTIER_IGNORE_FILE, planPrettierIgnore } from "./prettier-ignore.mjs";
import { missingRequirements } from "./profiles/index.mjs";
import { PACKAGE_ROOT, filesForFeatures, readTemplate } from "./templates.mjs";
import { WORKSPACE_FILE, planWorkspaceYaml } from "./workspace-yaml.mjs";

export const HOOKS_PATH_VALUE = ".husky";

/**
 * 逐字节比对的托管文件（生成器拥有内容）：vendored 模板与 hook 体。
 * 其余 kind（lefthook / package-json / workspace / prettier-ignore）是**语义合并**，
 * 消费者可以在其中自由书写 —— doctor 与 update 必须用同一套语义判定（C11）。
 */
const WHOLE_FILE_KINDS = new Set(["template", "hook"]);

export async function generatorInfo() {
  const pkg = await readJsonIfExists(join(PACKAGE_ROOT, "package.json"));
  return { name: pkg?.name ?? "bench-quality-cli", version: pkg?.version ?? "0.0.0" };
}

export function newBatchId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:]/g, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Reject anything that would write outside the target. Checked for every
 * planned path before the plan is accepted, so a bad template (`../..`) can
 * never escape the repository.
 */
export function assertInsideTarget(target, relPath) {
  if (relPath === "" || isAbsolute(relPath)) {
    throw new CliError(CODES.PATH_OUTSIDE_TARGET, `${relPath} must be a relative path inside the target`, {
      hint: "Generated artifacts always live inside the consumer repository.",
    });
  }
  const root = resolve(target);
  const full = resolve(root, relPath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new CliError(CODES.PATH_OUTSIDE_TARGET, `${relPath} resolves outside ${root}`, {
      hint: "Refusing to write; this is a generator bug, please report it.",
    });
  }
  return { root, full, rel: relative(root, full) };
}

/** Fail closed when a managed path (or one of its parents) is a symlink. */
export async function assertNoSymlink(target, relPath) {
  const { root, rel } = assertInsideTarget(target, relPath);
  const segments = rel.split(sep);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const info = await statOrNull(current);
    if (info?.isSymbolicLink()) {
      throw new CliError(CODES.PATH_IS_SYMLINK, `${relative(root, current)} is a symbolic link`, {
        hint: "Replace the symlink with a real directory and re-run; writing through it is refused.",
      });
    }
    if (info && !info.isDirectory()) {
      throw new CliError(CODES.PATH_OUTSIDE_TARGET, `${relative(root, current)} exists and is not a directory`, {
        hint: "Move it out of the way and re-run; unrelated files are never overwritten.",
      });
    }
  }
  const leaf = await statOrNull(join(root, rel));
  if (leaf?.isSymbolicLink()) {
    throw new CliError(CODES.PATH_IS_SYMLINK, `${rel} is a symbolic link`, {
      hint: "Managed files must be real files inside the repository.",
    });
  }
}

async function planWholeFile({ target, relPath, content, mode, kind, previousFiles, acceptDrift, notes, conflicts }) {
  const { rel } = assertInsideTarget(target, relPath);
  await assertNoSymlink(target, rel);
  const current = await readTextIfExists(join(target, rel));
  const plannedHash = sha256(content);
  const base = { relPath: rel, content, mode, kind, plannedHash };
  if (current === null) return { ...base, action: "create" };
  if (sha256(current) === plannedHash) return { ...base, action: "unchanged" };
  const recorded = previousFiles[rel];
  if (recorded !== undefined && recorded === sha256(current)) return { ...base, action: "update" };
  if (acceptDrift) {
    notes.push({
      level: "warn",
      message: `${rel} differs from the generated template and from our last output; --accept-drift adopts the generated content (original bytes are backed up)`,
    });
    return { ...base, action: "update", drifted: true };
  }
  conflicts.push({
    relPath: rel,
    reason:
      recorded === undefined
        ? "file exists but was not produced by bench-quality-cli"
        : "file was edited locally since the last generated run",
    recorded: recorded ?? null,
  });
  return { ...base, action: "conflict" };
}

function uniqueIds(ids) {
  return [...new Set(ids)];
}

/** First writer wins for a destination path (base files before feature files). */
function dedupeByTarget(files) {
  const seen = new Map();
  for (const file of files) if (!seen.has(file.to)) seen.set(file.to, file);
  return [...seen.values()];
}

/**
 * Build the plan for init / update / remove.
 *
 * @param {object} options
 * @param {string} options.target              repository-absolute target directory
 * @param {"init"|"update"|"remove"} options.mode
 * @param {Array}  options.registry            feature registry
 * @param {string[]} options.featureIds        ids requested on the command line
 * @param {boolean} [options.acceptDrift]      adopt locally edited managed files
 * @param {string[]} [options.profiles]        profile ids recorded in the manifest
 * @param {string|null} [options.hooksPath]    current `core.hooksPath` (null when unset)
 */
export async function buildPlan({
  target,
  mode,
  registry,
  featureIds,
  profile = null,
  requireProfilePaths = false,
  profiles = [],
  acceptDrift = false,
  hooksPath = null,
}) {
  // Requirement check runs before anything is read or planned: an explicitly
  // chosen profile must not be applied to a repository it does not describe.
  if (profile && requireProfilePaths) {
    const missing = missingRequirements(profile, { exists: (entry) => existsSync(join(target, entry)) });
    if (missing.length > 0) {
      throw new CliError(
        CODES.PROFILE_REQUIREMENTS_MISSING,
        `profile "${profile.id}" expects ${missing.join(", ")} to exist in ${target}`,
        {
          hint: "Point --target at the repository this profile is for, or choose another --profile; nothing was written.",
        },
      );
    }
  }
  const existing = await readManifest(target);
  if (mode === "update" && !existing) {
    throw new CliError("NOT_INITIALIZED", `${target} has no .bench-quality.json`, {
      hint: "Run `bench-quality init` first; `update` never guesses a baseline.",
    });
  }

  const existingIds = existing?.features ?? [];
  let nextIds;
  let removedIds = [];
  if (mode === "remove") {
    removedIds = featureIds;
    nextIds = existingIds.filter((id) => !removedIds.includes(id));
    if (existingIds.length === 0) {
      throw new CliError("NOT_INITIALIZED", `${target} has no generated features to remove`, {
        hint: "Nothing to remove; check the target directory.",
      });
    }
  } else {
    nextIds = uniqueIds([...existingIds, ...featureIds]);
  }

  const unknown = nextIds.filter((id) => !registry.some((feature) => feature.id === id));
  if (unknown.length > 0) {
    throw new CliError(CODES.UNKNOWN_FEATURE, `unknown feature(s) in the manifest: ${unknown.join(", ")}`, {
      hint: "The manifest references a feature this CLI version does not ship; use the matching generator version.",
    });
  }
  const resolved = registry.filter((feature) => nextIds.includes(feature.id));

  const previousFiles = existing?.files ?? {};
  const notes = [];
  const conflicts = [];
  const writes = [];
  let prettierManaged = existing?.prettierIgnore?.managedLines ?? [];

  const keepWiring = resolved.length > 0;

  // 1) whole-file artifacts: vendored templates + hook bodies. The hook bodies
  //    depend on the partial-staging guard, so those two files are installed
  //    whenever hooks are wired (a feature may vendor them as well — identical
  //    content, deduplicated by destination).
  for (const file of dedupeByTarget([
    ...(keepWiring ? HOOK_SUPPORT_FILES : []),
    ...filesForFeatures(resolved),
  ])) {
    const content = await readTemplate(file.from);
    writes.push(
      await planWholeFile({
        target,
        relPath: file.to,
        content,
        mode: 0o644,
        kind: "template",
        previousFiles,
        acceptDrift,
        notes,
        conflicts,
      }),
    );
  }
  for (const hook of keepWiring ? planHooks() : []) {
    writes.push(
      await planWholeFile({
        target,
        relPath: hook.relPath,
        content: hook.content,
        mode: hook.mode,
        kind: hook.kind,
        previousFiles,
        acceptDrift,
        notes,
        conflicts,
      }),
    );
  }

  // 2) lefthook.yml — managed entries only. Regenerating with the new feature
  //    set automatically drops entries whose feature is gone.
  const lefthookRaw = await readTextIfExists(join(target, "lefthook.yml"));
  const lefthookPlan = planLefthook({
    raw: lefthookRaw,
    features: keepWiring ? [BASE_WIRING, ...resolved] : [],
    previousEntries: existing?.lefthook?.managedEntries ?? [],
  });
  if (lefthookPlan.removed.length > 0) {
    notes.push({ level: "info", message: `dropped obsolete managed entries: ${lefthookPlan.removed.join(", ")}` });
  }
  writes.push({
    relPath: "lefthook.yml",
    content: lefthookPlan.content,
    mode: 0o644,
    kind: "lefthook",
    plannedHash: sha256(lefthookPlan.content),
    action: lefthookRaw === null ? "create" : lefthookPlan.changed ? "update" : "unchanged",
  });

  // 3) package.json — additive devDependencies and project entries
  const previousManaged = existing?.packageJson?.managed ?? {};
  const previousManagedState = readManagedState(previousManaged);
  const packagePlan = await planPackageJson({
    target,
    requestedDeps: keepWiring ? devDepsFor(resolved) : {},
    requestedScripts: keepWiring ? scriptsFor({ profile, features: resolved }) : {},
    previousManaged: previousManagedState.devDependencies,
    previousManagedScripts: previousManagedState.scripts,
    addPrepare: keepWiring,
  });
  notes.push(...packagePlan.notes);
  writes.push({
    relPath: "package.json",
    content: packagePlan.content,
    mode: 0o644,
    kind: "package-json",
    plannedHash: sha256(packagePlan.content),
    action: packagePlan.created ? "create" : packagePlan.changed ? "update" : "unchanged",
  });

  // 3b) pnpm-workspace.yaml — managed keys the toolchain depends on (pnpm 12
  //     refuses an install while lefthook's postinstall is unapproved).
  const workspacePlan = await planWorkspaceYaml({
    target,
    workspaceKeys: keepWiring ? (profile?.workspaceKeys ?? {}) : {},
    previousManaged: existing?.workspace?.managedKeys ?? {},
  });
  notes.push(...workspacePlan.notes);
  if (keepWiring || workspacePlan.existed) {
    writes.push({
      relPath: WORKSPACE_FILE,
      content: workspacePlan.content,
      mode: 0o644,
      kind: "workspace",
      plannedHash: sha256(workspacePlan.content),
      action: workspacePlan.existed
        ? workspacePlan.changed
          ? "update"
          : "unchanged"
        : "create",
    });
  }

  // 3c) .prettierignore — 声明「生成文件由生成器拥有，消费者格式器不得触碰」（C11）。
  //     不这么做的话，消费者 `prettier --write .` 会把 vendored 脚本重排，doctor 报
  //     drift、update 报 conflict，运维人员无法区分真改动与格式噪声。
  if (keepWiring) {
    const managedPaths = [
      ...dedupeByTarget([...HOOK_SUPPORT_FILES, ...filesForFeatures(resolved)]).map((file) => file.to),
      ...planHooks().map((hook) => hook.relPath),
      "lefthook.yml",
      WORKSPACE_FILE,
    ];
    const prettierPlan = planPrettierIgnore({
      raw: await readTextIfExists(join(target, PRETTIER_IGNORE_FILE)),
      managedPaths,
      previousLines: existing?.prettierIgnore?.managedLines ?? [],
    });
    writes.push({
      relPath: PRETTIER_IGNORE_FILE,
      content: prettierPlan.content,
      mode: 0o644,
      kind: "prettier-ignore",
      plannedHash: sha256(prettierPlan.content),
      action: prettierPlan.existed ? (prettierPlan.changed ? "update" : "unchanged") : "create",
    });
    prettierManaged = prettierPlan.managedLines;
  }

  // 4) retire files we used to manage but no longer do (feature removed, or a
  //    template a newer generator version stopped shipping). A file is retired
  //    only while its content is still exactly what we last wrote; anything
  //    edited locally is preserved and reported.
  const written = new Set(writes.map((write) => write.relPath));
  for (const [relPath, recordedHash] of Object.entries(previousFiles)) {
    if (written.has(relPath)) continue;
    const current = await readTextIfExists(join(target, relPath));
    if (current === null) {
      notes.push({ level: "info", message: `${relPath} is already gone; dropping it from the manifest` });
      continue;
    }
    if (sha256(current) !== recordedHash) {
      notes.push({
        level: "warn",
        message: `${relPath} is no longer managed but was edited locally; left in place (delete it by hand if unused)`,
      });
      continue;
    }
    const { rel } = assertInsideTarget(target, relPath);
    await assertNoSymlink(target, rel);
    writes.push({
      relPath: rel,
      content: null,
      mode: 0o644,
      kind: "retired",
      plannedHash: null,
      action: "delete",
    });
  }

  // 5) git hooksPath wiring
  // `previousHooksPath` is the value that existed before the generator ever ran;
  // it must survive re-runs (including an explicit `null`) so that removing the
  // last feature restores the original wiring instead of keeping ours.
  const previousHooksPath =
    existing?.git && "previousHooksPath" in existing.git ? existing.git.previousHooksPath : (hooksPath ?? null);
  const nextHooksPath = keepWiring ? HOOKS_PATH_VALUE : previousHooksPath;
  const hooksPathChanged = (hooksPath ?? null) !== (nextHooksPath ?? null);

  const files = {};
  for (const write of writes) {
    if (write.action === "delete") continue;
    files[write.relPath] = write.plannedHash;
  }

  const profileIds = uniqueIds([...(existing?.profiles ?? []), ...profiles, ...(profile ? [profile.id] : [])]);

  return {
    batchId: newBatchId(),
    target,
    mode,
    acceptDrift,
    features: resolved.map((feature) => feature.id),
    removedFeatures: removedIds,
    profile: profile?.id ?? null,
    profiles: profileIds,
    writes,
    conflicts,
    notes,
    lefthook: { managedEntries: lefthookPlan.entries, removed: lefthookPlan.removed, changed: lefthookPlan.changed },
    packageJson: {
      managed: packagePlan.managed,
      devDependencies: packagePlan.devDependencies,
      scripts: packagePlan.scripts,
      changed: packagePlan.changed,
    },
    workspace: { managedKeys: workspacePlan.managed },
    prettierIgnore: { managedLines: prettierManaged },
    git: {
      hooksPath: nextHooksPath,
      previousHooksPath,
      changed: hooksPathChanged,
      current: hooksPath ?? null,
    },
    files,
    previousManifest: existing,
  };
}

/**
 * 把一份 update 计划翻译成「托管状态判定」，供 doctor 与 update 共用同一套语义
 * （C11）。核心区分：
 *   - 逐字节托管文件（template/hook）：只有 conflict（消费者改过）才算 drift；
 *     磁盘仍等于我们的输出但模板已更新 → behindTemplate（可安全刷新，不是 drift）。
 *   - 语义合并文件（lefthook/package-json/workspace/prettier-ignore）：消费者可以在
 *     其中自由书写，永远不产生 drift；需要刷新托管条目时只报 mergeRefresh。
 */
export function classifyPlan(plan) {
  const paths = (predicate) => plan.writes.filter(predicate).map((write) => write.relPath);
  const wholeFile = (write) => WHOLE_FILE_KINDS.has(write.kind);
  return {
    localEdits: plan.conflicts.map((conflict) => conflict.relPath),
    behindTemplate: paths((write) => wholeFile(write) && write.action === "update"),
    missing: paths((write) => wholeFile(write) && write.action === "create"),
    mergeRefresh: paths(
      (write) => !wholeFile(write) && (write.action === "update" || write.action === "create"),
    ),
    consistent: paths((write) => write.action === "unchanged"),
  };
}

/** Compact, printable summary of a plan (used by --dry-run output and doctor). */
export function summarizePlan(plan) {
  const byAction = (action) => plan.writes.filter((write) => write.action === action).map((write) => write.relPath);
  return {
    batchId: plan.batchId,
    mode: plan.mode,
    features: plan.features,
    create: byAction("create"),
    update: byAction("update"),
    unchanged: byAction("unchanged"),
    conflicts: plan.conflicts.map((conflict) => conflict.relPath),
    hooksPath: plan.git.hooksPath,
  };
}
