// End-to-end hook tests: a real git repository, real `git commit`, real
// lefthook 2.1.14 executing the generated lefthook.yml and the vendored guards.
//
// The fixture installs its devDependencies through pnpm; when that is not
// possible (offline, no package manager) the suite skips with an explicit
// reason instead of pretending to pass.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeRepo, runCli } from "./helpers/cli-fixture.mjs";

let repo;
let skipReason = null;

function git(args, { cwd = repo.dir } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function commit(message) {
  return git(["commit", "-m", message]);
}

/** Both streams: git forwards hook stdout and stderr, and gates use both. */
function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

/** Assert that the hook blocked the commit and said why. */
function expectBlocked(result, needle) {
  assert.notEqual(result.status, 0, `expected the hook to block the commit, but it passed:\n${output(result)}`);
  assert.match(output(result), needle, `expected the hook output to mention ${needle}:\n${output(result)}`);
}

/** Assert that the hook let the commit through and reported why. */
function expectAllowed(result, needle) {
  assert.equal(result.status, 0, `expected the hook to allow the commit:\n${output(result)}`);
  if (needle) assert.match(output(result), needle);
}

/** Each test starts from the last commit with an otherwise untouched worktree. */
function resetWorktree() {
  git(["reset", "-q"]);
  git(["checkout", "-q", "--", "."]);
  git(["clean", "-qfd"]);
}

/**
 * Remove the feature/docs skeleton a test committed: the docs gate is a
 * whole-repo scanner, so leaving an orphaned docs module behind would make
 * every later test fail for an unrelated reason (order dependence by accident).
 * Fixture-only convenience, committed with --no-verify on purpose.
 */
async function removeSkeleton() {
  await rm(repo.file("src/features"), { recursive: true, force: true });
  await rm(repo.file("docs/modules"), { recursive: true, force: true });
  git(["add", "-A"]);
  git(["commit", "--no-verify", "-q", "-m", "chore: drop fixture skeleton"]);
}

function write(relative, content) {
  return writeFile(repo.file(relative), content);
}

before(async () => {
  repo = await makeRepo({
    name: "hooks",
    files: {
      "package.json": '{\n  "name": "hooks-fixture",\n  "version": "0.0.0",\n  "private": true\n}\n',
      // Every real checkout ignores its dependency tree; the first commit must
      // not drag node_modules into the gates.
      ".gitignore": "node_modules/\n",
    },
  });
  const init = runCli(["init", "--features", "bench-guards,markdown", "--target", repo.dir], { cwd: process.cwd() });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);

  // pnpm 12 fails the install when a dependency build script is ignored
  // (ERR_PNPM_IGNORED_BUILDS) — lefthook ships a postinstall that would install
  // its own hooks over .husky, so it is explicitly denied (same policy the
  // tauri-app consumer uses; the generated profiles ship this file).
  await writeFile(
    repo.file("pnpm-workspace.yaml"),
    "# Managed by bench-quality-cli (init/update). Keep lefthook's postinstall disabled:\n" +
      "# the .husky hooks are the ones that must run.\nallowBuilds:\n  lefthook: false\n",
  );

  const install = spawnSync("pnpm", ["install", "--silent"], { cwd: repo.dir, encoding: "utf8" });
  if (install.status !== 0) {
    skipReason = `pnpm install failed in the fixture: ${(install.stderr || install.stdout || "").trim().slice(0, 200)}`;
    return;
  }
  const first = (await commitSetup()) ?? null;
  if (first) skipReason = first;
});

// Commit the generated artifacts once; this doubles as the positive control
// that a hook run with nothing to check succeeds.
async function commitSetup() {
  const added = git(["add", "-A"]);
  if (added.status !== 0) return `git add failed: ${added.stderr}`;
  const result = commit("chore: install generated quality gates");
  if (result.status !== 0) return `initial commit failed: ${result.stderr.slice(0, 400)}`;
  return null;
}

beforeEach(() => {
  if (!skipReason) resetWorktree();
});

after(async () => {
  await repo?.cleanup();
});

test("positive control: the generated hook runs and the setup commit lands", (t) => {
  if (skipReason) return t.skip(skipReason);
  const log = git(["log", "-1", "--format=%s"]);
  assert.equal(log.stdout.trim(), "chore: install generated quality gates");
  const body = spawnSync("cat", [repo.file(".husky/pre-commit")], { encoding: "utf8" });
  assert.match(body.stdout, /exec node node_modules\/lefthook\/bin\/index\.js run pre-commit/);
});

test("hook refuses to run when lefthook is not installed", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const probe = await makeRepo({ name: "hook-body", files: { "package.json": "{}\n" } });
  t.after(probe.cleanup);
  await mkdir(probe.file(".husky"), { recursive: true });
  const body = await readFile(repo.file(".husky/pre-commit"), "utf8");
  await writeFile(probe.file(".husky/pre-commit"), body, { mode: 0o755 });
  const run = spawnSync("sh", [probe.file(".husky/pre-commit")], { cwd: probe.dir, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /LEFTHOOK_NOT_INSTALLED/);
});

