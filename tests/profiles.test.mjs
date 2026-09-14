// Profiles, author configuration and the consumer install entry (QG-03).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { makeRepo, runCli } from "./helpers/cli-fixture.mjs";
import { DEFAULT_PROFILE, findProfile, profiles } from "../src/profiles/index.mjs";
import { features } from "../src/features/index.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("profile table is internally consistent", () => {
  const ids = profiles.map((profile) => profile.id);
  assert.equal(new Set(ids).size, ids.length, "profile ids must be unique");
  assert.ok(ids.includes(DEFAULT_PROFILE));
  for (const profile of profiles) {
    for (const feature of profile.features) {
      assert.ok(features.some((entry) => entry.id === feature), `${profile.id} references unknown feature ${feature}`);
    }
    assert.equal(profile.workspaceKeys.allowBuilds.lefthook, false, `${profile.id} must keep lefthook's postinstall off`);
    assert.ok(profile.scripts["hooks:install"], `${profile.id} must ship an install entry`);
  }
  // Host-only guards are not pushed onto repositories without a host tree.
  for (const id of ["node-tool", "data-market", "plugin-market"]) {
    assert.ok(!findProfile(id).features.includes("bench-guards"), `${id} must not install host guards`);
  }
  assert.ok(findProfile("tauri-host").features.includes("bench-guards"));
});

test("each profile enables exactly its own features and scripts", async (t) => {
  const cases = [
    { profile: "node-tool", expectGuards: false, expectScript: "check:md-links" },
    { profile: "data-market", expectGuards: false, expectScript: null },
  ];
  for (const entry of cases) {
    const repo = await makeRepo({ files: { "package.json": "{}\n" } });
    t.after(repo.cleanup);
    const result = runCli(["init", "--profile", entry.profile], { cwd: repo.dir });
    assert.equal(result.status, 0, result.stderr);
    const manifest = await readJson(repo.file(".bench-quality.json"));
    assert.equal(manifest.profile, entry.profile);
    assert.deepEqual(manifest.features, findProfile(entry.profile).features);
    const guardsInstalled = await readFile(repo.file("scripts/quality/check-changed-paths.mjs"), "utf8").catch(() => null);
    assert.equal(Boolean(guardsInstalled), entry.expectGuards);
    const pkg = await readJson(repo.file("package.json"));
    assert.equal(Boolean(pkg.scripts["check:changed-paths"]), entry.expectGuards);
    if (entry.expectScript) assert.ok(pkg.scripts[entry.expectScript], `${entry.profile} should add ${entry.expectScript}`);
  }
});

test("an explicit profile fails closed when its required paths are missing", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const result = runCli(["init", "--profile", "tauri-host"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PROFILE_REQUIREMENTS_MISSING/);
  assert.match(result.stderr, /src-tauri/);
  assert.equal(await readFile(repo.file(".bench-quality.json"), "utf8").catch(() => null), null);
});

test("a matching profile is applied when its paths exist", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  await mkdir(repo.file("src-tauri"), { recursive: true });
  await writeFile(repo.file("src-tauri/placeholder.txt"), "x\n");
  const result = runCli(["init", "--profile", "tauri-host", "--dry-run", "--json"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.features.includes("bench-guards"), true);
});

test("unknown profiles are rejected with the available list", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const result = runCli(["init", "--profile", "nope"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNKNOWN_PROFILE/);
  assert.match(result.stderr, /node-tool/);
});

test("the author config file drives features and profile; flags win", async (t) => {
  const repo = await makeRepo({
    files: {
      "package.json": "{}\n",
      "bench-quality.config.json": '{ "profile": "data-market", "features": ["commitlint"] }\n',
    },
  });
  t.after(repo.cleanup);

  const fromConfig = runCli(["init"], { cwd: repo.dir });
  assert.equal(fromConfig.status, 0, fromConfig.stderr);
  let manifest = await readJson(repo.file(".bench-quality.json"));
  assert.equal(manifest.profile, "data-market");
  assert.deepEqual(manifest.features, ["commitlint"]);

  const overridden = runCli(["init", "--features", "commitlint,markdown"], { cwd: repo.dir });
  assert.equal(overridden.status, 0, overridden.stderr);
  manifest = await readJson(repo.file(".bench-quality.json"));
  assert.deepEqual(manifest.features, ["commitlint", "markdown"]);

  // The generator never rewrites the author's file.
  assert.equal(
    await readFile(repo.file("bench-quality.config.json"), "utf8"),
    '{ "profile": "data-market", "features": ["commitlint"] }\n',
  );
});

