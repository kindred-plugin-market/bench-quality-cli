import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { BIN, gitStatus, makeRepo, runCli } from "./helpers/cli-fixture.mjs";
import { toPosixPath } from "./helpers/text.mjs";
import { sha256 } from "../src/fsx.mjs";
import { backupDirFor, readJournal, resolveStateDir, writeJournal } from "../src/state.mjs";

const LEFTHOOK_WITH_USER_ENTRY = `min_version: 1.6.0
colors: true
pre-commit:
  commands:
    prettier:
      glob: "*.ts"
      run: pnpm exec prettier --write {staged_files}
`;

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

test("init creates artifacts, manifest and hooks wiring", async (t) => {
  const repo = await makeRepo({ files: { "package.json": '{\n  "name": "fixture",\n  "version": "0.0.0"\n}\n' } });
  t.after(repo.cleanup);

  const result = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(await readFile(repo.file(".bench-quality.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.features, ["commitlint"]);
  assert.equal(manifest.generator.name, "bench-quality-cli");
  assert.ok(manifest.files["commitlint.config.js"], "manifest records the vendored file hash");
  assert.equal(manifest.git.hooksPath, ".husky");
  assert.equal(manifest.git.previousHooksPath, null);
  assert.equal(repo.git("config", "--get", "core.hooksPath").trim(), ".husky");
  assert.match(await readFile(repo.file(".husky/pre-commit"), "utf8"), /lefthook\/bin\/index\.js run pre-commit/);
  const pkg = JSON.parse(await readFile(repo.file("package.json"), "utf8"));
  assert.equal(pkg.devDependencies.lefthook, "^2.1.14");
  assert.equal(pkg.devDependencies["@commitlint/cli"], "^21.2.2");
  // Project entries and the install entry point come with the profile.
  assert.equal(pkg.scripts["hooks:install"], "node scripts/quality/install-hooks.mjs");
  assert.equal(pkg.scripts.prepare, "node scripts/quality/install-hooks.mjs");
  const workspace = await readFile(repo.file("pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /allowBuilds:\n  lefthook: false/);
  assert.ok(await readIfExists(repo.file("scripts/quality/install-hooks.mjs")));
  // The manifest records what is ours, so `remove` can drop it again.
  assert.equal(manifest.packageJson.managed.scripts["hooks:install"], "node scripts/quality/install-hooks.mjs");
  assert.deepEqual(manifest.workspace.managedKeys, { allowBuilds: { lefthook: false } });
  assert.equal(manifest.profile, "node-tool");
});

test("re-running init is idempotent", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);

  assert.equal(runCli(["init", "--features", "commitlint"], { cwd: repo.dir }).status, 0);
  const before = await listFiles(repo.dir);
  const second = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(second.status, 0, second.stderr);
  // 10 files: commitlint.config.js, lefthook.yml, package.json,
  // pnpm-workspace.yaml, the two hook bodies and the four hook support files
  // (git-changes, partial-staging guard, whitespace fixer, installer).
  assert.match(second.stdout, /0 create, 0 update, 10 unchanged/);
  assert.deepEqual(await listFiles(repo.dir), before);
});

test("--dry-run is read-only", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);

  const before = await listFiles(repo.dir);
  const result = runCli(["init", "--features", "commitlint,markdown", "--dry-run"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run: nothing was written\./);
  assert.match(result.stdout, /\+\s+create\s+commitlint\.config\.js/);
  assert.deepEqual(await listFiles(repo.dir), before);
  assert.equal(await readIfExists(repo.file(".bench-quality.json")), null);
  assert.equal(repo.git("config", "--get", "core.hooksPath").trim(), "");
  assert.equal(await readIfExists(join(repo.dir, ".git/bench-quality-cli/lock.json")), null);
});

test("json output of a dry run is machine readable", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const result = runCli(["init", "--features", "commitlint", "--dry-run", "--json"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, "init");
  assert.deepEqual(summary.features, ["commitlint"]);
  assert.ok(summary.create.includes("commitlint.config.js"));
  assert.equal(summary.hooksPath, ".husky");
});

test("a broken package.json aborts the batch untouched", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{ not json" } });
  t.after(repo.cleanup);
  // Node itself refuses to start with cwd inside a directory whose package.json
  // is unparseable, so the target is addressed from a healthy directory.
  const result = runCli(["init", "--features", "commitlint", "--target", repo.dir], { cwd: process.cwd() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_JSON: package\.json is not valid JSON/);
  assert.equal(await readIfExists(repo.file(".bench-quality.json")), null);
  assert.equal(await readIfExists(repo.file("commitlint.config.js")), null);
  assert.equal(await readIfExists(repo.file("lefthook.yml")), null);
});

test("a broken or empty lefthook.yml aborts the batch untouched", async (t) => {
  const broken = await makeRepo({ files: { "lefthook.yml": "pre-commit: [unclosed\n" } });
  t.after(broken.cleanup);
  const brokenResult = runCli(["init", "--features", "commitlint"], { cwd: broken.dir });
  assert.equal(brokenResult.status, 1);
  assert.match(brokenResult.stderr, /INVALID_YAML/);
  assert.equal(await readIfExists(broken.file(".bench-quality.json")), null);

  const empty = await makeRepo({ files: { "lefthook.yml": "\n" } });
  t.after(empty.cleanup);
  const emptyResult = runCli(["init", "--features", "commitlint"], { cwd: empty.dir });
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /EMPTY_EXISTING_LEFTHOOK_CONFIG/);
  assert.equal(await readIfExists(empty.file(".bench-quality.json")), null);
});

test("locally edited managed file is a conflict until --accept-drift", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--features", "commitlint,markdown"], { cwd: repo.dir }).status, 0);

  await writeFile(repo.file("commitlint.config.js"), "// locally customised\n");
  const blocked = runCli(["update"], { cwd: repo.dir });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /FILE_DRIFT/);
  assert.equal(await readFile(repo.file("commitlint.config.js"), "utf8"), "// locally customised\n");

  const adopted = runCli(["update", "--accept-drift"], { cwd: repo.dir });
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.match(await readFile(repo.file("commitlint.config.js"), "utf8"), /Vendored by bench-quality-cli/);
  const backupsRoot = join(repo.dir, ".git/bench-quality-cli/backups");
  const batches = await readdir(backupsRoot);
  const backedUp = await Promise.all(
    batches.map((batch) => readIfExists(join(backupsRoot, batch, "commitlint.config.js"))),
  );
  assert.ok(
    backedUp.includes("// locally customised\n"),
    `the pre-adoption bytes are backed up (batches: ${batches.join(", ")})`,
  );
});

