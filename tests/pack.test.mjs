// Package-surface tests (C09 / QG-04): what a consumer actually receives.
//
// Two failure modes matter here and neither is visible from the source tree:
// a file that is imported at runtime but not shipped (the CLI would break for a
// consumer while every test passes locally), and a runtime path that reaches the
// network (the generator is supposed to work from cache).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

async function listSourceFiles(dir, prefix = "src") {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listSourceFiles(`${dir}/${entry.name}`, rel)));
    else if (entry.name.endsWith(".mjs")) files.push(rel);
  }
  return files;
}

test("packing ships every runtime file and no test file", async (t) => {
  // --ignore-scripts: `npm pack` would otherwise run `prepare` (our hook
  // installer) and its stdout would pollute the JSON report.
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  if (pack.status !== 0) return t.skip(`npm pack is unavailable: ${(pack.stderr ?? "").slice(0, 120)}`);

  const [manifest] = JSON.parse(pack.stdout);
  const shipped = manifest.files.map((file) => file.path).sort();
  assert.ok(shipped.includes("bin/index.mjs"));
  assert.ok(shipped.includes("package.json"));
  assert.ok(shipped.some((path) => path === "src/cli.mjs"));
  assert.ok(shipped.some((path) => path.startsWith("templates/guards/")));
  assert.ok(!shipped.some((path) => path.startsWith("tests/")), "tests must not be published");
  assert.ok(!shipped.some((path) => path.startsWith(".husky/")), "generated local hooks must not be published");

  // Everything imported at runtime must be in the tarball.
  const sources = [...(await listSourceFiles("src")), "bin/index.mjs"];
  const shippedSet = new Set(shipped);
  for (const file of sources) {
    const raw = await readFile(join(ROOT, file), "utf8");
    for (const match of raw.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const resolved = new URL(match[1], `file://${join(ROOT, file)}`).pathname.replace(`${ROOT}/`, "");
      assert.ok(shippedSet.has(resolved), `${file} imports ${resolved}, which is not shipped`);
    }
  }
});

test("the runtime makes no network call", async () => {
  const sources = [...(await listSourceFiles("src")), "bin/index.mjs"];
  for (const file of sources) {
    const raw = await readFile(join(ROOT, file), "utf8");
    for (const pattern of [/from\s+"node:https?"/, /\bfetch\(/, /require\("node:https?"\)/]) {
      assert.doesNotMatch(raw, pattern, `${file} looks like it performs network I/O`);
    }
  }
});

test("the package declares an exact runtime contract and no install scripts", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=24.15.0");
  assert.equal(pkg.bin["bench-quality"], "bin/index.mjs");
  assert.ok(pkg.files.includes("templates"), "templates are the vendored payload");
  assert.equal(pkg.scripts.preinstall, undefined);
  assert.equal(pkg.scripts.postinstall, undefined, "the published package must not run install scripts");
  // The package is not published by this repository's automation; publishing is
  // a separate, human decision (no release workflow exists here).
  assert.equal(pkg.private, undefined);
});
