import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MIN_NODE,
  MIN_NODE_SPEC,
  NODE_UNSUPPORTED,
  TARGET_NODE,
  assertSupportedNode,
  compareNodeVersion,
  isSupportedNode,
  parseNodeVersion,
} from "../src/node-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), "utf8"));

test("parseNodeVersion accepts v-prefixed and bare versions", () => {
  assert.deepEqual(parseNodeVersion("v26.8.2"), { major: 26, minor: 8, patch: 2 });
  assert.deepEqual(parseNodeVersion("24.15.0"), { major: 24, minor: 15, patch: 0 });
  assert.equal(parseNodeVersion("not-a-version"), null);
  assert.equal(parseNodeVersion(undefined), null);
});

test("compareNodeVersion orders by major, minor, patch", () => {
  assert.ok(compareNodeVersion(parseNodeVersion("24.15.0"), MIN_NODE) === 0);
  assert.ok(compareNodeVersion(parseNodeVersion("24.14.9"), MIN_NODE) < 0);
  assert.ok(compareNodeVersion(parseNodeVersion("26.8.2"), MIN_NODE) > 0);
  assert.ok(compareNodeVersion(parseNodeVersion("23.99.99"), MIN_NODE) < 0);
});

test("isSupportedNode draws the boundary at the declared minimum", () => {
  assert.equal(isSupportedNode("24.15.0"), true);
  assert.equal(isSupportedNode("v24.15.1"), true);
  assert.equal(isSupportedNode("24.14.99"), false);
  assert.equal(isSupportedNode("22.23.1"), false);
  assert.equal(isSupportedNode("18.20.0"), false);
  assert.throws(() => isSupportedNode("garbage"), { code: NODE_UNSUPPORTED });
});

test("assertSupportedNode emits the stable diagnostic", () => {
  assert.deepEqual(assertSupportedNode(TARGET_NODE), { major: 26, minor: 8, patch: 2 });
  assert.throws(() => assertSupportedNode("v20.11.1"), (error) => {
    assert.equal(error.code, NODE_UNSUPPORTED);
    assert.equal(error.message, `${NODE_UNSUPPORTED}: require ${MIN_NODE_SPEC}; got v20.11.1`);
    assert.match(error.hint, /\.node-version/);
    return true;
  });
});

test("package.json engines and .node-version agree with the contract", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.engines?.node, MIN_NODE_SPEC, "engines.node must equal MIN_NODE_SPEC");
  const nodeVersionFile = (await readFile(join(ROOT, ".node-version"), "utf8")).trim();
  assert.equal(nodeVersionFile, TARGET_NODE, ".node-version must equal TARGET_NODE");
});

test("bin entry validates the runtime before importing dependencies", async () => {
  const source = await readFile(join(ROOT, "bin/index.mjs"), "utf8");
  const imports = [...source.matchAll(/^\s*import\s+(?:[^"']*from\s+)?["']([^"']+)["']/gm)].map(
    (m) => m[1],
  );
  assert.equal(imports.length, 1, `bin/index.mjs must have exactly one static import, got ${imports}`);
  assert.match(imports[0], /node-contract\.mjs$/);
  // The CLI (and therefore js-yaml) must only be pulled in dynamically, after
  // the runtime gate has run.
  const dynamicImport = source.indexOf('await import("../src/cli.mjs")');
  const gate = source.indexOf("assertSupportedNode(process.versions.node)");
  assert.ok(dynamicImport > -1, "bin must import the CLI dynamically");
  assert.ok(gate > -1 && gate < dynamicImport, "runtime gate must precede the dynamic CLI import");
});

test("bin entry runs on the current runtime", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "bin/index.mjs"), "list"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available features/);
});

test("bin entry refuses an unsupported runtime end to end", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", join(ROOT, "tests/fixtures/pretend-node-version.mjs"), join(ROOT, "bin/index.mjs"), "list"],
    {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, BENCH_TEST_PRETEND_NODE: "20.11.1" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NODE_VERSION_UNSUPPORTED: require >=24\.15\.0; got 20\.11\.1/);
  assert.equal(result.stdout, "", "nothing may run before the gate");
});