test("update unions features and preserves consumer entries", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n", "lefthook.yml": LEFTHOOK_WITH_USER_ENTRY } });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--features", "commitlint"], { cwd: repo.dir }).status, 0);

  const result = runCli(["update", "--features", "markdown"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(repo.file(".bench-quality.json"), "utf8"));
  assert.deepEqual(manifest.features, ["commitlint", "markdown"]);

  const yaml = await readFile(repo.file("lefthook.yml"), "utf8");
  assert.match(yaml, /prettier:/, "consumer entry survives");
  assert.match(yaml, /glob: "\*\.ts"/, "consumer glob survives");
  assert.match(yaml, /commitlint:/);
  assert.match(yaml, /markdown-links:/);
});

test("remove drops only the removed feature", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n", "lefthook.yml": LEFTHOOK_WITH_USER_ENTRY } });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--features", "commitlint,markdown"], { cwd: repo.dir }).status, 0);

  const result = runCli(["remove", "--features", "markdown"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(repo.file(".bench-quality.json"), "utf8"));
  assert.deepEqual(manifest.features, ["commitlint"]);
  const yaml = await readFile(repo.file("lefthook.yml"), "utf8");
  assert.doesNotMatch(yaml, /markdown-links:/);
  assert.match(yaml, /commitlint:/);
  assert.match(yaml, /prettier:/);
  assert.equal(await readIfExists(repo.file(".markdown-link-check.json")), null, "retired file is removed");
  assert.ok(await readIfExists(repo.file("commitlint.config.js")), "kept feature keeps its artifacts");
  assert.equal(await readIfExists(repo.file(".markdown-link-check.json")), null);
});

