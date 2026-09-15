// Static invariants for .github/workflows/quality.yml (QG-08 / DEP-10).
//
// A workflow is configuration that CI cannot test before it runs, so the rules
// that matter are asserted here: everything pinned, least privilege, bounded
// runtime, no write path, and no silent divergence from package.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = join(ROOT, ".github/workflows/quality.yml");

async function readWorkflow() {
  const raw = await readFile(WORKFLOW, "utf8");
  return { raw, doc: loadYaml(raw) };
}

test("every action is pinned to a full commit SHA with a version comment", async () => {
  const { raw } = await readWorkflow();
  const uses = [...raw.matchAll(/^\s*-?\s*uses:\s*(\S+)\s*(#\s*(.*))?$/gm)];
  assert.ok(uses.length >= 3, "expected the workflow to use actions");
  for (const [, reference, , comment] of uses) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must be pinned to a 40-character commit SHA`);
    assert.ok(comment && /^v\d+\.\d+\.\d+$/.test(comment.trim()), `${reference} must carry a "vX.Y.Z" comment`);
    assert.doesNotMatch(reference, /@(main|master|v\d+)$/, "floating refs are not allowed");
  }
});

test("the workflow is read-only, bounded and concurrency limited", async () => {
  const { doc } = await readWorkflow();
  assert.deepEqual(doc.permissions, { contents: "read" }, "least privilege: contents:read only");
  assert.ok(doc.concurrency?.group, "concurrency group is required");
  assert.equal(doc.concurrency["cancel-in-progress"], true);
  for (const [name, job] of Object.entries(doc.jobs)) {
    assert.ok(job["timeout-minutes"] > 0, `job ${name} must set timeout-minutes`);
    assert.ok(job["runs-on"], `job ${name} must set runs-on`);
  }
});

test("no job publishes, uploads artifacts or writes to the repository", async () => {
  const { raw } = await readWorkflow();
  assert.doesNotMatch(raw, /npm publish|pnpm publish|gh release|softprops\/action-gh-release/);
  assert.doesNotMatch(raw, /upload-artifact|actions\/cache@/);
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("uses:")) continue;
    assert.doesNotMatch(trimmed, /release|deploy|publish/i, `${trimmed} looks like a write path`);
  }
  assert.doesNotMatch(raw, /permissions:\s*write/, "no job may request write permissions");
  assert.doesNotMatch(raw, /git push|git commit|\bsecrets\./, "the workflow must not write or need secrets");
});

test("the main job uses the pinned development runtime", async () => {
  const { doc } = await readWorkflow();
  const quality = doc.jobs.quality;
  const setup = quality.steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"));
  assert.ok(setup, "quality job must configure node");
  assert.equal(setup.with["node-version-file"], ".node-version", "the main job follows .node-version");

  const nodeVersion = (await readFile(join(ROOT, ".node-version"), "utf8")).trim();
  const compat = doc.jobs.compatibility.steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"));
  assert.notEqual(compat.with["node-version"], nodeVersion, "the compat job must differ from the main runtime");
  assert.equal(compat.with["node-version"], "24.15.0", "the compat job runs the promised minimum runtime");
});

test("the pnpm version in the workflow matches package.json", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const pinned = pkg.packageManager.replace("pnpm@", "");
  const { doc } = await readWorkflow();
  assert.equal(doc.env.PNPM_VERSION, pinned);
  for (const [name, job] of Object.entries(doc.jobs)) {
    const install = job.steps.find((step) => (step.run ?? "").includes("npm install -g pnpm@"));
    assert.ok(install, `job ${name} must install pnpm via npm (pnpm/action-setup 的 Windows 自安装器会切坏 shim)`);
    assert.match(install.run, new RegExp(`pnpm@${pinned}`), `job ${name} must install the pinned pnpm version`);
  }
  const { raw } = await readWorkflow();
  const uses = [...raw.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(!uses.some((u) => u.startsWith("pnpm/action-setup")), "the action must not come back (Windows shim breakage)");
});

test("macOS runs the full suite and Windows the portable subset", async () => {
  const { doc } = await readWorkflow();
  assert.match(doc.jobs.quality["runs-on"], /^macos-/);
  assert.match(doc.jobs.compatibility["runs-on"], /^macos-/);
  assert.match(doc.jobs.windows["runs-on"], /^windows-/);

  const qualityRuns = doc.jobs.quality.steps.map((step) => step.run ?? "").join("\n");
  assert.match(qualityRuns, /pnpm test/, "macOS runs the whole suite");
  assert.match(qualityRuns, /check:md-links/, "macOS runs the markdown gate");

  const windowsRuns = doc.jobs.windows.steps.map((step) => step.run ?? "").join("\n");
  assert.match(windowsRuns, /node --test/);
  assert.doesNotMatch(windowsRuns, /hooks\.test\.mjs/, "the POSIX hook suite stays off Windows (documented)");
  assert.match(windowsRuns, /transaction\.test\.mjs/);
});