test("excludeFeatures subtracts explicitly", async (t) => {
  const repo = await makeRepo({
    files: {
      "package.json": "{}\n",
      "bench-quality.config.json": '{ "profile": "tauri-host", "excludeFeatures": ["bench-guards"] }\n',
    },
  });
  t.after(repo.cleanup);
  await mkdir(repo.file("src-tauri"), { recursive: true });
  const result = runCli(["init"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readJson(repo.file(".bench-quality.json"));
  assert.deepEqual(manifest.features, ["commitlint", "markdown"]);
});

test("an invalid author config stops the run untouched", async (t) => {
  const repo = await makeRepo({
    files: { "package.json": "{}\n", "bench-quality.config.json": '{ "profile": "node-tool", "extra": true }\n' },
  });
  t.after(repo.cleanup);
  const result = runCli(["init"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_CONFIG/);
  assert.equal(await readFile(repo.file(".bench-quality.json"), "utf8").catch(() => null), null);
});

test("existing scripts and lifecycle hooks are preserved", async (t) => {
  const repo = await makeRepo({
    files: {
      "package.json": '{\n  "name": "consumer",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "prepare": "node scripts/bootstrap/install-hooks.mjs",\n    "test": "vitest run"\n  }\n}\n',
    },
  });
  t.after(repo.cleanup);
  const result = runCli(["init", "--profile", "node-tool"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  const pkg = await readJson(repo.file("package.json"));
  assert.equal(pkg.scripts.prepare, "node scripts/bootstrap/install-hooks.mjs", "an existing lifecycle script is never replaced");
  assert.equal(pkg.scripts.test, "vitest run", "an existing project script is never replaced");
  assert.equal(pkg.scripts["hooks:install"], "node scripts/quality/install-hooks.mjs");
  const manifest = await readJson(repo.file(".bench-quality.json"));
  assert.equal(manifest.packageJson.managed.scripts.prepare, undefined, "we did not write prepare, so we do not own it");
});

test("an existing workspace key is preserved and reported", async (t) => {
  const repo = await makeRepo({
    files: { "package.json": "{}\n", "pnpm-workspace.yaml": "packages:\n  - packages/*\nallowBuilds:\n  lefthook: true\n" },
  });
  t.after(repo.cleanup);
  const result = runCli(["init", "--profile", "node-tool"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept existing pnpm-workspace\.yaml key "allowBuilds"/);
  const workspace = await readFile(repo.file("pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /lefthook: true/, "a human's value is never overwritten");
  assert.match(workspace, /packages:/, "unrelated keys survive");
});

test("the installer wires hooks, is idempotent and reports a fresh clone", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--profile", "node-tool"], { cwd: repo.dir }).status, 0);
  const installer = repo.file("scripts/quality/install-hooks.mjs");

  // Simulate a fresh clone: hooks exist in the tree, git config does not know them.
  execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: repo.dir });
  const unset = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: repo.dir, encoding: "utf8" });
  assert.notEqual(unset.status, 0, "core.hooksPath must be unset for this scenario");

  const wired = execFileSync(process.execPath, [installer], { cwd: repo.dir, encoding: "utf8" });
  assert.match(wired, /Quality hooks wired: core\.hooksPath=\.husky/);

  const again = execFileSync(process.execPath, [installer], { cwd: repo.dir, encoding: "utf8" });
  assert.match(again, /already wired/);

  const verified = execFileSync(process.execPath, [installer, "--check"], { cwd: repo.dir, encoding: "utf8" });
  assert.match(verified, /already wired/);
});

test("the installer refuses to claim success without generated hooks", async (t) => {
  const source = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(source.cleanup);
  assert.equal(runCli(["init", "--profile", "node-tool"], { cwd: source.dir }).status, 0);

  // Same installer, a repository where the generated hooks were never committed.
  const bare = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(bare.cleanup);
  await mkdir(bare.file("scripts/quality"), { recursive: true });
  await writeFile(
    bare.file("scripts/quality/install-hooks.mjs"),
    await readFile(source.file("scripts/quality/install-hooks.mjs"), "utf8"),
  );
  const result = spawnSync(process.execPath, [bare.file("scripts/quality/install-hooks.mjs")], {
    cwd: bare.dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HOOK_MISSING/);
});

test("remove drops managed scripts and workspace keys but keeps the repository's own", async (t) => {
  const repo = await makeRepo({
    files: { "package.json": '{\n  "name": "consumer",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n' },
  });
  t.after(repo.cleanup);
  assert.equal(runCli(["init", "--profile", "node-tool"], { cwd: repo.dir }).status, 0);
  const removed = runCli(["remove", "--features", "commitlint,markdown"], { cwd: repo.dir });
  assert.equal(removed.status, 0, removed.stderr);
  const pkg = await readJson(repo.file("package.json"));
  assert.equal(pkg.scripts.test, "vitest run");
  assert.equal(pkg.scripts["hooks:install"], undefined, "our entry point is retired with the features");
  assert.equal(pkg.devDependencies?.lefthook, undefined, "our devDependency is dropped again");
  const workspace = await readFile(repo.file("pnpm-workspace.yaml"), "utf8");
  assert.doesNotMatch(workspace, /allowBuilds/, "our workspace key is retired with the features");
});