test("remove preserves a retired file that was edited locally", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--features", "commitlint,markdown"], { cwd: repo.dir }).status, 0);
  await writeFile(repo.file(".markdown-link-check.json"), '{\n  "timeout": "30s"\n}\n');

  const result = runCli(["remove", "--features", "markdown"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /left in place \(delete it by hand if unused\)/);
  assert.equal(await readFile(repo.file(".markdown-link-check.json"), "utf8"), '{\n  "timeout": "30s"\n}\n');
});

test("remove of the last feature unwires the hooks path", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--features", "commitlint"], { cwd: repo.dir }).status, 0);
  const result = runCli(["remove", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git("config", "--get", "core.hooksPath").trim(), "");
  const manifest = JSON.parse(await readFile(repo.file(".bench-quality.json"), "utf8"));
  assert.deepEqual(manifest.features, []);
  assert.equal(await readIfExists(repo.file(".husky/pre-commit")), null, "orphan hooks are retired");
  assert.deepEqual(manifest.files["commitlint.config.js"], undefined);
});

test("a concurrent run is refused while the lock is alive", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => holder.kill());

  const stateDir = resolveStateDir({ gitCommonDir: join(repo.dir, ".git") });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "lock.json"),
    JSON.stringify({
      pid: holder.pid,
      host: (await import("node:os")).hostname(),
      startedAt: new Date().toISOString(),
      command: "init",
      target: repo.dir,
      batchId: "fixture",
    }),
  );

  const result = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REPO_LOCKED/);
  assert.equal(await readIfExists(repo.file(".bench-quality.json")), null);
});

test("a failing write is rolled back and leaves no journal", async (t) => {
  if (process.platform === "win32") {
    return t.skip("permission-based write failure needs POSIX directory modes; verified on macOS");
  }
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  await mkdir(repo.file(".husky"), { recursive: true });
  await chmod(repo.file(".husky"), 0o555);
  t.after(async () => {
    await chmod(repo.file(".husky"), 0o755).catch(() => {});
    await repo.cleanup();
  });
  const statusBefore = gitStatus(repo.dir);

  const result = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WRITE_FAILED/);
  assert.match(result.stderr, /rolled back/);

  const stateDir = resolveStateDir({ gitCommonDir: join(repo.dir, ".git") });
  assert.equal(await readJournal(stateDir), null, "journal is cleared after a successful rollback");
  assert.equal(await readIfExists(join(stateDir, "lock.json")), null, "lock is released");
  assert.equal(await readIfExists(repo.file("commitlint.config.js")), null, "nothing partial remains");
  assert.equal(await readIfExists(repo.file("lefthook.yml")), null);
  assert.equal(gitStatus(repo.dir), statusBefore, "the working tree is unchanged");
});

test("doctor reports drift, then recovers an interrupted batch", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n", ".gitkeep": "" } });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--features", "commitlint"], { cwd: repo.dir }).status, 0);

  const stateDir = resolveStateDir({ gitCommonDir: join(repo.dir, ".git") });
  const relPath = "commitlint.config.js";
  const before = await readFile(repo.file(relPath), "utf8");
  const after = "// interrupted batch output\n";
  const backupDir = backupDirFor(stateDir, "20260914T000000-crash");
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, relPath), before);
  await writeFile(repo.file(relPath), after);
  await writeJournal(stateDir, {
    batchId: "20260914T000000-crash",
    mode: "update",
    target: repo.dir,
    generator: { name: "bench-quality-cli", version: "0.0.0" },
    startedAt: new Date().toISOString(),
    state: "writing",
    files: [
      {
        relPath,
        kind: "template",
        existed: true,
        beforeHash: sha256(before),
        plannedHash: sha256(after),
        backupPath: join(backupDir, relPath),
        mode: 0o644,
      },
    ],
    hooksPath: { before: ".husky", after: ".husky" },
    features: ["commitlint"],
    profiles: [],
    lefthook: { managedEntries: [] },
    packageJson: { managed: {} },
  });

  const doctor = runCli(["doctor", "--json"], { cwd: repo.dir });
  const report = JSON.parse(doctor.stdout);
  assert.ok(report.findings.some((finding) => finding.code === "RECOVERY_REQUIRED"));
  assert.equal(doctor.status, 1, "an interrupted batch makes doctor exit non-zero");

  const recovered = runCli(["doctor", "--recover"], { cwd: repo.dir });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /recovered batch 20260914T000000-crash/);
  assert.equal(await readFile(repo.file(relPath), "utf8"), before);
  assert.equal(await readJournal(stateDir), null);
});