test("whitespace in a staged file is fixed and re-staged by the hook", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await write("notes.txt", "clean line\ntrailing spaces   \n\n\n");
  git(["add", "notes.txt"]);
  const result = commit("chore: add notes");
  assert.equal(result.status, 0, result.stderr);
  const committed = git(["show", "HEAD:notes.txt"]).stdout;
  assert.equal(committed, "clean line\ntrailing spaces\n");
});

test("a partially staged file blocks the commit without being rewritten", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  await write("partial.txt", "clean line\n");
  assert.equal(git(["add", "partial.txt"]).status, 0);
  await write("partial.txt", "clean line\ndirty line   \n");

  const result = commit("chore: partial staging must fail");
  expectBlocked(result, /PARTIALLY_STAGED_FILE/);
  assert.match(await readFile(repo.file("partial.txt"), "utf8"), /dirty line   /, "no fix may touch the file");
  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), head, "no commit was created");
});

test("docs/code consistency is enforced for a new feature", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await mkdir(repo.file("src/features/foo"), { recursive: true });
  await write("src/features/foo/index.ts", "export const foo = 1;\n");
  git(["add", "src/features/foo/index.ts"]);
  expectBlocked(commit("feat: add foo feature"), /doc\/code consistency guard failed/);

  // The same gate flips to green once the documentation pair exists; it is
  // asserted directly so an unrelated gate in this bare fixture cannot mask it.
  await mkdir(repo.file("docs/modules/foo"), { recursive: true });
  await write("docs/modules/foo/README.md", "# foo\n");
  await write("docs/modules/foo/roadmap.md", "# roadmap\n");
  const gate = spawnSync(process.execPath, [repo.file("scripts/quality/check-docs-consistency.mjs")], {
    cwd: repo.dir,
    encoding: "utf8",
  });
  assert.equal(gate.status, 0, gate.stderr);

  // A docs-only change is green end to end (it does not trigger the i18n gate).
  git(["reset", "-q"]); // drop the staged feature file the blocked commit left behind
  git(["add", "docs/modules/foo"]);
  expectAllowed(commit("docs: add foo module docs"), null);
  await removeSkeleton();
});

test("a deletion re-runs the gate for its scope even without modified files", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await mkdir(repo.file("notes"), { recursive: true });
  await write("notes/readme.md", "# notes\n\nself contained\n");
  git(["add", "notes/readme.md"]);
  expectAllowed(commit("docs: add notes"), null);

  assert.equal(git(["rm", "-q", "notes/readme.md"]).status, 0);
  const result = commit("docs: drop notes");
  expectAllowed(result, /Deletion\/rename in scope "markdown"/);
  expectAllowed(result, /✔ markdown → check-markdown-links\.mjs passed/);
});

test("a pure deletion that breaks a guarded scope is blocked", async (t) => {
  if (skipReason) return t.skip(skipReason);
  // Setup only: --no-verify, because this fixture deliberately has no app
  // skeleton — the behaviour under test is the deletion commit below.
  await mkdir(repo.file("src/features/foo"), { recursive: true });
  await write("src/features/foo/index.ts", "export const foo = 1;\n");
  await mkdir(repo.file("docs/modules/foo"), { recursive: true });
  await write("docs/modules/foo/README.md", "# foo\n");
  await write("docs/modules/foo/roadmap.md", "# roadmap\n");
  git(["add", "-A"]);
  assert.equal(git(["commit", "--no-verify", "-q", "-m", "chore: fixture app skeleton"]).status, 0);

  assert.equal(git(["rm", "-q", "src/features/foo/index.ts"]).status, 0);
  const blocked = commit("refactor: remove foo feature");
  expectBlocked(blocked, /Deletion\/rename in scope "docs"/);
  assert.match(output(blocked), /src\/features\/foo\/index\.ts/, "the removed path is reported");
  expectBlocked(blocked, /doc\/code consistency guard failed/);
  await removeSkeleton();
});

test("a dead relative link in a staged markdown file blocks the commit", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await write("README.md", "# fixture\n\n[missing](./definitely-missing.md)\n");
  git(["add", "README.md"]);
  expectBlocked(commit("docs: add readme with dead link"), /Markdown link check failed/);

  await write("README.md", "# fixture\n\nself contained\n");
  git(["add", "README.md"]);
  expectAllowed(commit("docs: add readme"), null);
});

test("hook failures carry an actionable reason, not a bare shell error", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await mkdir(repo.file("src/features/bar"), { recursive: true });
  await write("src/features/bar/index.ts", "export const bar = 1;\n");
  git(["add", "src/features/bar/index.ts"]);
  expectBlocked(commit("feat: add bar without docs"), /feature 缺文档/);
});
