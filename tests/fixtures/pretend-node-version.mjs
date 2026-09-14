// Test-only preload used to exercise the bin entry's runtime gate on a real
// process: `node --import ./tests/fixtures/pretend-node-version.mjs bin/index.mjs`.
// It rewrites `process.versions.node` before the CLI is imported, which is the
// only way to observe the NODE_VERSION_UNSUPPORTED path without installing an
// obsolete runtime. Not published (tests/ is outside package.json `files`).
const pretend = process.env.BENCH_TEST_PRETEND_NODE;
if (!pretend) {
  throw new Error("BENCH_TEST_PRETEND_NODE must be set when preloading this fixture");
}
Object.defineProperty(process.versions, "node", {
  value: pretend,
  writable: true,
  enumerable: true,
  configurable: true,
});