test("recovery refuses to overwrite work done after the interrupted batch", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const stateDir = resolveStateDir({ gitCommonDir: join(repo.dir, ".git") });
  const relPath = "commitlint.config.js";
  const before = "// generated\n";
  const after = "// batch output\n";
  await writeFile(repo.file(relPath), "// third party edit\n");
  const backupDir = backupDirFor(stateDir, "20260914T000001-crash");
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, relPath), before);
  await writeJournal(stateDir, {
    batchId: "20260914T000001-crash",
    mode: "update",
    target: repo.dir,
    generator: { name: "bench-quality-cli", version: "0.0.0" },
    startedAt: new Date().toISOString(),
    state: "writing",
    files: [
      {
        relPath,
        kind: "template",
        existed: true,
        beforeHash: sha256(before),
        plannedHash: sha256(after),
        backupPath: join(backupDir, relPath),
        mode: 0o644,
      },
    ],
    hooksPath: { before: ".husky", after: ".husky" },
    features: [],
    profiles: [],
    lefthook: { managedEntries: [] },
    packageJson: { managed: {} },
  });

  const result = runCli(["doctor", "--recover"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RECOVERY_CONFLICT/);
  assert.equal(await readFile(repo.file(relPath), "utf8"), "// third party edit\n");
  assert.notEqual(await readJournal(stateDir), null, "the journal is kept for manual review");
});

test("failures print the actionable hint", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n", "lefthook.yml": "\n" } });
  t.after(repo.cleanup);
  const result = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EMPTY_EXISTING_LEFTHOOK_CONFIG/);
  // Regression: `return <promise>` inside the command switch used to drop every
  // async rejection, so the hint never reached the user.
  assert.match(result.stderr, /hint: /);
});

test("arguments fail closed", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const unknownFlag = runCli(["init", "--nope"], { cwd: repo.dir });
  assert.equal(unknownFlag.status, 1);
  assert.match(unknownFlag.stderr, /UNKNOWN_FLAG/);

  const unknownFeature = runCli(["init", "--features", "nope"], { cwd: repo.dir });
  assert.equal(unknownFeature.status, 1);
  assert.match(unknownFeature.stderr, /UNKNOWN_FEATURE/);

  const missingValue = runCli(["init", "--target"], { cwd: repo.dir });
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /MISSING_FLAG_VALUE/);

  const subdir = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(subdir.cleanup);
  await mkdir(subdir.file("src"), { recursive: true });
  const wrongRoot = runCli(["init", "--features", "commitlint"], { cwd: subdir.file("src") });
  assert.equal(wrongRoot.status, 1);
  assert.match(wrongRoot.stderr, /INVALID_TARGET: .*is not the repository root/);
});

test("non-git targets are refused for write modes but reportable", async (t) => {
  const repo = await makeRepo({ git: false, files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const write = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(write.status, 1);
  assert.match(write.stderr, /GIT_REPO_REQUIRED/);
  const doctor = runCli(["doctor", "--json"], { cwd: repo.dir });
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /GIT_REPO_REQUIRED/);
});

test("bin exposes the version without a target", () => {
  const result = runCli(["--version"], { cwd: process.cwd() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  // 路径末段断言：Windows 上是 `...\bin\index.mjs`（C10）。
  assert.ok(toPosixPath(BIN).endsWith("bin/index.mjs"), `unexpected bin path: ${BIN}`);
});
