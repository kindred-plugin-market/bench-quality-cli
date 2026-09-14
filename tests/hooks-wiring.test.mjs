// Wiring invariants for the generated lefthook.yml. These are the rules that
// would silently disable a gate if they regressed, so they are asserted
// mechanically instead of being left to review.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { makeRepo, runCli } from "./helpers/cli-fixture.mjs";
import { features } from "../src/features/index.mjs";
import { hookContent } from "../src/hooks.mjs";
import { TEMPLATES_DIR } from "../src/templates.mjs";
import yaml from "js-yaml";

test("no managed entry uses the scripts/only style or a bogus root", () => {
  const raw = features.map((feature) => JSON.stringify(feature.lefthook ?? {})).join("\n");
  assert.doesNotMatch(raw, /"scripts"\s*:/, "scripts+only never fires for nested paths (verified on 2.1.14)");
  assert.doesNotMatch(raw, /"root"\s*:/, "a bogus root changes cwd and filters files");
  assert.doesNotMatch(raw, /"[^"]*"\s*:\s*\{\s*"only"/, "no only-based run condition");
});

test("glob patterns avoid the shapes lefthook does not match", () => {
  const globs = features.flatMap((feature) =>
    Object.values(feature.lefthook ?? {}).flatMap((spec) =>
      (spec.commands ?? []).flatMap((command) => (command.glob ? [command.glob].flat() : [])),
    ),
  );
  assert.ok(globs.length > 0, "expected file-scoped commands");
  for (const glob of globs) {
    assert.doesNotMatch(glob, /\/\*\*\/\*?\./, `"${glob}" does not match files directly under the prefix (verified)`);
  }
});

test("every command that rewrites the worktree chains the partial-staging guard", () => {
  for (const feature of features) {
    for (const spec of Object.values(feature.lefthook ?? {})) {
      for (const command of spec.commands ?? []) {
        if (!command.stage_fixed) continue;
        if (!/fix-staged-whitespace|--fix/.test(command.run)) continue;
        assert.match(
          command.run,
          /guard-partial-staging\.mjs &&/,
          `${command.name} must not re-stage without proving the staging area is unambiguous`,
        );
      }
    }
  }
});

test("the deletion dispatcher is unconditional", async () => {
  const command = features
    .flatMap((feature) => Object.values(feature.lefthook ?? {}))
    .flatMap((spec) => spec.commands ?? [])
    .find((entry) => entry.name === "changed-paths");
  assert.ok(command, "changed-paths must be wired");
  assert.equal(command.glob, undefined);
  assert.doesNotMatch(command.run, /\{(?:staged_files|all_files|files)\}/, "it must run even for pure deletions");
});

test("every vendored hook reference resolves to a file the plan installs", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  const result = runCli(["init", "--features", "commitlint,markdown,bench-guards", "--yes"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);

  const doc = yaml.load(await readFile(repo.file("lefthook.yml"), "utf8"));
  const installed = await readdir(repo.file("scripts/quality"));
  for (const [hookName, hook] of Object.entries(doc)) {
    for (const command of Object.values(hook?.commands ?? {})) {
      for (const match of String(command.run).matchAll(/scripts\/quality\/([\w.-]+)/g)) {
        assert.ok(installed.includes(match[1]), `${hookName} references missing scripts/quality/${match[1]}`);
      }
    }
  }
  assert.ok(installed.includes("check-changed-paths.mjs"));
  assert.ok(installed.includes("guard-partial-staging.mjs"));
  assert.ok(installed.includes("git-changes.mjs"));
});

test("the partial-staging guard is installed for every feature set", async (t) => {
  for (const featureList of ["commitlint", "markdown"]) {
    const repo = await makeRepo({ files: { "package.json": "{}\n" } });
    t.after(repo.cleanup);
    const result = runCli(["init", "--features", featureList], { cwd: repo.dir });
    assert.equal(result.status, 0, result.stderr);
    const guard = await readFile(repo.file("scripts/quality/guard-partial-staging.mjs"), "utf8").catch(() => null);
    assert.ok(guard, `${featureList} must install the hook support files`);
    const body = await readFile(repo.file(".husky/pre-commit"), "utf8");
    assert.match(body, /guard-partial-staging\.mjs/);
  }
});

test("hook bodies carry the iron rule and stable diagnostics", () => {
  const body = hookContent({ hook: "pre-commit" });
  assert.match(body, /exec node node_modules\/lefthook\/bin\/index\.js run pre-commit/);
  assert.doesNotMatch(body, /node_modules\/\.bin\/lefthook/);
  assert.match(body, /NODE_NOT_FOUND/);
  assert.match(body, /LEFTHOOK_NOT_INSTALLED/);
  assert.match(body, /\.node-version/);
  // No personal absolute path may be baked into a generated hook.
  assert.doesNotMatch(body, /\/Users\/[a-z]/);

  // The partial-staging guard must run in the hook body, before lefthook:
  // lefthook stashes unstaged changes before running a pre-commit command, so a
  // command inside lefthook can never observe partial staging.
  const guardIndex = body.indexOf("guard-partial-staging.mjs");
  const execIndex = body.indexOf("exec node node_modules/lefthook/bin/index.js");
  assert.ok(guardIndex > -1, "the pre-commit body must run the partial-staging guard");
  assert.ok(guardIndex < execIndex, "the guard must run before lefthook can rewrite anything");

  const commitMsg = hookContent({ hook: "commit-msg", passArg: true });
  assert.match(commitMsg, /run commit-msg "\$1"/);
  assert.doesNotMatch(commitMsg, /guard-partial-staging/, "commit-msg does not rewrite the staging area");
});
