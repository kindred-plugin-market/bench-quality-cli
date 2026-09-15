// Package-manager baseline of the generator itself (DEP-02, C06).
//
// The interesting failures here are silent ones: a lockfile that drifts from
// the manifest, or a `packageManager` pin that no longer matches the version
// the lock was produced with. Both are asserted rather than trusted.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAll as loadAllYaml } from "js-yaml";

import { normalizeEol } from "./helpers/text.mjs";

const ROOT = join(import.meta.dirname, "..");
const readJson = async (name) => JSON.parse(await readFile(join(ROOT, name), "utf8"));

test("package.json pins the package manager and the runtime contract", async () => {
  const pkg = await readJson("package.json");
  assert.match(pkg.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+$/, "packageManager must pin an exact pnpm version");
  assert.equal(pkg.packageManager, "pnpm@12.4.1");
  assert.equal(pkg.engines.node, ">=24.15.0");
});

test("pnpm-workspace.yaml keeps lefthook's postinstall denied", async () => {
  // Windows checkout 是 CRLF；断言的是配置项而不是换行字节（C10）。
  const workspace = normalizeEol(await readFile(join(ROOT, "pnpm-workspace.yaml"), "utf8"));
  assert.match(workspace, /allowBuilds:\n  lefthook: false/);
});

test("the lockfile matches the manifest specifiers", async () => {
  const pkg = await readJson("package.json");
  const rawLock = normalizeEol(await readFile(join(ROOT, "pnpm-lock.yaml"), "utf8"));
  assert.match(rawLock, /^lockfileVersion: '9\.0'$/m, "pnpm 12 keeps lockfileVersion 9 — no lock migration needed");

  // pnpm 12 writes the lockfile as two YAML documents (package-manager metadata
  // first, then settings/importers/packages); the importer with the real
  // dependencies is the one that declares them.
  const importers = loadAllYaml(rawLock)
    .filter((doc) => doc?.importers?.["."])
    .map((doc) => doc.importers["."]);
  const importer = importers.find((entry) => entry.dependencies || entry.devDependencies);
  assert.ok(importer, "the lockfile must contain an importer with dependencies");

  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      const entry = importer[section]?.[name];
      assert.ok(entry, `${name}@${range} must be in the lock importer`);
      assert.equal(entry.specifier, range, `${name} specifier must match package.json`);
    }
  }
  const packageManagerEntry = importers.map((entry) => entry.packageManagerDependencies?.pnpm?.specifier).find(Boolean);
  assert.equal(packageManagerEntry, pkg.packageManager.replace("pnpm@", ""));
});

test("frozen install is reproducible with the pinned pnpm", async (t) => {
  const pnpm = spawnSync("pnpm", ["--version"], { cwd: ROOT, encoding: "utf8" });
  if (pnpm.status !== 0) return t.skip("pnpm is not on PATH in this environment");

  const before = await readFile(join(ROOT, "pnpm-lock.yaml"), "utf8");
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const after = await readFile(join(ROOT, "pnpm-lock.yaml"), "utf8");
  assert.equal(after, before, "a frozen install must not rewrite the lockfile");
  assert.match(install.stdout + install.stderr, /Lockfile is up to date|Already up to date|Done in/);
});

test("pnpm exec resolves binaries and the bin entry runs from the workspace", async (t) => {
  const pnpm = spawnSync("pnpm", ["--version"], { cwd: ROOT, encoding: "utf8" });
  if (pnpm.status !== 0) return t.skip("pnpm is not on PATH in this environment");
  const exec = spawnSync("pnpm", ["exec", "node", "bin/index.mjs", "list"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(exec.status, 0, exec.stderr);
  assert.match(exec.stdout, /Available features/);
});
